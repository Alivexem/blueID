#!/usr/bin/env bash
#
# Prepares a fresh Ubuntu 22.04/24.04 VPS to run the Blue ID register.
#
#   scp -r deploy/ root@<server>:/opt/blueid-deploy
#   ssh root@<server> 'bash /opt/blueid-deploy/provision.sh'
#
# Idempotent: safe to re-run. It does NOT start the application — it prepares
# the machine, then prints what you must do by hand, because the remaining
# steps involve secrets and a domain name that should not be guessed by a
# script.
#
# What it does:
#   - creates an unprivileged service user and the data directories
#   - installs Docker, nginx, certbot, restic
#   - locks the firewall to SSH and HTTPS
#   - installs an nginx site that terminates TLS and serves photographs
#     directly from disk via X-Accel-Redirect
#   - installs a nightly off-box backup timer
#
# It deliberately does NOT open the Postgres port. The database is reachable
# only from the api container and from this host over SSH.

set -euo pipefail

SERVICE_USER="blueid"
APP_DIR="/opt/blueid"
DATA_DIR="/var/lib/blueid"
MEDIA_DIR="${DATA_DIR}/media"
BACKUP_DIR="/var/backups/blueid"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
log "Base packages"
# ---------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg lsb-release \
  nginx certbot python3-certbot-nginx \
  restic ufw fail2ban unattended-upgrades \
  postgresql-client

# ---------------------------------------------------------------------------
log "Docker"
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

# ---------------------------------------------------------------------------
log "Service user and data directories"
# ---------------------------------------------------------------------------
# The uid must match the `node` user inside the container (1000), or the
# bind-mounted media directory is unwritable from inside it.
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin --uid 1000 "$SERVICE_USER" \
    || useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
usermod -aG docker "$SERVICE_USER"

# Outside APP_DIR on purpose: a redeploy must never be able to delete the
# photographs or the database.
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR" "$MEDIA_DIR" "$BACKUP_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$APP_DIR"

# ---------------------------------------------------------------------------
log "Firewall"
# ---------------------------------------------------------------------------
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp  >/dev/null   # certbot's HTTP-01 challenge and the redirect
ufw allow 443/tcp >/dev/null
# 5432 is deliberately absent. Reach the database with:
#   ssh -L 5432:127.0.0.1:5432 <server>
ufw --force enable >/dev/null
ufw status numbered | sed 's/^/    /'

systemctl enable --now fail2ban

# ---------------------------------------------------------------------------
log "nginx site"
# ---------------------------------------------------------------------------
read -rp "    Domain for this server (e.g. blueid.crossriverstate.gov.ng): " DOMAIN
DOMAIN="${DOMAIN:-_}"

cat > /etc/nginx/sites-available/blueid <<NGINX
# Blue ID — TLS termination and static media delivery.

upstream blueid_api {
    server 127.0.0.1:4000;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    # certbot rewrites this block to redirect once a certificate exists.
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    # certbot fills these in.
    # ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # A day of field photographs arrives in one sync.
    client_max_body_size 12m;

    # Photographs. INTERNAL: nginx will not serve this to a client directly.
    # The app authorises the request, checks the signed URL, then returns an
    # X-Accel-Redirect pointing here — so the bytes are sent by nginx and
    # never pass through the Node event loop.
    location /protected-media/ {
        internal;
        alias ${MEDIA_DIR}/;
        add_header Cache-Control "private, max-age=300" always;
        add_header X-Content-Type-Options "nosniff" always;
    }

    location / {
        proxy_pass         http://blueid_api;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Connection        "";
        # Long enough for a streamed Excel export of the whole register.
        proxy_read_timeout 300s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/blueid /etc/nginx/sites-enabled/blueid
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ---------------------------------------------------------------------------
log "Off-box backup timer"
# ---------------------------------------------------------------------------
# The compose stack writes a nightly pg_dump into BACKUP_DIR. That is only
# half a backup — this ships it, and the photographs, somewhere else. Without
# this, one failed disk loses a register that cannot be re-collected.
cat > /usr/local/bin/blueid-backup <<'BACKUP'
#!/usr/bin/env bash
set -euo pipefail
# Expects RESTIC_REPOSITORY and RESTIC_PASSWORD in /etc/blueid/backup.env.
# Point the repository at storage in Nigeria: NITDA's guidance puts the
# disaster-recovery copy under the same residency rule as the primary.
source /etc/blueid/backup.env
restic backup /var/backups/blueid /var/lib/blueid/media \
  --tag blueid --exclude-caches
restic forget --tag blueid \
  --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
restic check --read-data-subset=5%
BACKUP
chmod 0750 /usr/local/bin/blueid-backup

install -d -m 0700 /etc/blueid
if [[ ! -f /etc/blueid/backup.env ]]; then
  cat > /etc/blueid/backup.env <<'ENVFILE'
# Fill these in, then: systemctl enable --now blueid-backup.timer
# export RESTIC_REPOSITORY="s3:https://<in-country-endpoint>/blueid-backup"
# export RESTIC_PASSWORD="..."
# export AWS_ACCESS_KEY_ID="..."
# export AWS_SECRET_ACCESS_KEY="..."
ENVFILE
  chmod 0600 /etc/blueid/backup.env
fi

cat > /etc/systemd/system/blueid-backup.service <<'UNIT'
[Unit]
Description=Blue ID off-box backup
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/blueid-backup
UNIT

cat > /etc/systemd/system/blueid-backup.timer <<'UNIT'
[Unit]
Description=Nightly Blue ID off-box backup

[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=900
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload

# ---------------------------------------------------------------------------
log "Automatic security updates"
# ---------------------------------------------------------------------------
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
log "Prepared. Remaining steps are manual, because they involve secrets."
# ---------------------------------------------------------------------------
cat <<NEXT

    1. Put the application on the server
         rsync -a --exclude node_modules ./ ${SERVICE_USER}@<server>:${APP_DIR}/

    2. Create the environment file and fill in every GENERATE value
         cp ${APP_DIR}/deploy/.env.production.example ${APP_DIR}/deploy/.env
         chmod 600 ${APP_DIR}/deploy/.env
         # for each secret: openssl rand -base64 48

    3. Start the stack (migrations run first, then the API)
         cd ${APP_DIR} && docker compose -f deploy/docker-compose.yml up -d

    4. Create the first administrator — the password prints once
         docker compose -f deploy/docker-compose.yml exec api \\
           node src/scripts/createAdmin.js --role=SUPER_ADMIN \\
           --email=<address> --first=<name> --last=<name>

    5. Issue the TLS certificate
         certbot --nginx -d ${DOMAIN}

    6. Configure and enable the off-box backup — DO NOT SKIP
         edit /etc/blueid/backup.env
         systemctl enable --now blueid-backup.timer
         systemctl start blueid-backup.service   # prove it works now
         restic -r <repo> snapshots              # confirm a snapshot exists

    7. Book a restore drill for next month. An untested backup is not a
       backup, and the photographs cannot be re-collected.

NEXT

warn "Postgres is NOT exposed to the network. To reach it:"
echo "      ssh -L 5432:127.0.0.1:5432 <server>  # then connect to localhost:5432"

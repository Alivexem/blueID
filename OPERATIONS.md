# Operations

Written for: whoever runs this service in production — deployment, backups,
incident response.

This covers what the **infrastructure** must provide. Controls enforced by the
code are described in [README.md](README.md); this document is about the parts
the codebase cannot enforce on its own.

---

## What the database holds

The register contains personal data about real people: names, phone numbers,
next-of-kin contacts, optional National Identification Numbers, passport
photographs, GPS points, and a record of which government benefits each person
received. Treat every copy — including backups, exports and test restores —
as carrying the same sensitivity as production.

Two fields deserve particular care:

| Field | Protection in code | What infrastructure must add |
|---|---|---|
| `nin` | AES-256-GCM, key outside the database; blind index for matching | Key stored in a managed secret, separate from DB backups, with rotation |
| `photo` | Cloudinary `authenticated` delivery, short-lived signed URLs, EXIF/GPS stripped | Cloudinary account not shared with other systems |

If `FIELD_ENCRYPTION_KEY` is lost, **every stored NIN becomes unreadable**.
It is not recoverable from a database backup, by design. Back the key up
separately and test that restore path.

---

## Deployment sequence

```bash
npm ci --omit=dev
npm run deploy:db        # db:indexes && db:migrate
npm run db:indexes:check # gate: non-zero exit if a constraint is missing
npm start
```

`npm run db:indexes` is **mandatory**. `autoIndex` is disabled in production,
and until indexes exist, Blue ID uniqueness, sync-replay protection and
duplicate-benefit prevention are not enforced — silently. `/health/ready`
fails while any critical index is missing.

Run `npm run db:migrate -- --dry` against a copy before a real migration.
Migration `001` rewrites every NIN in the register.

---

## Health and shutdown

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /health/live` | Process is up. Touches no dependency. | none |
| `GET /health/ready` | Safe to route traffic. | none for up/down |
| `GET /health/ready` + `x-probe-key` | Full diagnosis | `HEALTH_PROBE_KEY` |

The detailed body names internal collections, integration state and any
missing constraints, so it is released only to a caller holding the probe key.
Point your orchestrator's probe at the plain endpoint; use the key from your
monitoring system.

**Graceful shutdown** on `SIGTERM`/`SIGINT`: readiness flips to `draining`
first, then a 5-second pause so the load balancer notices, then the listener
closes, in-flight jobs finish (15s budget), and MongoDB disconnects. Jobs that
do not finish keep their claim until it expires and are picked up by another
worker — nothing is lost. Configure your platform's termination grace period
to **at least 45 seconds**.

---

## Backups and restore

Not implemented in code — this is a managed-database responsibility.

**Required:**
- Automated daily snapshots with point-in-time recovery (Atlas: enable
  Continuous Cloud Backup).
- Retention agreed with the Department of Blue Economy; the register is a
  permanent government record.
- Backups encrypted at rest, in the same jurisdiction as production unless
  legal advice says otherwise.
- `FIELD_ENCRYPTION_KEY` backed up **separately** from the database. A
  snapshot without it has unreadable NINs; a snapshot with it beside it
  defeats the encryption.

**Restore drill — run quarterly, record the date and the result:**

1. Restore a snapshot into an isolated environment with its own credentials.
2. Point a throwaway deployment at it with `NODE_ENV=staging`.
3. `npm run db:indexes:check` — confirm every constraint restored.
4. `npm run db:migrate -- --status` — confirm migration state matches.
5. Verify a known Blue ID resolves and its NIN decrypts (confirms the key
   pairs with the snapshot).
6. Confirm counters are consistent: the programme reconciliation job reports
   `corrected: 0`.
7. Destroy the environment and its credentials.

An untested backup is not a backup.

---

## Media storage

Images are stored on this server's filesystem (`MEDIA_DRIVER=local`), not on a
third-party service. NITDA's National Cloud Policy places biometric and
identity data in a tier that must be stored in Nigeria at rest, and a passport
photograph tied to a NIN in a government identity register sits in that tier.

| Setting | Value |
|---|---|
| Root | `MEDIA_ROOT`, default `/var/lib/blueid/media` |
| Layout | `fishermen/<LGA>/<shard>/<BlueID>.jpg`, `assets/<kind>/<LGA>/<shard>/<id>.jpg`, `acknowledgements/<programme>/<shard>/<id>.jpg` |
| Format | JPEG, EXIF stripped, passport photos 400×400, assets ≤1024px |
| Access | HMAC-signed URLs expiring in 10 minutes, minted only after the caller is authorised against the record |

The directory must be **outside the deploy directory** so a release cannot
delete it, and owned by the service user with mode `0750`.

```bash
install -d -o blueid -g blueid -m 0750 /var/lib/blueid/media
```

### Backing it up — this is the part that matters

The database backup above does **not** cover this directory. A lost
photograph cannot be regenerated from anything: it means sending an
enumerator back to the fisherman. At state-wide scale this directory holds
roughly 30–50 GB.

```bash
# Nightly, to off-box storage. Keys live outside this repository.
restic -r <repo> backup /var/lib/blueid/media --tag media
restic -r <repo> forget --tag media --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
```

**Monthly restore drill**, same discipline as the database: restore to a
scratch directory, pick ten records at random from `fishermen`, confirm each
file opens as a valid JPEG of the expected dimensions. Record the date and who
ran it.

Alert on disk usage at 70%. The readiness probe writes a probe file on every
check, so a full, unmounted or read-only volume takes the instance out of the
load balancer rather than failing an enumerator's upload in a village.

### Serving the files through nginx

Node authorises the request and nginx sends the bytes, so image data never
passes through the event loop. Set `MEDIA_XACCEL_PREFIX=/protected-media` and
add:

```nginx
# Internal only: nginx will not serve this to a client directly, it is
# reachable solely via the X-Accel-Redirect header the app returns.
location /protected-media/ {
    internal;
    alias /var/lib/blueid/media/;

    add_header Cache-Control "private, max-age=300" always;
    add_header X-Content-Type-Options "nosniff" always;
}

location /api/v1/media/upload {
    client_max_body_size 12m;   # keep above MAX_UPLOAD_SIZE_MB
    proxy_pass http://127.0.0.1:4000;
}
```

Leave `MEDIA_XACCEL_PREFIX` blank and the app streams the file itself, which
is correct but spends the Node process on it.

### Migrating off Cloudinary

```bash
npm run media:migrate -- --dry-run    # report, change nothing
npm run media:migrate                 # move; safe to re-run after interruption
npm run media:verify                  # confirm every record resolves on disk
```

Nothing is deleted from Cloudinary. Keep the remote copies until `--verify`
reports zero failures **and** the local directory has been through a restore
drill — they are the rollback.

---

## Credentials

| Secret | Where it must live |
|---|---|
| `MONGODB_URI` | Managed secret. TLS enforced — config refuses a non-TLS URI in production |
| `UPSTASH_REDIS_REST_TOKEN` | Managed secret. Both URL and token required in production |
| `FIELD_ENCRYPTION_KEY` | Managed secret, **separate backup**, rotation plan |
| `QR_SIGNING_SECRET` | Managed secret. Rotating it invalidates every printed card |
| `FIREBASE_PRIVATE_KEY` | Managed secret, newlines escaped |
| `SERVICE_API_KEY`, `HEALTH_PROBE_KEY` | Managed secret, rotate on staff change |

Separate credentials per environment. Never reuse a production secret in
staging — a staging compromise must not reach the register.

**Database user:** least privilege. The application needs `readWrite` on its
own database only. It does not need `dbAdmin`, cluster roles, or access to
other databases. Index creation runs as a deploy step and may use a separate,
more privileged user.

**Network:** restrict Atlas access to the application's egress addresses.
Upstash REST is HTTPS with a bearer token; keep the token out of URLs and
logs (the logger redacts both).

---

## Logging and incident investigation

The logger redacts tokens, secrets, NINs, signed media URLs and private keys.
Error objects are reduced to `{name, message, code}` before logging, because a
Mongoose validation error carries the offending **value** — which could be a
citizen's NIN.

Every response carries `x-request-id`, and the same id is written to the audit
trail, so a database change can be traced to the HTTP call that caused it.

**Investigating an incident:**

1. Find the request id from the client report or the access log.
2. `GET /api/v1/audit?...` filtered by actor, entity or time window
   (requires `audit:read`).
3. For one record's full history: `GET /api/v1/audit/Fisherman/:id`.
4. Denied attempts are recorded too — a 401/403 writes a `FAILURE` audit
   entry, so an attempted intrusion is evidence, not silence.

Audit entries are append-only: the model rejects updates and deletes. For
stronger assurance, ship them to write-once storage — an administrator with
database access can still drop the collection, and the application cannot
prevent that.

**Alert on:** repeated `outcome: FAILURE` audit entries from one actor or IP;
`/health/ready` failing; `checks.jobs.dead > 0`; `checks.indexes.status`
error; queue `oldestPendingAgeMs` growing.

---

## Dependencies

```bash
npm run audit        # fails on high or critical, production deps only
npm run audit:all    # includes dev dependencies
```

**Known, accepted:** `uuid <11.1.1` reaches us transitively through
`exceljs`. The advisory concerns a missing bounds check when a caller passes
its own `buf` argument; nothing in this codebase does, and `exceljs` does not.
`npm audit fix --force` would downgrade `exceljs` to 3.4.0, a breaking change,
for no real reduction in risk. Re-evaluate when `exceljs` updates its
dependency.

Lock the lockfile (`npm ci`, never `npm install`, in CI and production) and
run the audit in the pipeline.

---

## What remains unverified

Honest list — these are not covered by the test suite and have not been
exercised against real infrastructure:

- **No backup has been taken or restored.** The procedure above is written,
  not tested.
- **No load test.** Latency, connection-pool saturation and queue throughput
  under a realistic sync burst are unknown.
- **Field encryption has not been exercised against a real key rotation.**
- **Firebase token verification has not been run against a live token**; it is
  verified structurally only.
- **The DB-backed test suite has not run against Atlas** — 23 tests skip until
  `MONGODB_URI` points at a real cluster.
- **Redis has never been exercised** — all runs so far used the in-process
  fallback, so the distributed rate limiter and lock are unproven in practice.

Close these before the register holds real personal data.

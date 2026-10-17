# Blue ID API.
#
# Two stages so the shipped image carries no build toolchain and no dev
# dependencies — a smaller image is also a smaller attack surface on a server
# holding citizen records.

# --- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Only the manifests first, so `npm ci` is cached until a dependency actually
# changes rather than on every source edit.
COPY package.json package-lock.json ./

# sharp ships prebuilt binaries for linux/amd64 and linux/arm64, so no build
# toolchain is needed. --omit=dev keeps eslint and the test harness out.
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# --- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# tini reaps zombies and forwards signals, so a `docker stop` reaches Node as
# a real SIGTERM and the graceful shutdown path runs. curl is for healthchecks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY package.json ./

# The media directory is a mount point; create it owned by the unprivileged
# user so the first upload does not fail on permissions.
RUN mkdir -p /var/lib/blueid/media && chown -R node:node /var/lib/blueid

# node:22 ships a `node` user. Running as root inside a container that holds
# the citizen register is not worth the convenience.
USER node

EXPOSE 4000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]

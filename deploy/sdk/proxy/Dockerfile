# Experimental CONNECT egress proxy — Phase 2 (NON-PRODUCTION).
#
# Separate build context (deploy/sdk/proxy). No dependencies: the proxy is a
# single plain-ESM Node file, so there is no npm install step and no lockfile.
# The image contains no model credentials; the proxy never sees an API key.
#
# Build context is deploy/sdk/proxy (set explicitly by the compose file):
#   docker compose -f deploy/docker-compose.sdk.yml build sdk-egress-proxy

FROM node:24.0.0-slim

ENV NODE_ENV=production \
    HOME=/tmp/home \
    TMPDIR=/tmp

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node proxy.mjs healthcheck.mjs ./

# Run as the unprivileged image user (uid 1000 / gid 1000).
USER node

CMD ["node", "proxy.mjs"]

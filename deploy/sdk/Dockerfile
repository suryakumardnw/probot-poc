# Experimental SDK worker image — Phase 1 (offline placeholder shell).
#
# This is a SEPARATE, NON-PRODUCTION deployment unit. It is not built by the
# production Dockerfile and is not referenced by deploy/docker-compose.yml.
#
# Node 24 is required ONLY in this image. @opencode/sdk@2.2.7 depends on
# @opencode/util, which uses `await using` syntax. That cannot be parsed by
# Node 20.18.1 or Node 22.14.0, so the SDK cannot even be imported there
# (Phase 0: SyntaxError before use). The existing CLI production image in the
# repository root Dockerfile stays on Node 22.14.0 and is unchanged.
#
# Deliberately absent from this image:
#   - opencode CLI, git, docker CLI, Prisma, shell tooling for reviews
#   - deploy/.env, secrets, Docker socket
#
# Build context is deploy/sdk (small). The compose file sets this explicitly:
#   docker compose -f deploy/docker-compose.sdk.yml build

FROM node:24.0.0-slim

# Read-only root filesystem at runtime: all writable state must live in /tmp
# (tmpfs) or /app/workspaces (named volume). Keep HOME/XDG/TMPDIR pointed at
# /tmp so the SDK never tries to write to the image layers.
ENV NODE_ENV=production \
    HOME=/tmp/home \
    XDG_CONFIG_HOME=/tmp/home/.config \
    XDG_CACHE_HOME=/tmp/home/.cache \
    XDG_DATA_HOME=/tmp/home/.local/share \
    XDG_STATE_HOME=/tmp/home/.local/state \
    TMPDIR=/tmp

WORKDIR /app

# Production-style install of the pinned SDK only. No dev dependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node worker ./worker

# Workspace mountpoint must exist owned by node before the named volume is
# attached; otherwise Docker creates it as root and the worker cannot write.
RUN mkdir -p /app/workspaces && chown node:node /app/workspaces

# Run as the unprivileged image user (uid 1000 / gid 1000).
USER node

WORKDIR /app
CMD ["node", "worker/placeholder-worker.mjs"]

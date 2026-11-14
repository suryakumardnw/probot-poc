# --- Build stage ---
# Pinned minor version (ticket 13): never use floating major/minor-only tags in
# production. Bump deliberately and re-run the full test suite.
FROM node:24.22.3-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
# Generate the Prisma client before compiling TypeScript.
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage ---
FROM node:24.22.3-slim
WORKDIR /app
ENV NODE_ENV=production

# Production runtime dependencies (ticket 13):
#   - git            : shallow clone of reviewed repositories (ticket 04).
#   - docker CLI     : client for SANDBOX_DOCKER_HOST only (ticket 11) — the
#                      Docker socket is NEVER mounted into this image.
#   - opencode       : agent runtime CLI (ticket 06), pinned to the version
#                      the runtime was validated against. Downloaded as a
#                      static release tarball from the official release host,
#                      not via the v1 install script (which refuses 2.x).
ARG TARGETARCH
ARG DOCKER_CLI_VERSION=28.3.3
# 2.2.6 is the first pinned version verified to load package plugins in
# `opencode run` mode (2.2.5 silently ignores the configured `plugins`, which
# suppresses Langfuse tracing without any error).
ARG OPENCODE_VERSION=2.2.6
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) docker_arch=x86_64; oc_arch=x64-baseline ;; \
      arm64) docker_arch=aarch64; oc_arch=arm64 ;; \
      *) echo "unsupported TARGETARCH $TARGETARCH"; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
      | tar -xz -C /tmp docker/docker; \
    mv /tmp/docker/docker /usr/local/bin/docker; \
    curl -fsSL -o /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${oc_arch}.tar.gz"; \
    tar -xzf /tmp/opencode.tar.gz -C /tmp; \
    mv /tmp/opencode /usr/local/bin/opencode; \
    chmod 0755 /usr/local/bin/docker /usr/local/bin/opencode; \
    /usr/local/bin/opencode --version; \
    docker --version; \
    apt-get purge -y curl; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/* /tmp/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY prisma ./prisma
# Generate the client again so the runtime image has matching engine binaries.
# Note: --no-engine produces a client that only accepts prisma:// (accelerate)
# URLs, so we must build the full engine-backed client here.
RUN npx prisma generate
COPY --from=build /app/lib ./lib
# Review workspace root (ticket 04). The worker runs as USER node (uid 1000)
# and clones reviewed repositories under /app/workspaces, which is a named
# volume in production (deploy/docker-compose.yml). The directory must exist
# in the image owned by node BEFORE the volume is mounted — otherwise Docker
# creates the mountpoint as root:root 0755 and git fails with
# "could not create work tree dir: Permission denied".
RUN mkdir -p /app/workspaces && chown node:node /app/workspaces
# Review pipeline configuration (ticket 13): the worker loads config/review.json
# at startup and fails closed when it is missing.
COPY --chown=node:node config ./config

# Run as non-root.
#
# Keep HOME stable and writable: the OpenCode plugin cache lives under
# $HOME/.cache/opencode, and the worker forwards HOME to the isolated agent
# child process (XDG_CONFIG_HOME/XDG_DATA_HOME are per-session).
ENV HOME=/home/node
USER node

# Pre-install the agent-tracing plugin at build time. `opencode run` does NOT
# install a missing package plugin itself (only a long-running server does, in
# the background), and every review uses a fresh per-session config/data dir.
# Without this cache the `plugins` entry in the session config is silently
# ignored and no traces are exported. Bump the pin deliberately.
ARG AGENT_TRACING_PLUGIN=@devtheops/opencode-plugin-otel@2.1.0
RUN mkdir -p /home/node/.config/opencode && \
    opencode plugin add "${AGENT_TRACING_PLUGIN}" && \
    test -d /home/node/.cache/opencode/npm/@devtheops

# Default: Probot application. Override with `node lib/worker.js` for the
# review worker container. Invoking node directly (not npm) makes the node
# process PID 1 so SIGTERM reaches it for graceful shutdown.
CMD [ "node", "lib/server.js" ]

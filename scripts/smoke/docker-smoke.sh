#!/usr/bin/env bash
#
# Docker Compose smoke test (PR 4.4).
#
# Builds the production image, starts Postgres, Redis, the one-shot migration,
# the Probot server and the review worker with the real Compose files, then
# verifies:
#
#   - GET /healthz returns 200;
#   - GET /readyz reports every dependency as ok;
#   - the server starts in the degraded (no GitHub App credentials) mode;
#   - the worker logs readiness with Postgres and Redis ok;
#   - the worker has a BullMQ consumer connected to the review queue.
#
# No real GitHub or model-provider credentials are required: the server's
# degraded path keeps health/readiness available and the worker only needs
# Postgres/Redis to boot. A review is never executed, so no model call is made.
#
# Usage:
#   bash scripts/smoke/docker-smoke.sh
#
# Environment overrides:
#   PROBOT_PORT        Host port for the server (default: a free port)
#   SMOKE_PROJECT_NAME Compose project name (default: probot-smoke-<pid>)
#   SMOKE_EDGE_NETWORK External edge network name (default: <project>-edge)
#   SMOKE_TIMEOUT      Seconds to wait for each readiness condition (default 180)
#   SMOKE_LOG_DIR      Log directory (default: test-results/docker-smoke)
#   DOCKER_HOST        Standard Docker client override (e.g. Colima socket)
#
# The script always tears the Compose project down, including named volumes,
# and prints the container logs when an assertion fails.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILES=(-f deploy/docker-compose.yml -f deploy/docker-compose.local.yml -f scripts/smoke/docker-compose.smoke.yml)

PROJECT_NAME="${SMOKE_PROJECT_NAME:-probot-smoke-$$}"
EDGE_NETWORK="${SMOKE_EDGE_NETWORK:-${PROJECT_NAME}-edge}"
LOG_DIR="${SMOKE_LOG_DIR:-${ROOT_DIR}/test-results/docker-smoke}"
TIMEOUT_SECONDS="${SMOKE_TIMEOUT:-180}"

STARTED=0
CREATED_NETWORK=0
STATUS=0

log() {
  printf '[docker-smoke] %s\n' "$*"
}

fail() {
  printf '[docker-smoke] ERROR: %s\n' "$*" >&2
  exit 1
}

compose() {
  docker compose -p "$PROJECT_NAME" "${COMPOSE_FILES[@]}" "$@"
}

logs_for() {
  local service="$1"
  compose logs --no-color "$service" 2>/dev/null || true
}

collect_logs() {
  mkdir -p "$LOG_DIR"
  local service
  for service in migrate probot worker postgres redis; do
    compose logs --no-color "$service" >"${LOG_DIR}/${service}.log" 2>&1 || true
  done
}

print_logs() {
  local service
  for service in migrate probot worker postgres redis; do
    log "----- ${service} logs (last 200 lines) -----"
    compose logs --no-color --tail=200 "$service" 2>&1 || true
  done
}

cleanup() {
  STATUS=$?
  trap - EXIT INT TERM
  set +e

  if [[ "$STARTED" == "1" ]]; then
    collect_logs
    if [[ "$STATUS" -ne 0 ]]; then
      log "Smoke test failed; container logs follow. Full logs: ${LOG_DIR}"
      print_logs
    else
      log "Container logs saved to ${LOG_DIR}"
    fi
    compose down -v --remove-orphans --timeout 15 >/dev/null 2>&1
  fi

  if [[ "$CREATED_NETWORK" == "1" ]]; then
    docker network rm "$EDGE_NETWORK" >/dev/null 2>&1
  fi

  exit "$STATUS"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

pick_free_port() {
  if command -v node >/dev/null 2>&1; then
    node -e '
      const net = require("node:net");
      const server = net.createServer();
      server.on("error", () => process.exit(1));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") {
          process.stdout.write(String(address.port));
        }
        server.close();
      });
    ' || printf '3000'
  else
    printf '3000'
  fi
}

wait_for_http_ok() {
  local url="$1"
  local label="$2"
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  while ((SECONDS < deadline)); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "${label} did not return HTTP 200 within ${TIMEOUT_SECONDS}s"
}

wait_for_ready() {
  local url="$1"
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  local body
  while ((SECONDS < deadline)); do
    body="$(curl -fsS --max-time 3 "$url" 2>/dev/null || true)"
    if printf '%s\n' "$body" | grep -F '"status":"ok"' >/dev/null; then
      return 0
    fi
    sleep 1
  done
  fail "/readyz did not report status ok within ${TIMEOUT_SECONDS}s"
}

wait_for_log() {
  local service="$1"
  local pattern="$2"
  local label="$3"
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  local logs
  while ((SECONDS < deadline)); do
    logs="$(logs_for "$service")"
    if printf '%s\n' "$logs" | grep -F -- "$pattern" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  fail "${label} was not logged by '${service}' within ${TIMEOUT_SECONDS}s"
}

wait_for_queue_consumer() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  local clients
  while ((SECONDS < deadline)); do
    clients="$(compose exec -T redis redis-cli --raw CLIENT LIST 2>/dev/null || true)"
    if printf '%s\n' "$clients" \
      | grep -F 'name=bull:' \
      | grep -E 'cmd=(bzpopmin|brpoplpush)' >/dev/null; then
      return 0
    fi
    sleep 1
  done
  fail "no BullMQ queue consumer connected to the worker within ${TIMEOUT_SECONDS}s"
}

mkdir -p "$LOG_DIR"

# Compose interpolates POSTGRES_PASSWORD into every DATABASE_URL, and the
# local override publishes the server on this port.
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-smoke-postgres-password}"
export PROBOT_PORT="${PROBOT_PORT:-$(pick_free_port)}"
export DOKPLOY_NETWORK="$EDGE_NETWORK"
export OBSERVABILITY_NETWORK="${PROJECT_NAME}_observability"

if ! docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1; then
  log "Creating external edge network ${EDGE_NETWORK}"
  docker network create "$EDGE_NETWORK" >/dev/null
  CREATED_NETWORK=1
fi

log "Building the production image (ai-pr-reviewer/app:prod)"
if ! compose build migrate 2>&1 | tee "${LOG_DIR}/build.log"; then
  fail "image build failed; see ${LOG_DIR}/build.log"
fi

log "Starting Postgres, Redis, migration, server, and worker"
STARTED=1
if ! compose up -d --no-build postgres redis migrate probot worker; then
  fail "docker compose up failed"
fi

wait_for_log probot "starting without GitHub webhook processing" "degraded server start"
wait_for_http_ok "http://127.0.0.1:${PROBOT_PORT}/healthz" "/healthz"
wait_for_ready "http://127.0.0.1:${PROBOT_PORT}/readyz"

wait_for_log worker "Review worker ready" "worker readiness"
worker_ready="$(logs_for worker | grep -F 'Review worker ready' | tail -n 1)"
if ! printf '%s\n' "$worker_ready" | grep -F '"postgres":"ok"' >/dev/null; then
  fail "worker readiness did not report Postgres ok"
fi
if ! printf '%s\n' "$worker_ready" | grep -F '"redis":"ok"' >/dev/null; then
  fail "worker readiness did not report Redis ok"
fi

wait_for_queue_consumer

running="$(compose ps --services --filter status=running 2>/dev/null || true)"
for service in postgres redis probot worker; do
  if ! printf '%s\n' "$running" | grep -Fx -- "$service" >/dev/null; then
    fail "service '${service}' is not running"
  fi
done

log "PASS: /healthz 200, /readyz ok, degraded server start, worker ready and consuming the review queue"

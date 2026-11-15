/**
 * Redis durability configuration (§12.2) — documentation module.
 *
 * The review queue is RECOVERABLE, not durable by itself: the source of truth
 * for every review is PostgreSQL; Redis/BullMQ holds only execution state.
 * Losing Redis therefore never loses a review — startup reconciliation
 * (`src/recovery/reconciliation.ts`) re-enqueues every non-terminal review
 * whose durable ReviewJob is stuck, reusing the same BullMQ job id.
 *
 * Still, production deployments should reduce needless recovery churn by
 * enabling Redis persistence:
 *
 *   docker-compose (ticket01-redis):
 *     command: ["redis-server", "--appendonly", "yes", "--appendfsync", "everysec"]
 *
 *   - `--appendonly yes` — AOF snapshot; on restart BullMQ waiting/active/
 *     delayed jobs are reloaded instead of silently vanishing.
 *   - `--appendfsync everysec` — fsync once per second (default and
 *     recommended: at most ~1s of acknowledged enqueue loss, bounded by the
 *     reconciliation pass anyway).
 *   - RDB alone (`save 900 1` style) is also acceptable; AOF is preferred for
 *     queue state because it loses at most one second of writes.
 *
 * Deployment checklist (§12.2):
 *   1. Set REDIS_URL for both the Probot server and the worker.
 *   2. Enable AOF as above (or a managed Redis with persistence enabled).
 *   3. Keep `maxRetriesPerRequest: null` on worker connections (already set in
 *      src/workspace/processor.ts) so brief Redis outages don't kill in-flight
 *      jobs.
 *   4. On Redis restart: outbox recovery republishes pending events and
 *      reconciliation re-enqueues stale processing jobs — no operator action.
 */

export const REDIS_PERSISTENCE_COMMANDLINE = [
  "redis-server",
  "--appendonly",
  "yes",
  "--appendfsync",
  "everysec",
] as const;

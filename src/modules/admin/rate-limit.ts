/**
 * In-process fixed-window rate limiter for admin endpoints (ticket 10, §14.2).
 *
 * Buckets are keyed by `<scope>:<clientIp>`. Successful, failed and rejected
 * requests all count. Production multi-replica deployments should swap this
 * for a Redis-backed limiter (ticket 13); the interface stays the same.
 */

export interface RateLimitOptions {
  limitPerMinute: number;
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

export function clearRateLimitBuckets(): void {
  buckets.clear();
}

export function checkRateLimit(key: string, options: RateLimitOptions): RateLimitResult {
  const now = (options.now ?? Date.now)();
  const windowMs = 60_000;
  let bucket = buckets.get(key);
  if (!bucket || bucket.windowStart + windowMs <= now) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > options.limitPerMinute) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }
  // Opportunistic cleanup so the map does not grow without bound.
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) {
      if (b.windowStart + windowMs <= now) {
        buckets.delete(k);
      }
    }
  }
  return { allowed: true, remaining: options.limitPerMinute - bucket.count, retryAfterSeconds: 0 };
}

/** Best-effort client IP extraction from proxy headers or the socket. */
export function clientIpOf(req: {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
}): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() ?? "";
  }
  return req.socket.remoteAddress ?? "unknown";
}

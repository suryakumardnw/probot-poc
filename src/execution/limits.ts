/**
 * Resource limit parsing and disk-quota enforcement (§10.4, ticket 11).
 *
 * Quantities follow the config schema (`2Gi`, `512Mi`, `500M`). Disk quota is
 * enforced host-side by polling the delta of actual disk usage of the
 * execution's writable roots and terminating the process tree when the
 * configured budget is exceeded — this works for both local hardened
 * processes and Docker containers whose workspace is bind-mounted from the
 * host (Docker's own tmpfs/storage limits additionally cap in-container
 * writes).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Parse "2Gi" | "512Mi" | "1G" | "500M" into bytes. */
export function resolveQuantity(value: string): number | null {
  const match = /^(\d+)(Gi|Mi|G|M)$/.exec(value);
  if (!match) {
    return null;
  }
  const n = Number(match[1]);
  switch (match[2]) {
    case "Gi":
      return n * 1024 ** 3;
    case "Mi":
      return n * 1024 ** 2;
    case "G":
      return n * 1e9;
    default:
      return n * 1e6;
  }
}

/** `du -sk` a path (kilobyte blocks). Returns null when unavailable. */
export async function diskUsageBytes(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("du", ["-sk", path], { timeout: 10_000 });
    const kb = Number.parseInt(stdout.split(/\s/)[0] ?? "", 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

export interface DiskQuotaWatcher {
  /** Current delta bytes above the baseline, or null when unmeasurable. */
  exceeded(): Promise<{ exceeded: boolean; usageBytes: number | null }>;
  stop(): void;
}

/**
 * Watch disk usage of `paths` against a delta budget relative to the
 * baseline captured at creation. Polls every `intervalMs` (default 250ms);
 * `exceeded()` always performs a fresh measurement so termination is checked
 * right before the timeout fires too.
 */
export function createDiskQuotaWatcher(
  paths: readonly string[],
  quotaBytes: number,
  intervalMs = 250,
): DiskQuotaWatcher {
  let baseline = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const measure = async (): Promise<number | null> => {
    let total = 0;
    for (const path of paths) {
      const usage = await diskUsageBytes(path);
      if (usage === null) {
        return null;
      }
      total += usage;
    }
    return total;
  };

  const started = (async () => {
    const initial = await measure();
    baseline = initial ?? 0;
    if (!stopped && intervalMs > 0) {
      timer = setInterval(() => {
        void measure();
      }, intervalMs);
      timer.unref?.();
    }
    return baseline;
  })();

  return {
    async exceeded() {
      await started;
      const current = await measure();
      if (current === null) {
        return { exceeded: false, usageBytes: null };
      }
      const usage = Math.max(0, current - baseline);
      return { exceeded: quotaBytes > 0 && usage > quotaBytes, usageBytes: usage };
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
      }
    },
  };
}

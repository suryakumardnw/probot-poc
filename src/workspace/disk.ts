import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Recursively measure the bytes used by actual files under a workspace root.
 *
 * Unlike `statfs` (which reports the whole filesystem), this is the directory
 * usage the `disk_approaching_limit` alert intends to track. Symlinks are not
 * followed, so a workspace cannot inflate its usage by linking outside the
 * root. Missing paths and unreadable entries are treated as zero.
 */
export async function workspaceDirectorySizeBytes(root: string): Promise<number> {
  let total = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 50) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fsp.lstat(full);
        if (stat.isFile()) total += stat.size;
      } catch {
        /* entry disappeared or is unreadable — ignore for metrics */
      }
    }
  }

  await walk(root, 0);
  return total;
}

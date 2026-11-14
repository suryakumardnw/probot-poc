import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceDirectorySizeBytes } from "../src/workspace/disk.js";

describe("workspaceDirectorySizeBytes", () => {
  test("sums regular files recursively and skips symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-disk-"));
    const outside = await mkdtemp(join(tmpdir(), "workspace-disk-outside-"));
    try {
      await mkdir(join(root, "a", "b"), { recursive: true });
      await writeFile(join(root, "a", "one.txt"), "12345"); // 5 bytes
      await writeFile(join(root, "a", "b", "two.txt"), "1234567890"); // 10 bytes
      await writeFile(join(outside, "secret.txt"), "x".repeat(1_000));
      await symlink(outside, join(root, "outside-link"), "dir");

      expect(await workspaceDirectorySizeBytes(root)).toBe(15);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("returns 0 for a missing root", async () => {
    const missing = join(tmpdir(), `workspace-disk-missing-${Date.now()}`);
    expect(await workspaceDirectorySizeBytes(missing)).toBe(0);
  });
});

import { describe, expect, test } from "vitest";
import {
  githubCommitResponseSchema,
  githubContentResponseSchema,
  githubTreeEntrySchema,
  githubTreeResponseSchema,
  knowledgeFileRecordSchema,
  knowledgeManifestSchema,
} from "./knowledge.js";

/**
 * Contract tests for GitHub response envelopes and the knowledge cache
 * manifest. The fetcher and cache behavior are covered in
 * `test/knowledge.test.ts`; these tests pin the wire/disk shapes.
 */

const FILE = {
  path: "skills/code-review/SKILL.md",
  sha256: "a".repeat(64),
  bytes: 123,
};

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: "b".repeat(40),
    fetchedAt: "2026-11-15T00:00:00.000Z",
    contentHash: "c".repeat(64),
    status: "fresh",
    files: [FILE],
    ...overrides,
  };
}

describe("GitHub response contracts", () => {
  test("commit response requires only a string sha and allows extra fields", () => {
    const parsed = githubCommitResponseSchema.parse({
      sha: "a".repeat(40),
      commit: { message: "initial" },
      url: "https://api.github.com/repos/o/r/commits/main",
    });

    expect(parsed.sha).toBe("a".repeat(40));
  });

  test("commit response tolerates a missing sha so the caller keeps its error", () => {
    expect(githubCommitResponseSchema.parse({ message: "Not Found" }).sha).toBeUndefined();
  });

  test("commit response rejects a non-string sha", () => {
    expect(githubCommitResponseSchema.safeParse({ sha: 123 }).success).toBe(false);
  });

  test("tree entries require path, mode and type and allow extra fields", () => {
    const entry = githubTreeEntrySchema.parse({
      path: "docs/standards.md",
      mode: "100644",
      type: "blob",
      size: 42,
      sha: "d".repeat(40),
      url: "https://api.github.com/...",
    });

    expect(entry).toMatchObject({ path: "docs/standards.md", mode: "100644", type: "blob", size: 42 });
  });

  test("tree response requires entries to be structurally complete", () => {
    expect(githubTreeResponseSchema.safeParse({ tree: [{ path: "a.md" }] }).success).toBe(false);
    expect(githubTreeResponseSchema.safeParse({ tree: [{ path: "a.md", mode: "100644", type: "blob" }] }).success).toBe(
      true,
    );
  });

  test("tree response tolerates a missing tree so the caller keeps its error", () => {
    expect(githubTreeResponseSchema.parse({ truncated: false }).tree).toBeUndefined();
  });

  test("content response accepts a base64 payload and extra fields", () => {
    expect(
      githubContentResponseSchema.parse({
        content: "aGVsbG8=",
        encoding: "base64",
        name: "SKILL.md",
        size: 5,
      }),
    ).toMatchObject({ content: "aGVsbG8=", encoding: "base64" });
  });

  test("content response rejects a non-string content field", () => {
    expect(githubContentResponseSchema.safeParse({ content: 42, encoding: "base64" }).success).toBe(false);
  });
});

describe("knowledge manifest contract", () => {
  test("accepts a fresh manifest with file records", () => {
    const parsed = knowledgeManifestSchema.parse(manifest());

    expect(parsed.status).toBe("fresh");
    expect(parsed.files).toEqual([FILE]);
  });

  test("rejects a non-fresh status so stale cache entries refetch", () => {
    expect(knowledgeManifestSchema.safeParse(manifest({ status: "unavailable" })).success).toBe(false);
  });

  test("rejects a manifest without files", () => {
    expect(knowledgeManifestSchema.safeParse(manifest({ files: [] })).success).toBe(false);
  });

  test("rejects a file record without a valid sha256", () => {
    expect(knowledgeFileRecordSchema.safeParse({ ...FILE, sha256: "not-a-hash" }).success).toBe(false);
    expect(knowledgeFileRecordSchema.safeParse({ ...FILE, bytes: -1 }).success).toBe(false);
    expect(knowledgeFileRecordSchema.safeParse({ ...FILE, path: "" }).success).toBe(false);
  });
});

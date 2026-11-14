/**
 * Knowledge source tests (boot-time initialization, §5.3 + §4 reproducibility).
 *
 * All network behavior is mocked via the injectable `KnowledgeFetcher` —
 * no real GitHub access in CI. Covers:
 *  - cache miss → fetch → manifest written + per-file hashes;
 *  - cache hit → the fetcher is never called;
 *  - ref change → refetch under the new ref;
 *  - invalid content (oversize, fetch failure) → rejected; the source becomes
 *    unavailable and its review type fails fast (no fallback content);
 *  - concurrent ensure calls resolve once;
 *  - per-review materialization: own workspace copy + persisted snapshot,
 *    injection reads only the copy, and unreproducible snapshots fail fast.
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { reviewConfigSchema, type ReviewConfig } from "../src/config/review-schema.js";
import { sha256Hex } from "../src/knowledge/fetch.js";
import {
  ensureKnowledgeSources,
  knowledgeSpecsFromConfig,
  materializeReviewKnowledge,
  persistKnowledgeMetrics,
  resetKnowledgeSnapshotForTests,
  setKnowledgeSnapshot,
  KnowledgeSnapshotError,
} from "../src/knowledge/index.js";
import type { KnowledgeFetcher } from "../src/knowledge/types.js";
import { getPrisma, disconnectPrisma } from "../src/lib/prisma.js";
import { resolveReviewInjection, selectHandbookSections } from "../src/review-engine/injection.js";

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";

const SKILL_REF = "cf865e94de7729751c747171785b6ce57e7b178c";
const SKILL_REF_B = "d".repeat(40);
const HANDBOOK_SHA = "b".repeat(40);

const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as pino.Logger;

function makeConfig(
  skillRef: string = SKILL_REF,
  handbookRef: string = "main",
  technologyRefs: Array<{ technologies: string[]; ref: string }> = [],
): ReviewConfig {
  return reviewConfigSchema.parse({
    schemaVersion: 1,
    provider: { baseURL: "${MODEL_BASE_URL}", apiKeyEnv: "MODEL_API_KEY", model: "test-model" },
    github: { organization: "acme" },
    knowledge: {
      fetchTimeoutMs: 5000,
      skill: { repo: "vercel-labs/open-agents", ref: skillRef, skillDir: "skills/code-review", maxBytes: 200000 },
      handbook: {
        repo: "nativewit/engineering-handbook",
        ref: handbookRef,
        technologyRefs,
        path: "",
        maxBytes: 2000000,
        maxChars: 20000,
      },
    },
  });
}

/** Minimal fake GitHub API surface driven by an in-memory file map. */
function makeFetcher(
  files: Record<string, string>,
  refs: Record<string, string> = {},
): KnowledgeFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean); // repos/:o/:r/...
    if (parts[0] === "repos") {
      if (parts[3] === "commits") {
        const ref = decodeURIComponent(parts[4]!);
        const sha = refs[ref] ?? (/^[0-9a-f]{40}$/.test(ref) ? ref : null);
        if (!sha) return { status: 404, text: JSON.stringify({ message: "Not Found" }) };
        return { status: 200, text: JSON.stringify({ sha }) };
      }
      if (parts[3] === "git" && parts[4] === "trees") {
        const sha = parts[5]!.split("?")[0]!;
        const tree = Object.entries(files)
          .filter(([path]) => path.startsWith(`${sha}/`))
          .map(([path, content]) => ({
            path: path.slice(41),
            mode: "100644",
            type: "blob",
            size: Buffer.byteLength(content),
          }));
        return { status: 200, text: JSON.stringify({ tree }) };
      }
      if (parts[3] === "contents") {
        const sha = parsed.searchParams.get("ref") ?? "";
        const filePath = parts.slice(4).map(decodeURIComponent).join("/");
        const content = files[`${sha}/${filePath}`];
        if (content === undefined) return { status: 404, text: JSON.stringify({ message: "Not Found" }) };
        return {
          status: 200,
          text: JSON.stringify({ encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") }),
        };
      }
    }
    return { status: 404, text: "{}" };
  }) as KnowledgeFetcher & { calls: string[] };
  fetcher.calls = calls;
  return fetcher;
}

const tempDirs: string[] = [];

function makeCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
  tempDirs.push(dir);
  return join(dir, "cache");
}

beforeEach(() => {
  resetKnowledgeSnapshotForTests();
});

afterAll(async () => {
  await disconnectPrisma();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("ensureKnowledgeSources", () => {
  test("cache miss → fetch → manifest written with per-file hashes", async () => {
    const cacheDir = makeCacheDir();
    const skillContent = "# skill\n\nPlaybook body.";
    const fetcher = makeFetcher(
      {
        [`${SKILL_REF}/skills/code-review/SKILL.md`]: skillContent,
        [`${HANDBOOK_SHA}/docs/standards.md`]: "# Standards\n\nBe excellent.",
        [`${HANDBOOK_SHA}/package.json`]: "{}", // config-like manifest: stripped
      },
      { main: HANDBOOK_SHA },
    );
    const snapshot = await ensureKnowledgeSources(makeConfig(SKILL_REF, HANDBOOK_SHA), fakeLogger, {
      cacheDir,
      fetcher,
    });

    expect(snapshot.skill.status).toBe("fresh");
    expect(snapshot.skill.ref).toBe(SKILL_REF);
    expect(snapshot.skill.files).toEqual([
      { path: "skills/code-review/SKILL.md", sha256: sha256Hex(skillContent), bytes: Buffer.byteLength(skillContent) },
    ]);
    expect(snapshot.handbook.status).toBe("fresh");
    expect(snapshot.handbook.files.map((f) => f.path)).toEqual(["docs/standards.md"]);
    expect(snapshot.skill.contentHash).toBe(
      sha256Hex(snapshot.skill.files.map((f) => `${f.sha256}  ${f.path}\n`).join("")),
    );

    const manifest = JSON.parse(readFileSync(join(snapshot.skill.dir!, "manifest.json"), "utf8"));
    expect(manifest.status).toBe("fresh");
    expect(manifest.ref).toBe(SKILL_REF);
    expect(manifest.contentHash).toBe(snapshot.skill.contentHash);
    expect(existsSync(join(snapshot.skill.dir!, "skills/code-review/SKILL.md"))).toBe(true);
  });

  test("cache hit → no network (fetcher not called)", async () => {
    const cacheDir = makeCacheDir();
    const first = makeFetcher({
      [`${SKILL_REF}/skills/code-review/SKILL.md`]: "# skill",
      [`${HANDBOOK_SHA}/docs/standards.md`]: "# Standards",
    });
    const snapshot1 = await ensureKnowledgeSources(makeConfig(SKILL_REF, HANDBOOK_SHA), fakeLogger, {
      cacheDir,
      fetcher: first,
    });
    expect(first.calls.length).toBeGreaterThan(0);
    expect(snapshot1.skill.ref).toBe(SKILL_REF);

    const second = makeFetcher({});
    const snapshot2 = await ensureKnowledgeSources(makeConfig(SKILL_REF, HANDBOOK_SHA), fakeLogger, {
      cacheDir,
      fetcher: second,
    });
    expect(second.calls).toHaveLength(0);
    expect(snapshot2.skill.status).toBe("fresh");
    expect(snapshot2.skill.contentHash).toBe(snapshot1.skill.contentHash);
  });

  test("technologyRefs → fetched at boot and injected for matching technologies", async () => {
    const cacheDir = makeCacheDir();
    // Mixed-case branch name: refs must not be lowercased before resolving.
    const tsRef = "feat/CU-86bcd-typescript-guidelines";
    const tsSha = "c".repeat(40);
    const fetcher = makeFetcher(
      {
        [`${SKILL_REF}/skills/code-review/SKILL.md`]: "# skill",
        [`${HANDBOOK_SHA}/docs/02-flutter.md`]: "# Flutter\n\nUse FVM.",
        [`${tsSha}/docs/guidelines/typescript/01_architecture.md`]: "# TypeScript Architecture\n\nKeep boundaries.",
      },
      { main: HANDBOOK_SHA, [tsRef]: tsSha },
    );
    const config = makeConfig(SKILL_REF, "main", [{ technologies: ["typescript", "nodejs"], ref: tsRef }]);
    const snapshot = await ensureKnowledgeSources(config, fakeLogger, { cacheDir, fetcher });

    expect(snapshot.handbookVariants).toHaveLength(1);
    expect(snapshot.handbookVariants![0]!.technologies).toEqual(["typescript", "nodejs"]);
    expect(snapshot.handbookVariants![0]!.source.status).toBe("fresh");
    expect(snapshot.handbookVariants![0]!.source.ref).toBe(tsSha);

    const workspacePath = mkdtempSync(join(tmpdir(), "ws-ts-handbook-"));
    tempDirs.push(workspacePath);
    let captured: { handbook?: { ref: string }; handbookVariants?: Array<{ source: { ref: string } }> } | null = null;
    const materialized = await materializeReviewKnowledge({
      reviewId: "materialize-only-tech-ref",
      reviewType: "handbook",
      workspacePath,
      snapshot,
      prisma: {
        review: {
          findUnique: async () => ({ knowledgeSnapshot: null }),
          update: async (args: { data: { knowledgeSnapshot: object } }) => {
            captured = args.data.knowledgeSnapshot as typeof captured;
            return {};
          },
        },
      } as unknown as ReturnType<typeof getPrisma>,
      logger: fakeLogger,
    });
    expect(captured!.handbook!.ref).toBe(HANDBOOK_SHA);
    expect(captured!.handbookVariants![0]!.source.ref).toBe(tsSha);
    expect(
      existsSync(
        join(workspacePath, "knowledge", "handbook-variants", tsSha, "docs/guidelines/typescript/01_architecture.md"),
      ),
    ).toBe(true);

    // `.ts` is detected as typescript/nodejs → the variant copy is injected.
    const tsInjection = await resolveReviewInjection({
      reviewType: "handbook",
      config,
      changedFiles: ["app/src/index.ts"],
      knowledgeDir: materialized.knowledgeDir,
      snapshot,
      logger: fakeLogger,
    });
    expect(tsInjection!.files).toEqual(["docs/guidelines/typescript/01_architecture.md"]);
    expect(tsInjection!.text).toContain("Keep boundaries.");
    expect(tsInjection!.contentHash).toBe(snapshot.handbookVariants![0]!.source.contentHash);

    // Dart has no matching variant → the default handbook is used.
    const flutterInjection = await resolveReviewInjection({
      reviewType: "handbook",
      config,
      changedFiles: ["lib/main.dart"],
      knowledgeDir: materialized.knowledgeDir,
      snapshot,
      logger: fakeLogger,
    });
    expect(flutterInjection!.files).toEqual(["docs/02-flutter.md"]);
    expect(flutterInjection!.contentHash).toBe(snapshot.handbook.contentHash);
  });

  test("unavailable technology ref fails fast for matching PRs only", async () => {
    const cacheDir = makeCacheDir();
    const fetcher = makeFetcher(
      {
        [`${SKILL_REF}/skills/code-review/SKILL.md`]: "# skill",
        [`${HANDBOOK_SHA}/docs/02-flutter.md`]: "# Flutter\n\nUse FVM.",
      },
      { main: HANDBOOK_SHA }, // the configured TS ref does not resolve → unavailable
    );
    const config = makeConfig(SKILL_REF, "main", [{ technologies: ["typescript"], ref: "feat/missing" }]);
    const snapshot = await ensureKnowledgeSources(config, fakeLogger, { cacheDir, fetcher });
    expect(snapshot.handbookVariants![0]!.source.status).toBe("unavailable");

    const workspacePath = mkdtempSync(join(tmpdir(), "ws-missing-ts-"));
    tempDirs.push(workspacePath);
    const materialized = await materializeReviewKnowledge({
      reviewId: "materialize-only-missing-ts",
      reviewType: "handbook",
      workspacePath,
      snapshot,
      prisma: {
        review: {
          findUnique: async () => ({ knowledgeSnapshot: null }),
          update: async () => ({}),
        },
      } as unknown as ReturnType<typeof getPrisma>,
      logger: fakeLogger,
    });

    await expect(
      resolveReviewInjection({
        reviewType: "handbook",
        config,
        changedFiles: ["app/src/index.ts"],
        knowledgeDir: materialized.knowledgeDir,
        snapshot,
        logger: fakeLogger,
      }),
    ).rejects.toMatchObject({ code: "handbook_unavailable" });

    const dartInjection = await resolveReviewInjection({
      reviewType: "handbook",
      config,
      changedFiles: ["lib/main.dart"],
      knowledgeDir: materialized.knowledgeDir,
      snapshot,
      logger: fakeLogger,
    });
    expect(dartInjection!.files).toEqual(["docs/02-flutter.md"]);
  });

  test("ref change → refetch under the new ref (and env override feeds the ref)", async () => {
    const cacheDir = makeCacheDir();
    const first = makeFetcher({
      [`${SKILL_REF}/skills/code-review/SKILL.md`]: "# v1",
      [`${HANDBOOK_SHA}/docs/standards.md`]: "# Standards",
    });
    await ensureKnowledgeSources(makeConfig(SKILL_REF, HANDBOOK_SHA), fakeLogger, { cacheDir, fetcher: first });

    // Env override is part of the per-source spec.
    const specs = knowledgeSpecsFromConfig(makeConfig(), { KNOWLEDGE_SKILL_REF: SKILL_REF_B } as NodeJS.ProcessEnv);
    expect(specs.skill.refOverride).toBe(SKILL_REF_B);

    const configB = makeConfig(SKILL_REF_B, HANDBOOK_SHA);
    const second = makeFetcher({
      [`${SKILL_REF_B}/skills/code-review/SKILL.md`]: "# v2",
      [`${HANDBOOK_SHA}/docs/standards.md`]: "# Standards",
    });
    const snapshot2 = await ensureKnowledgeSources(configB, fakeLogger, { cacheDir, fetcher: second });
    expect(snapshot2.skill.ref).toBe(SKILL_REF_B);
    expect(snapshot2.skill.files[0]!.sha256).toBe(sha256Hex("# v2"));
    // Old ref entry is untouched (immutable per-ref trees).
    expect(existsSync(join(cacheDir, "skill", SKILL_REF, "skills/code-review/SKILL.md"))).toBe(true);

    // Third run under ref B hits the cache.
    const third = makeFetcher({});
    const snapshot3 = await ensureKnowledgeSources(configB, fakeLogger, { cacheDir, fetcher: third });
    expect(third.calls).toHaveLength(0);
    expect(snapshot3.skill.ref).toBe(SKILL_REF_B);
  });

  test("oversized content → rejected → unavailable (no fallback content)", async () => {
    const cacheDir = makeCacheDir();
    const fetcher = makeFetcher(
      {
        [`${SKILL_REF}/skills/code-review/SKILL.md`]: "x".repeat(300_000), // > skill maxBytes
        [`${HANDBOOK_SHA}/docs/big.md`]: "y".repeat(3_000_000), // > handbook maxBytes
      },
      { main: HANDBOOK_SHA },
    );
    const snapshot = await ensureKnowledgeSources(makeConfig(), fakeLogger, { cacheDir, fetcher });
    expect(snapshot.skill.status).toBe("unavailable");
    expect(snapshot.skill.dir).toBeNull();
    expect(snapshot.skill.files).toEqual([]);
    expect(snapshot.handbook.status).toBe("unavailable");
    expect(snapshot.handbook.dir).toBeNull();
    expect(snapshot.handbook.files).toEqual([]);
  });

  test("fetch failure (network down) → unavailable, worker must not crash", async () => {
    const cacheDir = makeCacheDir();
    const failing: KnowledgeFetcher = async () => {
      throw new Error("network down");
    };
    const snapshot = await ensureKnowledgeSources(makeConfig(), fakeLogger, { cacheDir, fetcher: failing });
    expect(snapshot.skill.status).toBe("unavailable");
    expect(snapshot.handbook.status).toBe("unavailable");
  });

  test("unavailable skill source → skill reviews fail fast, never fall back to a local playbook", async () => {
    const cacheDir = makeCacheDir();
    const failing: KnowledgeFetcher = async () => {
      throw new Error("network down");
    };
    const snapshot = await ensureKnowledgeSources(makeConfig(), fakeLogger, { cacheDir, fetcher: failing });
    expect(snapshot.skill.status).toBe("unavailable");
    await expect(
      resolveReviewInjection({
        reviewType: "skill",
        config: makeConfig(),
        changedFiles: [],
        knowledgeDir: join(cacheDir, "knowledge"),
        snapshot,
        logger: fakeLogger,
      }),
    ).rejects.toMatchObject({ code: "skill_playbook_unavailable" });
  });

  test("concurrent ensure calls resolve once (shared initialization)", async () => {
    const cacheDir = makeCacheDir();
    const fetcher1 = makeFetcher({
      [`${SKILL_REF}/skills/code-review/SKILL.md`]: "# concurrent",
      [`${HANDBOOK_SHA}/docs/standards.md`]: "# Standards",
    });
    const fetcher2 = makeFetcher({ [`${SKILL_REF}/skills/code-review/SKILL.md`]: "# concurrent" });
    const [a, b] = await Promise.all([
      ensureKnowledgeSources(makeConfig(SKILL_REF, HANDBOOK_SHA), fakeLogger, { cacheDir, fetcher: fetcher1 }),
      // Same cache dir → shares the first caller's initialization; the second
      // fetcher instance must never be called.
      ensureKnowledgeSources(makeConfig(SKILL_REF, HANDBOOK_SHA), fakeLogger, { cacheDir, fetcher: fetcher2 }),
    ]);
    expect(a.skill.ref).toBe(SKILL_REF);
    expect(b.skill.ref).toBe(SKILL_REF);
    expect(fetcher2.calls).toHaveLength(0);
  });
});

describe("per-review knowledge snapshot (§4)", () => {
  const prisma = getPrisma();
  let reviewId: string;

  beforeAll(async () => {
    // FK-safe delete order (mirrors test/review-ingestion.test.ts).
    await prisma.webhookDelivery.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.reviewStateTransition.deleteMany();
    await prisma.reviewJob.deleteMany();
    await prisma.reviewComment.deleteMany();
    await prisma.reviewWorkspace.deleteMany();
    await prisma.findingStatusTransition.deleteMany();
    await prisma.finding.deleteMany();
    await prisma.commandExecutionAudit.deleteMany();
    await prisma.evaluationRun.deleteMany();
    await prisma.review.deleteMany();
    await prisma.pullRequest.deleteMany();
    await prisma.repository.deleteMany();
    await prisma.installation.deleteMany();
  });

  test("materialize copies sources into the workspace and persists the snapshot", async () => {
    const cacheDir = makeCacheDir();
    const fetcher = makeFetcher(
      {
        [`${SKILL_REF}/skills/code-review/SKILL.md`]: "# skill\n\nPlaybook body.",
        [`${HANDBOOK_SHA}/docs/standards.md`]: "# Standards\n\nBe excellent to each other.",
      },
      { main: HANDBOOK_SHA },
    );
    const snapshot = await ensureKnowledgeSources(makeConfig(), fakeLogger, { cacheDir, fetcher });
    setKnowledgeSnapshot(snapshot);

    const pr = await prisma.pullRequest.create({
      data: {
        repository: {
          create: {
            githubRepositoryId: 99001n,
            installation: { create: { githubInstallationId: 99001n, organization: "acme" } },
            fullName: "acme/knowledge-repo",
          },
        },
        githubPrNumber: 7,
        headSha: "a".repeat(40),
      },
    });
    const review = await prisma.review.create({
      data: {
        pullRequestId: pr.id,
        githubInstallationId: 99001n,
        githubRepositoryId: 99001n,
        pullRequestNumber: 7,
        headSha: "a".repeat(40),
        trigger: "opened",
        reviewType: "skill",
        reviewMode: "adaptive",
      },
    });
    reviewId = review.id;
    const workspacePath = mkdtempSync(join(tmpdir(), "ws-knowledge-"));
    tempDirs.push(workspacePath);

    const result = await materializeReviewKnowledge({
      reviewId,
      reviewType: "skill",
      workspacePath,
      snapshot,
      prisma,
      logger: fakeLogger,
    });
    expect(result.knowledgeDir).toBe(join(workspacePath, "knowledge"));

    const copied = await fsp.readFile(
      join(workspacePath, "knowledge", "skill", "skills", "code-review", "SKILL.md"),
      "utf8",
    );
    expect(copied).toBe("# skill\n\nPlaybook body.");

    const stored = await prisma.review.findUniqueOrThrow({
      where: { id: reviewId },
      select: { knowledgeSnapshot: true },
    });
    const persisted = stored.knowledgeSnapshot as {
      skill?: { ref: string; contentHash: string; files: Array<{ path: string; sha256: string }> };
    };
    expect(persisted.skill!.ref).toBe(SKILL_REF);
    expect(persisted.skill!.contentHash).toBe(snapshot.skill.contentHash);
    expect(persisted.skill!.files[0]!.sha256).toBe(sha256Hex("# skill\n\nPlaybook body."));

    // Injection reads ONLY the review's own copy (and its identity matches).
    const injection = await resolveReviewInjection({
      reviewType: "skill",
      config: makeConfig(),
      changedFiles: [],
      knowledgeDir: result.knowledgeDir,
      snapshot,
      logger: fakeLogger,
    });
    expect(injection!.text).toContain("Playbook body.");
    expect(injection!.files).toEqual(["skills/code-review/SKILL.md"]);
    expect(injection!.contentHash).toBe(snapshot.skill.contentHash);
  });

  test("unreproducible persisted snapshot fails fast with KNOWLEDGE_SNAPSHOT_UNAVAILABLE", async () => {
    // Boot snapshot with a DIFFERENT ref/hash than the persisted one.
    const cacheDir = makeCacheDir();
    const fetcher = makeFetcher({ [`${SKILL_REF}/skills/code-review/SKILL.md`]: "# skill" });
    const current = await ensureKnowledgeSources(makeConfig(SKILL_REF), fakeLogger, { cacheDir, fetcher });
    const staleSnapshot = JSON.parse(JSON.stringify(current)) as typeof current;
    staleSnapshot.skill.ref = "e".repeat(40);
    staleSnapshot.skill.contentHash = "deadbeef";
    const workspacePath = mkdtempSync(join(tmpdir(), "ws-stale-"));
    tempDirs.push(workspacePath);
    await expect(
      materializeReviewKnowledge({
        reviewId,
        reviewType: "skill",
        workspacePath,
        snapshot: staleSnapshot,
        prisma,
        logger: fakeLogger,
      }),
    ).rejects.toBeInstanceOf(KnowledgeSnapshotError);
  });

  test("handbook injection applies keyword section selection from the own copy", async () => {
    const handbookText = "# Testing\n\nAlways test your changes.\n\n# Deployment\n\nDeploy carefully.";
    const cacheDir = makeCacheDir();
    const fetcher = makeFetcher(
      {
        [`${SKILL_REF}/skills/code-review/SKILL.md`]: "# skill",
        [`${HANDBOOK_SHA}/docs/standards.md`]: handbookText,
      },
      { main: HANDBOOK_SHA },
    );
    const snapshot = await ensureKnowledgeSources(makeConfig(), fakeLogger, { cacheDir, fetcher });

    expect(selectHandbookSections(handbookText, ["src/index.test.ts"], 5000)).toContain("Always test your changes.");

    const workspacePath = mkdtempSync(join(tmpdir(), "ws-handbook-"));
    tempDirs.push(workspacePath);
    let captured: unknown = null;
    const materialized = await materializeReviewKnowledge({
      reviewId: "materialize-only-no-row",
      reviewType: "handbook",
      workspacePath,
      snapshot,
      prisma: {
        review: {
          findUnique: async () => ({ knowledgeSnapshot: null }),
          update: async (args: { data: { knowledgeSnapshot: object } }) => {
            // Materialize-only: just capture the would-be persistence.
            captured = args.data.knowledgeSnapshot;
            return {};
          },
        },
      } as unknown as typeof prisma,
      logger: fakeLogger,
    });
    expect(materialized.knowledgeDir).toBe(join(workspacePath, "knowledge"));
    const capturedSnapshot = captured as { handbook?: { ref: string; contentHash: string } };
    expect(capturedSnapshot.handbook!.ref).toBe(HANDBOOK_SHA);
    const injection = await resolveReviewInjection({
      reviewType: "handbook",
      config: makeConfig(),
      changedFiles: ["src/index.test.ts"],
      knowledgeDir: materialized.knowledgeDir,
      snapshot,
      logger: fakeLogger,
    });
    expect(injection!.label).toBe("handbook standards");
    expect(injection!.files).toEqual(["docs/standards.md"]);
    expect(injection!.text).toContain("Always test your changes.");
  });

  test("unavailable handbook snapshot fails fast with HANDBOOK_UNAVAILABLE", async () => {
    const cacheDir = makeCacheDir();
    const fetcher = makeFetcher({}, { main: HANDBOOK_SHA }); // no handbook files → unavailable
    const snapshot = await ensureKnowledgeSources(makeConfig(), fakeLogger, { cacheDir, fetcher });
    expect(snapshot.handbook.status).toBe("unavailable");
    await expect(
      resolveReviewInjection({
        reviewType: "handbook",
        config: makeConfig(),
        changedFiles: [],
        knowledgeDir: join(cacheDir, "knowledge"),
        snapshot,
        logger: fakeLogger,
      }),
    ).rejects.toMatchObject({ code: "handbook_unavailable" });
  });

  test("handbook injection carries selection metrics; persistKnowledgeMetrics stores them additively", async () => {
    const handbookText = "# Testing\n\nAlways test your changes.\n\n# Deployment\n\nDeploy carefully.";
    const cacheDir = makeCacheDir();
    const fetcher = makeFetcher(
      {
        [`${SKILL_REF}/skills/code-review/SKILL.md`]: "# skill",
        [`${HANDBOOK_SHA}/docs/standards.md`]: handbookText,
      },
      { main: HANDBOOK_SHA },
    );
    const snapshot = await ensureKnowledgeSources(makeConfig(), fakeLogger, { cacheDir, fetcher });

    const workspacePath = mkdtempSync(join(tmpdir(), "ws-handbook-metrics-"));
    tempDirs.push(workspacePath);
    const pr = await prisma.pullRequest.create({
      data: {
        repository: {
          create: {
            githubRepositoryId: 99002n,
            installation: { create: { githubInstallationId: 99002n, organization: "acme" } },
            fullName: "acme/knowledge-metrics-repo",
          },
        },
        githubPrNumber: 8,
        headSha: "b".repeat(40),
      },
    });
    const review = await prisma.review.create({
      data: {
        pullRequestId: pr.id,
        githubInstallationId: 99002n,
        githubRepositoryId: 99002n,
        pullRequestNumber: 8,
        headSha: "b".repeat(40),
        trigger: "opened",
        reviewType: "handbook",
        reviewMode: "adaptive",
      },
    });
    const materialized = await materializeReviewKnowledge({
      reviewId: review.id,
      reviewType: "handbook",
      workspacePath,
      snapshot,
      prisma,
      logger: fakeLogger,
    });
    const injection = await resolveReviewInjection({
      reviewType: "handbook",
      config: makeConfig(),
      changedFiles: ["src/index.test.ts"],
      knowledgeDir: materialized.knowledgeDir,
      snapshot,
      logger: fakeLogger,
    });
    expect(injection!.metrics).toMatchObject({
      injectedTokens: expect.any(Number),
      documentsRetrieved: 1,
      candidates: 1,
      relevant: 1,
      selected: 1,
      truncated: false,
    });
    expect(injection!.metrics!.injectedTokens).toBeGreaterThan(0);
    expect(injection!.laterStagesText).toContain("docs/standards.md");
    // Later stages re-provide the authoritative handbook (they do not share
    // context with the analysis stage), so the guideline text is expected.
    expect(injection!.laterStagesText).toContain("Always test your changes.");

    await persistKnowledgeMetrics(prisma, review.id, "handbook", injection!.metrics!);
    const stored = await prisma.review.findUniqueOrThrow({
      where: { id: review.id },
      select: { knowledgeSnapshot: true },
    });
    const persisted = stored.knowledgeSnapshot as {
      handbook?: { ref: string };
      metrics?: { source: string; injectedTokens: number; truncated: boolean };
    };
    expect(persisted.metrics!.source).toBe("handbook");
    expect(persisted.metrics!.injectedTokens).toBe(injection!.metrics!.injectedTokens);
    expect(persisted.metrics!.truncated).toBe(false);
    // Additive merge: the snapshot identity is untouched.
    expect(persisted.handbook!.ref).toBe(HANDBOOK_SHA);
  });
});

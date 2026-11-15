import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { reviewConfigSchema, type ReviewConfig } from "../../src/contracts/config.js";
import {
  computeFindingFingerprint,
  normalizeTextSignature,
  normalizeCodeIdentity,
  validateFindings,
  persistReviewFindings,
  supersedeFindingsForReview,
  getFindingsForReview,
  createFindingsDependencies,
} from "../../src/modules/findings/index.js";
import type { Finding, FindingEvidence } from "../../src/modules/review/index.js";
import { defined, first } from "../helpers/assert.js";
import { prisma, disconnectDatabase } from "../helpers/db.js";

const findingsDependencies = createFindingsDependencies(prisma);

/**
 * Ticket 08 integration tests: finding validation, verification,
 * fingerprinting, deduplication and lifecycle (ARCHITECTURE.md §6.3–§6.4,
 * §7.1–§7.3, §13.1).
 *
 * Lifecycle tests run against Postgres; the "multi-commit" history is driven
 * by evolving the workspace file content (line shifts + fixes) across
 * successive review rows, mirroring ticket 04's base→head commit walk.
 */

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";

const REPO_FULL_NAME = "fixture/findings-repo";
const INSTALLATION_ID = 77_008n;
const GITHUB_REPO_ID = 88_123n;
const PR_NUMBER = 7;

function makeConfig(overrides: Record<string, unknown> = {}): ReviewConfig {
  return reviewConfigSchema.parse({
    schemaVersion: 1,
    github: { organization: "fixture-org" },
    provider: {
      baseURL: "https://llm.example.test/compat",
      apiKeyEnv: "MODEL_API_KEY",
      model: "workers-ai/@cf/zai-org/glm-4.7-flash",
    },
    ...overrides,
  });
}

// Workspace fixture -------------------------------------------------------------
// A small file the findings anchor against. `appSource` is mutated between
// "commits" to drive line movement and fixes.

const APP_V1 = [
  "const x = require('x');",
  "function broken(a, b) {",
  "  return a + b; // fine",
  "}",
  "",
  "function unused() {",
  "  return 1;",
  "}",
].join("\n");

let workspacePath: string;
let appSource: string;

async function writeWorkspace(): Promise<void> {
  workspacePath = await fsp.mkdtemp(path.join(os.tmpdir(), "findings-ws-"));
  appSource = APP_V1;
  await fsp.mkdir(path.join(workspacePath, "src"), { recursive: true });
  await fsp.writeFile(path.join(workspacePath, "src", "app.js"), appSource + "\n", "utf-8");
  await fsp.writeFile(path.join(workspacePath, "src", "helper.js"), "export const help = () => 0;\n", "utf-8");
}

function evidence(partial: Partial<FindingEvidence> = {}): FindingEvidence[] {
  return [
    {
      file: "src/app.js",
      line: 2,
      excerpt: "function broken(a, b) {",
      reason: "the function shown is the one with the issue",
      ...partial,
    },
  ];
}

let findingSeq = 0;
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  findingSeq += 1;
  return {
    category: "maintainability",
    severity: "medium",
    confidence: 0.9,
    title: `Issue ${findingSeq}`,
    file: "src/app.js",
    line: 2,
    description: "the broken function has a real problem",
    evidence: evidence(),
    verified: false, // agent's flag must be ignored by validation
    ...overrides,
  };
}

// Database helpers ----------------------------------------------------------------

async function cleanDatabase(): Promise<void> {
  await prisma.findingStatusTransition.deleteMany();
  await prisma.finding.deleteMany();
  await prisma.reviewWorkspace.deleteMany();
  await prisma.reviewStateTransition.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.reviewJob.deleteMany();
  await prisma.reviewComment.deleteMany();
  await prisma.review.deleteMany();
  await prisma.pullRequest.deleteMany();
  await prisma.repository.deleteMany();
  await prisma.installation.deleteMany();
}

let shaSeq = 0;

/** Seed Installation → Repository → PullRequest → one Review ("a commit"). */
async function seedReview(headLabel: string): Promise<string> {
  shaSeq += 1;
  const headSha = `sha-${shaSeq.toString().padStart(3, "0")}-${headLabel}`;
  const installation = await prisma.installation.upsert({
    where: { githubInstallationId: INSTALLATION_ID },
    create: { githubInstallationId: INSTALLATION_ID, organization: "fixture-owner", status: "active" },
    update: {},
  });
  const repository = await prisma.repository.upsert({
    where: { githubRepositoryId: GITHUB_REPO_ID },
    create: {
      githubRepositoryId: GITHUB_REPO_ID,
      installationId: installation.id,
      fullName: REPO_FULL_NAME,
      defaultBranch: "main",
      status: "active",
    },
    update: {},
  });
  const pullRequest = await prisma.pullRequest.upsert({
    where: { repositoryId_githubPrNumber: { repositoryId: repository.id, githubPrNumber: PR_NUMBER } },
    create: { repositoryId: repository.id, githubPrNumber: PR_NUMBER, status: "open", headSha },
    update: {},
  });
  const review = await prisma.review.create({
    data: {
      pullRequestId: pullRequest.id,
      githubInstallationId: INSTALLATION_ID,
      githubRepositoryId: GITHUB_REPO_ID,
      pullRequestNumber: PR_NUMBER,
      headSha,
      state: "queued",
      trigger: "opened",
    },
  });
  return review.id;
}

async function persist(
  reviewId: string,
  findings: Finding[],
  uncertainFindings: Finding[] = [],
  config: ReviewConfig = makeConfig(),
) {
  return persistReviewFindings({
    repositoryId: (await prisma.repository.findFirstOrThrow({ where: { fullName: REPO_FULL_NAME } })).id,
    repositoryFullName: REPO_FULL_NAME,
    reviewId,
    workspacePath,
    findings,
    uncertainFindings,
    config,
    dependencies: findingsDependencies,
  });
}

const bugRiskFinding = (extra: Partial<Finding> = {}) =>
  makeFinding({ description: "the broken function has a real problem", ...extra });

// Tests ----------------------------------------------------------------------------

beforeAll(async () => {
  await writeWorkspace();
});

afterAll(async () => {
  await fsp.rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  await disconnectDatabase();
});

afterEach(async () => {
  await cleanDatabase();
});

describe("text normalization", () => {
  test("description signature is case/punctuation/stopword/order insensitive", () => {
    const a = normalizeTextSignature("The broken function may cause a problem!");
    const b = normalizeTextSignature("problem... cause the FUNCTION broken");
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  test("code identity collapses whitespace but keeps the code tokens", () => {
    expect(normalizeCodeIdentity("  function  broken( a, b ) {\n")).toBe("function  broken( a, b ) {");
    // comment-only noise is dropped
    expect(normalizeCodeIdentity("// note\nreturn 1;")).toBe("return 1;");
  });
});

describe("fingerprinting (§7.3)", () => {
  test("same issue with unchanged code keeps the fingerprint across line movement and rewording", () => {
    const before = makeFinding({ line: 2, description: "the broken function has a real problem" });
    const after = makeFinding({
      line: 9, // shifted lines
      description: "Real problem in broken function",
      evidence: evidence({ line: 9 }),
    });
    expect(computeFindingFingerprint(before, REPO_FULL_NAME)).toBe(computeFindingFingerprint(after, REPO_FULL_NAME));
  });

  test("fingerprints include the repository and category", () => {
    const f = makeFinding();
    expect(computeFindingFingerprint(f, "org/repo")).not.toBe(computeFindingFingerprint(f, "org/other"));
    expect(computeFindingFingerprint(f, "org/repo")).not.toBe(
      computeFindingFingerprint({ ...f, category: "security" }, "org/repo"),
    );
  });

  test("fingerprints are opaque and stable in format", () => {
    const fp = computeFindingFingerprint(makeFinding(), REPO_FULL_NAME);
    expect(fp).toMatch(/^fp1:[0-9a-f]{64}$/);
  });

  test("different issues produce different fingerprints even at the same location", () => {
    const a = makeFinding({ description: "the broken function has a real problem" });
    const b = makeFinding({ description: "unused helper should be removed", category: "maintainability" });
    expect(computeFindingFingerprint(a, REPO_FULL_NAME)).not.toBe(computeFindingFingerprint(b, REPO_FULL_NAME));
  });

  test("changed code identity changes the fingerprint (the defect itself changed)", () => {
    const a = makeFinding({ evidence: evidence({ excerpt: "function broken(a, b) {" }) });
    const b = makeFinding({ evidence: evidence({ excerpt: "function fixed(a, b) {" }) });
    expect(computeFindingFingerprint(a, REPO_FULL_NAME)).not.toBe(computeFindingFingerprint(b, REPO_FULL_NAME));
  });
});

describe("validation and independent verification (§6.4, §7.1)", () => {
  test("valid, evidence-anchored findings are verified and separated from uncertain ones", async () => {
    const good = makeFinding({ confidence: 0.9 }); // >= minimumInline (0.85)
    const unsure = makeFinding({
      confidence: 0.5, // >= minimumVerified? no → uncertain
      title: "Maybe issue",
      description: "the broken function has a problem maybe",
      evidence: evidence({ line: 6, excerpt: "function unused() {" }),
    });
    const outcome = await validateFindings(
      workspacePath,
      [
        { finding: good, fingerprint: computeFindingFingerprint(good, REPO_FULL_NAME) },
        { finding: unsure, fingerprint: computeFindingFingerprint(unsure, REPO_FULL_NAME) },
      ],
      makeConfig(),
    );
    expect(outcome.rejected).toHaveLength(0);
    expect(outcome.verified).toHaveLength(1);
    expect(first(outcome.verified).finding.title).toBe(good.title);
    expect(outcome.uncertain).toHaveLength(1);
    expect(first(outcome.uncertain).finding.title).toBe(unsure.title);
  });

  test("confidence below minimumVerified but above anchoring is uncertain, not verified", async () => {
    const borderline = makeFinding({
      confidence: 0.82, // ≥ minimumVerified (0.8) but < minimumInline (0.85)
      evidence: evidence({ excerpt: "function unused() {", line: 6 }),
      description: "the unused function should be removed",
    });
    const outcome = await validateFindings(
      workspacePath,
      [{ finding: borderline, fingerprint: computeFindingFingerprint(borderline, REPO_FULL_NAME) }],
      makeConfig(),
    );
    expect(outcome.rejected).toHaveLength(0);
    expect(outcome.verified).toHaveLength(0);
    expect(outcome.uncertain).toHaveLength(1);
    expect(first(outcome.uncertain).verified).toBe(true);
  });

  test("the agent's self-reported verified flag and confidence are ignored", async () => {
    // Claims verified:true with high confidence, but the excerpt does not exist
    // in the workspace — must be demoted to uncertain, never published verified.
    const liar = makeFinding({
      confidence: 0.99,
      verified: true,
      description: "a fabricated claim about missing code",
      evidence: evidence({ excerpt: "totally absent function body() {", line: 2 }),
    });
    const outcome = await validateFindings(
      workspacePath,
      [{ finding: liar, fingerprint: computeFindingFingerprint(liar, REPO_FULL_NAME) }],
      makeConfig(),
    );
    expect(outcome.verified).toHaveLength(0);
    expect(outcome.rejected).toHaveLength(0);
    expect(outcome.uncertain).toHaveLength(1);
    expect(first(outcome.uncertain).verified).toBe(false);
  });

  test("invalid findings are rejected with the right reason and never verified", async () => {
    const cases: Array<[Finding, string]> = [
      [makeFinding({ file: "src/missing.js", evidence: evidence({ file: "src/app.js" }) }), "invalid_file"],
      [makeFinding({ line: 999 }), "invalid_line"],
      [makeFinding({ line: 0 }), "invalid_line"],
      [makeFinding({ evidence: [] }), "missing_evidence"],
      [makeFinding({ category: "bug_risk" as Finding["category"] }), "invalid_category"],
      [makeFinding({ severity: "catastrophic" as Finding["severity"] }), "unsupported_severity"],
      [makeFinding({ confidence: 1.5 }), "invalid_confidence"],
      [makeFinding({ confidence: Number.NaN }), "invalid_confidence"],
      [makeFinding({ description: "   " }), "empty_description"],
      [makeFinding({ evidence: evidence({ file: "src/nope.js" }) }), "invalid_evidence_file"],
    ];
    const outcome = await validateFindings(
      workspacePath,
      cases.map(([finding]) => ({ finding, fingerprint: computeFindingFingerprint(finding, REPO_FULL_NAME) })),
      makeConfig(),
    );
    expect(outcome.rejected.map((r) => r.reason).sort()).toEqual(cases.map(([, reason]) => reason).sort());
    expect(outcome.verified).toHaveLength(0);
    expect(outcome.uncertain).toHaveLength(0);
    for (const r of outcome.rejected) {
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });

  test("severity not enabled in configuration is rejected", async () => {
    const config = makeConfig({ review: { severity: ["critical", "high"] } });
    const f = makeFinding({ severity: "low", description: "a low severity issue exists here" });
    const outcome = await validateFindings(
      workspacePath,
      [{ finding: f, fingerprint: computeFindingFingerprint(f, REPO_FULL_NAME) }],
      config,
    );
    expect(outcome.rejected.map((r) => r.reason)).toEqual(["unsupported_severity"]);
  });

  test("line-anchored evidence pointing past the file is not verified", async () => {
    const f = makeFinding({ evidence: evidence({ line: 500 }) });
    const outcome = await validateFindings(
      workspacePath,
      [{ finding: f, fingerprint: computeFindingFingerprint(f, REPO_FULL_NAME) }],
      makeConfig(),
    );
    expect(outcome.verified).toHaveLength(0);
    expect(outcome.uncertain).toHaveLength(1);
  });
});

describe("persistence: store-only-valid contract", () => {
  test("only valid findings are persisted; rejected ones are reported back", async () => {
    const reviewId = await seedReview("review-1");
    const valid = makeFinding();
    const bad = makeFinding({ file: "src/ghost.js", title: "Ghost", description: "a ghost file issue" });
    const result = await persistReviewFindings({
      repositoryId: (await prisma.repository.findFirstOrThrow({ where: { fullName: REPO_FULL_NAME } })).id,
      repositoryFullName: REPO_FULL_NAME,
      reviewId,
      workspacePath,
      findings: [valid],
      uncertainFindings: [bad],
      config: makeConfig(),
      dependencies: findingsDependencies,
    });
    expect(result.rejected.map((r) => r.reason)).toEqual(["invalid_file"]);
    const rows = await getFindingsForReview(reviewId, findingsDependencies);
    expect(rows).toHaveLength(1);
    expect(first(rows).title).toBe(valid.title);
    expect(result.stored).toHaveLength(1);
  });

  test("uncertain findings are stored with lifecycle status uncertain, separated from verified", async () => {
    const reviewId = await seedReview("review-unc");
    const verified = makeFinding();
    const unsure = makeFinding({
      confidence: 0.4,
      title: "Unsure",
      description: "maybe the unused helper matters",
      evidence: evidence({ line: 6, excerpt: "function unused() {" }),
    });
    const result = await persist(reviewId, [verified], [unsure]);
    const rows = await getFindingsForReview(reviewId, findingsDependencies);
    expect(rows).toHaveLength(2);
    const unsureRow = rows.find((r) => r.title === "Unsure");
    expect(unsureRow?.status).toBe("uncertain");
    expect(unsureRow?.verified).toBe(false);
    expect(rows.find((r) => r.title === verified.title)?.status).toBe("new");
    // uncertain findings still get a transition record
    const transitions = await prisma.findingStatusTransition.findMany();
    expect(transitions).toHaveLength(result.transitions);
  });
});

describe("lifecycle across commits (§7.2)", () => {
  test("unchanged issue → existing; changed lines/severity → updated; removed issue → resolved; reintroduced → reopened", async () => {
    // Commit 1: issues A and B are first seen.
    const review1 = await seedReview("c1");
    const a1 = bugRiskFinding({ title: "A" });
    const b = makeFinding({
      title: "B",
      line: 6,
      description: "the unused function should be removed",
      evidence: evidence({ line: 6, excerpt: "function unused() {" }),
    });
    const r1 = await persist(review1, [a1, b]);
    expect(r1.stored.map((s) => s.status)).toEqual(["new", "new"]);
    expect(r1.resolved).toEqual([]);

    // Commit 2: A unchanged → existing; B gone → resolved.
    const review2 = await seedReview("c2");
    const a2 = bugRiskFinding({ title: "A" });
    const r2 = await persist(review2, [a2]);
    const aStatus2 = first(r2.stored).status;
    expect(aStatus2).toBe("existing");
    expect(r2.resolved).toHaveLength(1);
    const bRow = await prisma.finding.findFirst({ where: { title: "B" } });
    expect(bRow?.status).toBe("resolved");
    const bTransitions = await prisma.findingStatusTransition.findMany({ where: { findingId: defined(bRow).id } });
    expect(bTransitions.some((t) => t.toStatus === "resolved" && t.fromStatus === "new")).toBe(true);

    // Commit 3: A moves lines → updated.
    await fsp.writeFile(
      path.join(workspacePath, "src", "app.js"),
      "// shifted\nconst x = require('x');\n\nfunction broken(a, b) {\n  return a + b;\n}\n\nfunction unused() {\n  return 1;\n}\n",
      "utf-8",
    );
    const review3 = await seedReview("c3");
    const a3 = bugRiskFinding({
      title: "A",
      line: 4,
      evidence: evidence({ line: 4, excerpt: "function broken(a, b) {" }),
    });
    const r3 = await persist(review3, [a3]);
    expect(first(r3.stored).status).toBe("updated");

    // Commit 4: A fixed → resolved.
    await fsp.writeFile(
      path.join(workspacePath, "src", "app.js"),
      "// shifted\nconst x = require('x');\n\nfunction broken(a, b) {\n  return a + b; // fixed now\n}\n\nfunction unused() {\n  return 1;\n}\n",
      "utf-8",
    );
    const review4 = await seedReview("c4");
    const r4 = await persist(review4, []);
    expect(r4.resolved).toHaveLength(1);
    const aRow = await prisma.finding.findFirst({ where: { title: "A", reviewId: review3 } });
    expect(aRow?.status).toBe("resolved");

    // Commit 5: A reintroduced → status new + reopen link + reopen transition.
    await fsp.writeFile(
      path.join(workspacePath, "src", "app.js"),
      "// shifted\nconst x = require('x');\n\nfunction broken(a, b) {\n  return a + b;\n}\n\nfunction unused() {\n  return 1;\n}\n",
      "utf-8",
    );
    const review5 = await seedReview("c5");
    const a5 = bugRiskFinding({
      title: "A",
      line: 4,
      evidence: evidence({ line: 4, excerpt: "function broken(a, b) {" }),
    });
    const r5 = await persist(review5, [a5]);
    expect(r5.stored).toHaveLength(1);
    expect(first(r5.stored).status).toBe("new");
    expect(first(r5.stored).reopened).toBe(true);
    const newA = await prisma.finding.findFirstOrThrow({ where: { title: "A", reviewId: review5 } });
    expect(newA.reopenedFromFindingId).toBe(defined(aRow).id);
    const reopenTransition = await prisma.findingStatusTransition.findFirst({
      where: { findingId: newA.id, toStatus: "new" },
    });
    expect(reopenTransition?.reason).toContain("reopened");
  });

  test("duplicate findings within one review are deduped to the highest-confidence occurrence", async () => {
    const reviewId = await seedReview("dup");
    const primary = bugRiskFinding({ title: "dup-1", confidence: 0.86, line: 2 });
    const twin = bugRiskFinding({ title: "dup-2", confidence: 0.95, line: 3 });
    const result = await persist(reviewId, [primary, twin]);
    expect(result.stored).toHaveLength(1);
    expect(first(result.stored).title).toBe("dup-2"); // highest confidence wins
    const rows = await getFindingsForReview(reviewId, findingsDependencies);
    expect(rows).toHaveLength(1);
    expect(result.transitions).toBe(1);
  });

  test("previously uncertain finding that is now verified is promoted with a transition", async () => {
    const config = makeConfig();
    const review1 = await seedReview("u1");
    const unsure = makeFinding({
      title: "Maybe",
      confidence: 0.5,
      description: "maybe the unused helper matters",
      evidence: evidence({ line: 6, excerpt: "function unused() {" }),
    });
    await persist(review1, [], [unsure], config);

    const review2 = await seedReview("u2");
    const nowSure = makeFinding({
      title: "Maybe",
      confidence: 0.9,
      description: "maybe the unused helper matters",
      evidence: evidence({ line: 6, excerpt: "function unused() {" }),
    });
    const r2 = await persist(review2, [nowSure], [], config);
    expect(first(r2.stored).status).toBe("new");
    const transition = await prisma.findingStatusTransition.findFirst({
      where: { reviewId: review2, toStatus: "new" },
    });
    expect(transition?.reason).toContain("uncertain");
  });

  test("lifecycle tracking can be disabled via configuration", async () => {
    const config = makeConfig({ review: { findings: { trackAcrossCommits: false, lifecycleManagement: false } } });
    const review1 = await seedReview("off1");
    await persist(review1, [bugRiskFinding({ title: "A" })], [], config);

    const review2 = await seedReview("off2");
    const r2 = await persist(review2, [bugRiskFinding({ title: "A" })], [], config);
    expect(first(r2.stored).status).toBe("new"); // history skipped → always new
    expect(r2.resolved).toEqual([]);
  });

  test("resolves transition history is fully persisted for every status change", async () => {
    const review1 = await seedReview("t1");
    await persist(review1, [bugRiskFinding({ title: "A" })]);
    const row = await prisma.finding.findFirstOrThrow({ where: { title: "A" } });
    const transitions = await prisma.findingStatusTransition.findMany({ where: { findingId: row.id } });
    expect(transitions).toHaveLength(1);
    expect(first(transitions).fromStatus).toBeNull();
    expect(first(transitions).toStatus).toBe("new");
    expect(first(transitions).reviewId).toBe(review1);
  });
});

describe("supersession (ticket 03 integration)", () => {
  test("supersedeFindingsForReview transitions active findings to superseded with a reason", async () => {
    const review1 = await seedReview("sup1");
    await persist(review1, [bugRiskFinding({ title: "A" })]);
    const review2 = await seedReview("sup2");
    const count = await supersedeFindingsForReview(review1, review2, findingsDependencies);
    expect(count).toBe(1);
    const row = await prisma.finding.findFirstOrThrow({ where: { title: "A", reviewId: review1 } });
    expect(row.status).toBe("superseded");
    expect(row.supersededByReviewId).toBe(review2);
    const transition = await prisma.findingStatusTransition.findFirst({
      where: { findingId: row.id, toStatus: "superseded" },
    });
    expect(transition?.fromStatus).toBe("new");
    expect(transition?.reason).toContain(review2);
  });

  test("superseding a review without active findings is a no-op", async () => {
    const reviewId = await seedReview("sup3");
    expect(await supersedeFindingsForReview(reviewId, reviewId, findingsDependencies)).toBe(0);
  });
});

describe("query surface for the publishing layer (ticket 09)", () => {
  test("getFindingsForReview returns only that review's findings, ordered verified first", async () => {
    const review1 = await seedReview("q1");
    const review2 = await seedReview("q2");
    await persist(review1, [bugRiskFinding({ title: "A" })]);
    const unsure = makeFinding({
      title: "Maybe",
      confidence: 0.5,
      description: "maybe the unused helper matters",
      evidence: evidence({ line: 6, excerpt: "function unused() {" }),
    });
    await persist(review2, [bugRiskFinding({ title: "A" })], [unsure]);
    const rows2 = await getFindingsForReview(review2, findingsDependencies);
    expect(rows2).toHaveLength(2);
    expect(first(rows2).verified).toBe(true);
    expect(rows2.every((r) => r.reviewId === review2)).toBe(true);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  persistReviewFindings,
  supersedeFindingsForReview,
  type FindingsRepositories,
  type FindingsServiceDependencies,
  type PersistReviewFindingsInput,
} from "../../src/modules/findings/index.js";
import { createFindingsRepositories } from "../../src/modules/findings/prisma-findings.repository.js";
import { createFindingsDependencies } from "../../src/modules/findings/prisma-findings.unit-of-work.js";
import type { Finding } from "../../src/modules/review/index.js";
import {
  cleanDatabase,
  disconnectDatabase,
  makeFinding,
  makeReviewConfig,
  prisma,
  seedReviewChain,
  writeWorkspace,
  type SeededReviewChain,
  type WorkspaceFixture,
} from "../characterization/support.js";

/**
 * Integration: finding repository and unit of work against real PostgreSQL.
 *
 * The findings boundary is the module's only multi-write transaction for
 * persist and supersede. These tests pin the outcomes the service relies on:
 * every finding + transition write commits, or every write rolls back and no
 * partial lifecycle state survives. Duplicate fingerprints never produce a
 * second durable occurrence.
 */

const config = makeReviewConfig();
const dependencies = createFindingsDependencies(prisma);
const repositories = createFindingsRepositories(prisma);

let workspace: WorkspaceFixture;

function persistInput(
  chain: SeededReviewChain,
  findings: Finding[],
  uncertainFindings: Finding[] = [],
  overrides: Partial<PersistReviewFindingsInput> = {},
): PersistReviewFindingsInput {
  return {
    repositoryId: chain.repositoryId,
    repositoryFullName: chain.repositoryFullName,
    reviewId: chain.reviewId,
    workspacePath: workspace.path,
    findings,
    uncertainFindings,
    config,
    dependencies,
    ...overrides,
  };
}

/**
 * Wrap the real unit of work and replace one repository method, so a write
 * inside the transaction fails after earlier writes succeeded.
 */
function failingDependencies(
  override: (repos: FindingsRepositories) => FindingsRepositories,
): FindingsServiceDependencies {
  return {
    repositories: dependencies.repositories,
    unitOfWork: {
      execute<T>(work: (repos: FindingsRepositories) => Promise<T>): Promise<T> {
        return dependencies.unitOfWork.execute((repos) => work(override(repos)));
      },
    },
  };
}

const brokenFunctionFinding = (overrides: Partial<Finding> = {}) =>
  makeFinding({
    title: "Broken function",
    description: "the broken function has a real problem",
    evidence: [{ file: "src/app.js", line: 2, excerpt: "function broken(a, b) {", reason: "the broken function" }],
    ...overrides,
  });

const unusedHelperFinding = () =>
  makeFinding({
    title: "Unused helper",
    line: 6,
    description: "the unused helper should be removed",
    evidence: [{ file: "src/app.js", line: 6, excerpt: "function unused() {", reason: "the helper is unused" }],
  });

beforeAll(async () => {
  workspace = await writeWorkspace("findings-repository-");
});

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await workspace.remove();
  await cleanDatabase();
  await disconnectDatabase();
});

describe("findings unit of work", () => {
  test("persist commits every finding and transition when the callback succeeds", async () => {
    const chain = await seedReviewChain({ prefix: "findings-repository-persist" });

    const result = await persistReviewFindings(persistInput(chain, [brokenFunctionFinding()]));

    expect(result.stored).toHaveLength(1);
    expect(result.transitions).toBe(1);

    const rows = await repositories.findings.findByReview(chain.reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fingerprint: result.stored[0]?.fingerprint,
      title: "Broken function",
      status: "new",
      verified: true,
      evidence: [{ file: "src/app.js", line: 2, excerpt: "function broken(a, b) {", reason: "the broken function" }],
    });

    const transitions = await prisma.findingStatusTransition.findMany({
      where: { findingId: rows[0]?.id },
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: null, toStatus: "new", reviewId: chain.reviewId });
  });

  test("persist rolls back every finding and transition when a later write fails", async () => {
    const chain = await seedReviewChain({ prefix: "findings-repository-persist-rollback" });
    let creates = 0;
    const failing = failingDependencies((repos) => ({
      ...repos,
      findings: {
        ...repos.findings,
        create: async (input) => {
          creates += 1;
          if (creates === 2) {
            throw new Error("forced finding failure");
          }
          return repos.findings.create(input);
        },
      },
    }));

    await expect(
      persistReviewFindings(
        persistInput(chain, [brokenFunctionFinding(), unusedHelperFinding()], [], { dependencies: failing }),
      ),
    ).rejects.toThrow("forced finding failure");

    expect(await repositories.findings.findByReview(chain.reviewId)).toEqual([]);
    expect(await prisma.findingStatusTransition.count({ where: { reviewId: chain.reviewId } })).toBe(0);
  });

  test("supersede commits every status and transition when the callback succeeds", async () => {
    const first = await seedReviewChain({ prefix: "findings-repository-supersede" });
    const second = await seedReviewChain({ prefix: "findings-repository-supersede-target" });
    await persistReviewFindings(persistInput(first, [brokenFunctionFinding()]));

    const count = await supersedeFindingsForReview(first.reviewId, second.reviewId, dependencies);
    expect(count).toBe(1);

    const rows = await repositories.findings.findByReview(first.reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "superseded", supersededByReviewId: second.reviewId });
    const transitions = await prisma.findingStatusTransition.findMany({
      where: { findingId: rows[0]?.id, toStatus: "superseded" },
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.reason).toContain(second.reviewId);

    // Only active findings are touched: a second supersession is a no-op.
    expect(await supersedeFindingsForReview(first.reviewId, second.reviewId, dependencies)).toBe(0);
  });

  test("supersede rolls back every status and transition when a later write fails", async () => {
    const first = await seedReviewChain({ prefix: "findings-repository-supersede-rollback" });
    const second = await seedReviewChain({ prefix: "findings-repository-supersede-rollback-target" });
    await persistReviewFindings(persistInput(first, [brokenFunctionFinding(), unusedHelperFinding()]));

    const transitionsBefore = await prisma.findingStatusTransition.count({ where: { reviewId: first.reviewId } });
    let superseded = 0;
    const failing = failingDependencies((repos) => ({
      ...repos,
      findings: {
        ...repos.findings,
        markSuperseded: async (input) => {
          superseded += 1;
          if (superseded === 2) {
            throw new Error("forced supersede failure");
          }
          return repos.findings.markSuperseded(input);
        },
      },
    }));

    await expect(supersedeFindingsForReview(first.reviewId, second.reviewId, failing)).rejects.toThrow(
      "forced supersede failure",
    );

    const rows = await repositories.findings.findByReview(first.reviewId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "new")).toBe(true);
    expect(rows.every((row) => row.supersededByReviewId === null)).toBe(true);
    expect(await prisma.findingStatusTransition.count({ where: { reviewId: first.reviewId } })).toBe(transitionsBefore);
    expect(
      await prisma.findingStatusTransition.count({ where: { reviewId: first.reviewId, toStatus: "superseded" } }),
    ).toBe(0);
  });
});

describe("duplicate fingerprints", () => {
  test("the same fingerprint collapses to one durable occurrence and one transition", async () => {
    const chain = await seedReviewChain({ prefix: "findings-repository-duplicate" });
    const duplicate = brokenFunctionFinding();

    const result = await persistReviewFindings(persistInput(chain, [duplicate, { ...duplicate }]));

    expect(result.stored).toHaveLength(1);
    expect(result.transitions).toBe(1);
    const rows = await repositories.findings.findByReview(chain.reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fingerprint).toBe(result.stored[0]?.fingerprint);
    expect(await prisma.findingStatusTransition.count({ where: { reviewId: chain.reviewId } })).toBe(1);

    // Re-persisting the same review + fingerprint cannot add a second row or a
    // dangling transition: the unique key rolls the whole attempt back.
    await expect(persistReviewFindings(persistInput(chain, [duplicate]))).rejects.toThrow();
    expect(await repositories.findings.findByReview(chain.reviewId)).toHaveLength(1);
    expect(await prisma.findingStatusTransition.count({ where: { reviewId: chain.reviewId } })).toBe(1);
  });
});

describe("finding ordering", () => {
  test("findByReview orders verified first, then severity rank, then createdAt", async () => {
    const chain = await seedReviewChain({ prefix: "findings-repository-order" });
    const base = {
      reviewId: chain.reviewId,
      repositoryId: chain.repositoryId,
      category: "maintainability",
      confidence: 0.9,
      filePath: "src/app.js",
      lineNumber: 2,
      description: "ordering fixture",
      evidence: [],
      status: "new" as const,
    };
    const severities = ["informational", "low", "medium", "high", "critical"] as const;
    for (const [index, severity] of severities.entries()) {
      await prisma.finding.create({
        data: {
          ...base,
          fingerprint: `order-${severity}`,
          severity,
          title: severity,
          verified: true,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        },
      });
    }
    // An unverified critical finding is older but must still sort last:
    // verification is the primary key, exactly like the SQL adapter.
    await prisma.finding.create({
      data: {
        ...base,
        fingerprint: "order-unverified-critical",
        severity: "critical",
        title: "unverified critical",
        verified: false,
        createdAt: new Date(Date.UTC(2025, 11, 31)),
      },
    });

    const rows = await repositories.findings.findByReview(chain.reviewId);
    expect(rows.map((row) => `${row.severity}:${row.verified}`)).toEqual([
      "critical:true",
      "high:true",
      "medium:true",
      "low:true",
      "informational:true",
      "critical:false",
    ]);
  });
});

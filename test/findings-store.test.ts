import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { reviewConfigSchema, type ReviewConfig } from "../src/contracts/config.js";
import { persistReviewFindings } from "../src/modules/findings/store.js";
import type { Finding } from "../src/modules/review/index.js";
import { FakeClock } from "./fakes/clock.js";
import { createFakeFindings } from "./fakes/repositories.js";
import { first } from "./helpers/assert.js";

/**
 * Findings lifecycle as a unit test: the real service runs against in-memory
 * repository fakes, so no Postgres row or transaction is involved. The
 * integration suite keeps the Prisma adapter and SQL-level guarantees.
 */

const APP_SOURCE = [
  "const x = require('x');",
  "function broken(a, b) {",
  "  return a + b;",
  "}",
  "function unused() {",
  "  return 1;",
  "}",
].join("\n");

const REPOSITORY_FULL_NAME = "fixture/findings-unit";

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

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    category: "maintainability",
    severity: "medium",
    confidence: 0.9,
    title: "Broken function",
    file: "src/app.js",
    line: 2,
    description: "the function does not handle the documented case",
    evidence: [
      {
        file: "src/app.js",
        line: 2,
        excerpt: "function broken(a, b) {",
        reason: "the evidence is anchored on the implementation",
      },
    ],
    verified: false,
    ...overrides,
  };
}

describe("persistReviewFindings with repository fakes", () => {
  let workspacePath: string;
  let clock: FakeClock;

  beforeEach(async () => {
    workspacePath = await fsp.mkdtemp(path.join(os.tmpdir(), "findings-unit-"));
    await fsp.mkdir(path.join(workspacePath, "src"), { recursive: true });
    await fsp.writeFile(path.join(workspacePath, "src", "app.js"), `${APP_SOURCE}\n`, "utf8");
    clock = new FakeClock("2026-01-01T00:00:00.000Z");
  });

  afterEach(async () => {
    await fsp.rm(workspacePath, { recursive: true, force: true });
  });

  async function persist(
    dependencies: ReturnType<typeof createFakeFindings>,
    reviewId: string,
    findings: Finding[],
    uncertainFindings: Finding[] = [],
  ) {
    return persistReviewFindings({
      repositoryId: "repository-1",
      repositoryFullName: REPOSITORY_FULL_NAME,
      reviewId,
      workspacePath,
      findings,
      uncertainFindings,
      config: makeConfig(),
      dependencies: { repositories: dependencies.repositories, unitOfWork: dependencies.unitOfWork },
    });
  }

  test("persists new then existing findings and resolves a prior that disappears", async () => {
    const dependencies = createFakeFindings({ clock });
    const firstRun = await persist(dependencies, "review-1", [finding()]);
    expect(first(firstRun.stored).status).toBe("new");
    expect(firstRun.transitions).toBe(1);
    expect(dependencies.statusTransitions.transitions).toHaveLength(1);

    clock.advance(60_000);
    const secondRun = await persist(dependencies, "review-2", [finding()]);
    expect(first(secondRun.stored).status).toBe("existing");
    expect(secondRun.transitions).toBe(1);

    clock.advance(60_000);
    const thirdRun = await persist(dependencies, "review-3", []);
    expect(thirdRun.resolved).toEqual([first(secondRun.stored).fingerprint]);
    expect(thirdRun.transitions).toBe(1);
    await expect(dependencies.findings.findByReview("review-2")).resolves.toMatchObject([{ status: "resolved" }]);
  });

  test("stores low-confidence findings as uncertain and never resolves them implicitly", async () => {
    const dependencies = createFakeFindings({ clock });
    const lowConfidence = finding({ confidence: 0.5 });
    const firstRun = await persist(dependencies, "review-1", [], [lowConfidence]);
    expect(first(firstRun.stored).status).toBe("uncertain");
    expect(first(firstRun.stored).verified).toBe(false);

    clock.advance(60_000);
    const secondRun = await persist(dependencies, "review-2", []);
    expect(secondRun.resolved).toEqual([]);
    await expect(dependencies.findings.findByReview("review-1")).resolves.toMatchObject([{ status: "uncertain" }]);
  });

  test("reopens a resolved prior occurrence when the issue is reintroduced", async () => {
    const dependencies = createFakeFindings({ clock });
    const firstRun = await persist(dependencies, "review-1", [finding()]);
    const original = first(firstRun.stored);

    clock.advance(60_000);
    await persist(dependencies, "review-2", []);
    clock.advance(60_000);
    const reopenedRun = await persist(dependencies, "review-3", [finding()]);

    const reopened = first(reopenedRun.stored);
    expect(reopened.status).toBe("new");
    expect(reopened.reopened).toBe(true);
    const transitions = dependencies.statusTransitions.transitions;
    expect(transitions.at(-1)?.reason).toContain(`reopened: reintroduced after resolution of ${original.id}`);
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createReviewConfigStore } from "../../src/config/review-config-store.js";
import { ConfigValidationError } from "../../src/ports/review-config.js";

/**
 * Integration: review-config store boundary.
 *
 * The store owns file reads, validation, and atomic writes; these tests pin the
 * outcomes admin and ingestion depend on without requiring Postgres or Redis.
 */

const ENV = {
  MODEL_BASE_URL: "https://api.example.com/v1",
  MODEL_API_KEY: "test-api-key",
};

interface Fixture {
  dir: string;
  path: string;
  cleanup: () => void;
}

const fixtures: Fixture[] = [];

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: {
      baseURL: "${MODEL_BASE_URL}",
      apiKeyEnv: "MODEL_API_KEY",
      model: "llama-3.3-70b-versatile",
    },
    github: { organization: "acme" },
    ...overrides,
  };
}

function makeFixture(initial: unknown): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "review-config-store-"));
  const path = join(dir, "review.json");
  writeFileSync(path, JSON.stringify(initial, null, 2), "utf8");
  const fixture = { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  fixtures.push(fixture);
  return fixture;
}

beforeEach(() => {
  fixtures.length = 0;
});

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.cleanup();
  }
});

describe("review-config store", () => {
  test("loads and validates the active configuration with a stable snapshot", () => {
    const fixture = makeFixture(validConfig());
    const store = createReviewConfigStore({ path: fixture.path, env: ENV });

    const loaded = store.load();

    expect(loaded.fromLastKnownGood).toBe(false);
    expect(loaded.config.provider.baseURL).toBe(ENV.MODEL_BASE_URL);
    expect(loaded.config.application.name).toBe("ai-pr-reviewer");
    expect(loaded.snapshot.schemaVersion).toBe(1);
    expect(loaded.snapshot.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("validate resolves env references and rejects invalid candidates without writing", () => {
    const fixture = makeFixture(validConfig());
    const store = createReviewConfigStore({ path: fixture.path, env: ENV });
    const before = readFileSync(fixture.path, "utf8");

    const validated = store.validate(validConfig({ github: { organization: "validated" } }));
    expect(validated.config.github.organization).toBe("validated");
    expect(validated.snapshot.hash).toMatch(/^sha256:/);

    expect(() => store.validate({ provider: { apiKey: "sk-live-secret" } })).toThrow(ConfigValidationError);
    expect(() => store.validate(validConfig())).not.toThrow();
    expect(() =>
      createReviewConfigStore({ path: fixture.path, env: { MODEL_API_KEY: "x" } }).validate(validConfig()),
    ).toThrow(/MODEL_BASE_URL/);

    expect(readFileSync(fixture.path, "utf8")).toBe(before);
  });

  test("update writes the active file and last-known-good snapshot atomically", () => {
    const fixture = makeFixture(validConfig());
    const store = createReviewConfigStore({ path: fixture.path, env: ENV });
    const next = validConfig({ github: { organization: "next-org" } });

    const result = store.update(next);

    expect(result.previous.config.github.organization).toBe("acme");
    expect(result.next.config.github.organization).toBe("next-org");
    expect(result.next.snapshot.hash).not.toBe(result.previous.snapshot.hash);
    expect(JSON.parse(readFileSync(fixture.path, "utf8"))).toMatchObject({ github: { organization: "next-org" } });
    expect(store.lastKnownGoodStatus()).toBe("available");
    expect(JSON.parse(readFileSync(`${fixture.path}.last-known-good.json`, "utf8"))).toMatchObject({
      github: { organization: "next-org" },
    });
  });

  test("update rejects an invalid candidate before touching either file", () => {
    const fixture = makeFixture(validConfig());
    const store = createReviewConfigStore({ path: fixture.path, env: ENV });
    store.update(validConfig());
    const active = readFileSync(fixture.path, "utf8");
    const lastKnownGood = readFileSync(`${fixture.path}.last-known-good.json`, "utf8");

    expect(() => store.update({ schemaVersion: 999 })).toThrow(ConfigValidationError);
    expect(readFileSync(fixture.path, "utf8")).toBe(active);
    expect(readFileSync(`${fixture.path}.last-known-good.json`, "utf8")).toBe(lastKnownGood);
  });

  test("load falls back to last-known-good and restore repairs a broken active file", () => {
    const fixture = makeFixture(validConfig());
    const store = createReviewConfigStore({ path: fixture.path, env: ENV });
    store.update(validConfig({ github: { organization: "restorable" } }));

    writeFileSync(fixture.path, "{ not json", "utf8");

    const fallback = store.load();
    expect(fallback.fromLastKnownGood).toBe(true);
    expect(fallback.config.github.organization).toBe("restorable");

    const restored = store.restoreLastKnownGood();
    expect(restored.fromLastKnownGood).toBe(false);
    expect(restored.config.github.organization).toBe("restorable");
    expect(JSON.parse(readFileSync(fixture.path, "utf8"))).toMatchObject({
      github: { organization: "restorable" },
    });
  });

  test("lastKnownGoodStatus distinguishes missing, unreadable, and available snapshots", () => {
    const fixture = makeFixture(validConfig());
    const store = createReviewConfigStore({ path: fixture.path, env: ENV });

    expect(store.lastKnownGoodStatus()).toBe("missing");

    store.update(validConfig());
    expect(store.lastKnownGoodStatus()).toBe("available");

    writeFileSync(`${fixture.path}.last-known-good.json`, "{ broken", "utf8");
    expect(store.lastKnownGoodStatus()).toBe("unreadable");
  });

  test("redact hides secret-shaped values without mutating the source", () => {
    const fixture = makeFixture(validConfig());
    const store = createReviewConfigStore({ path: fixture.path, env: ENV });
    const source = { provider: { apiKey: "sk-live", nested: { token: "abc" } }, name: "visible" };

    const redacted = store.redact(source);

    expect(redacted).toEqual({
      provider: { apiKey: "[REDACTED]", nested: { token: "[REDACTED]" } },
      name: "visible",
    });
    expect(source.provider.apiKey).toBe("sk-live");
  });
});

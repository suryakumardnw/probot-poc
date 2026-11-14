import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const script = join(process.cwd(), "scripts/security-audit.mjs");

let fixtureDirectory: string;
let fixtureSequence = 0;

beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "security-audit-test-"));
});

afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

async function runAudit(report: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  fixtureSequence += 1;
  const fixture = join(fixtureDirectory, `report-${fixtureSequence}.json`);
  writeFileSync(fixture, JSON.stringify(report));

  try {
    const result = await execFileAsync(process.execPath, [script, fixture]);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function reportWith(vulnerabilities: Record<string, unknown>, totals: Record<string, number>) {
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...totals } },
  };
}

describe("security audit gate", () => {
  test("fails closed when npm audit returns an error payload", async () => {
    const result = await runAudit({ error: { summary: "audit endpoint not reachable" } });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("npm audit failed: audit endpoint not reachable");
  });

  test("fails closed when the payload is not an audit report", async () => {
    const result = await runAudit({});

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not look like an npm audit report");
  });

  test("fails on a high advisory that is not allowlisted", async () => {
    const result = await runAudit(
      reportWith(
        {
          evil: {
            name: "evil",
            severity: "high",
            isDirect: false,
            via: [
              {
                source: 1,
                name: "evil",
                dependency: "evil",
                title: "Synthetic test advisory",
                url: "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz",
                severity: "high",
              },
            ],
            effects: [],
            range: "*",
            nodes: [],
            fixAvailable: false,
          },
        },
        { high: 1, total: 1 },
      ),
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("UNEXPECTED high GHSA-xxxx-yyyy-zzzz [evil] Synthetic test advisory");
  });
});

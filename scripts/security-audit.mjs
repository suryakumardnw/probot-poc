#!/usr/bin/env node
/**
 * Dependency audit gate.
 *
 * Runs `npm audit --audit-level=high` and fails when a high or critical
 * advisory is not explicitly allowlisted in `scripts/npm-audit-allowlist.json`.
 * This keeps the known, pre-existing advisories visible without letting a new
 * one slide through silently.
 *
 * Usage:
 *   node scripts/security-audit.mjs                 # run npm audit
 *   node scripts/security-audit.mjs audit.json      # evaluate a saved report
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const allowlist = JSON.parse(readFileSync(join(scriptDirectory, "npm-audit-allowlist.json"), "utf8"));
const allowed = new Map((allowlist.advisories ?? []).map((entry) => [entry.id, entry]));

function loadReport() {
  const savedReport = process.argv[2];
  if (savedReport) {
    return JSON.parse(readFileSync(savedReport, "utf8"));
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    return JSON.parse(
      execFileSync(npm, ["audit", "--audit-level=high", "--json"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch (error) {
    // `npm audit` exits non-zero when it finds vulnerabilities. The JSON report
    // is still on stdout and is the payload we need to evaluate.
    if (typeof error.stdout !== "string" || error.stdout.trim().length === 0) {
      throw error;
    }
    return JSON.parse(error.stdout);
  }
}

/** @returns {{ advisories: Map<string, {id: string, severity: string, title: string, packages: Set<string>}>, unidentified: {package: string, severity: string, title: string}[] }} */
function collectFindings(report) {
  const advisories = new Map();
  const unidentified = [];

  for (const [packageName, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via === "string") {
        continue;
      }
      if (via.severity !== "high" && via.severity !== "critical") {
        continue;
      }

      const id = /GHSA-[A-Za-z0-9-]+/.exec(via.url ?? "")?.[0];
      if (!id) {
        unidentified.push({ package: packageName, severity: via.severity, title: via.title ?? via.url ?? "unknown" });
        continue;
      }

      const existing = advisories.get(id);
      if (existing) {
        existing.packages.add(packageName);
      } else {
        advisories.set(id, {
          id,
          severity: via.severity,
          title: via.title ?? "unknown",
          packages: new Set([packageName]),
        });
      }
    }
  }

  return { advisories, unidentified };
}

const report = loadReport();
const { advisories, unidentified } = collectFindings(report);
const counts = report.metadata?.vulnerabilities ?? {};
const unexpected = [...advisories.values()].filter((advisory) => !allowed.has(advisory.id));
const stale = [...allowed.values()].filter((entry) => !advisories.has(entry.id));

process.stdout.write(
  `npm audit: ${counts.total ?? 0} total vulnerabilities ` +
    `(${counts.high ?? 0} high, ${counts.critical ?? 0} critical)\n`,
);

for (const advisory of advisories.values()) {
  const status = allowed.has(advisory.id) ? "allowed" : "UNEXPECTED";
  const packages = [...advisory.packages].join(", ");
  process.stdout.write(`${status} ${advisory.severity} ${advisory.id} [${packages}] ${advisory.title}\n`);
}

for (const finding of unidentified) {
  process.stdout.write(`UNEXPECTED ${finding.severity} [${finding.package}] ${finding.title}\n`);
}

for (const entry of stale) {
  process.stderr.write(
    `warning: allowlist entry ${entry.id} is no longer reported; remove it from scripts/npm-audit-allowlist.json\n`,
  );
}

if (unexpected.length > 0 || unidentified.length > 0) {
  process.stderr.write(
    "New high/critical advisories found. Upgrade the dependency or add an approved, " +
      "documented entry to scripts/npm-audit-allowlist.json (see docs/security-audit-follow-ups.md).\n",
  );
  process.exitCode = 1;
}

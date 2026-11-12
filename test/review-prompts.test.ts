/**
 * Instruction profiles + handbook retrieval tests (ARCHITECTURE.md §4.1).
 *
 * Covers:
 *  - technology detection from changed file paths (extension + path hints);
 *  - handbook file ranking: technology match dominates, keyword overlap
 *    second, general/ categories eligible but deprioritized — and a Dart PR
 *    must not select Node.js guidelines;
 *  - token budget enforcement, dedup, deterministic ordering, truncation;
 *  - prompt profile assembly: standard = common, handbook = common + handbook
 *    profile with the guidelines block injected ONCE (analysis) and reused by
 *    reference in later stages; non-handbook injections use the same
 *    guideline-mode profile and re-inject the full text in later stages;
 *  - the handbook instruction text mandates citations, forbids invented
 *    standards, and treats clear violations as findings even without runtime
 *    impact.
 * No network and no database: pure unit coverage.
 */
import { describe, expect, test } from "vitest";
import type pino from "pino";
import {
  COMMON_REVIEW_INSTRUCTIONS,
  HANDBOOK_MODE_INSTRUCTIONS,
} from "../src/review-engine/prompts/index.js";
import {
  CHARS_PER_TOKEN,
  detectTechnologies,
  rankHandbookFiles,
  selectHandbookUnderBudget,
} from "../src/review-engine/retrieval.js";
import { composeInjectionStage1, composeInjectionLaterStages } from "../src/review-engine/engine.js";
import type { PromptInjection } from "../src/review-engine/types.js";

const fakeLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as pino.Logger;
void fakeLogger;

describe("detectTechnologies", () => {
  test("maps extensions to technology keywords", () => {
    expect(detectTechnologies(["lib/main.dart"])).toContain("flutter");
    expect(detectTechnologies(["lib/main.dart"])).toContain("dart");
    const node = detectTechnologies(["src/index.ts", "app.js"]);
    expect(node).toEqual(expect.arrayContaining(["nodejs", "typescript", "javascript"]));
    expect(detectTechnologies(["cmd/server.go"])).toContain("go");
    expect(detectTechnologies(["app.py"])).toContain("python");
    expect(detectTechnologies(["lib.rs"])).toContain("rust");
    expect(detectTechnologies(["App.kt"])).toContain("kotlin");
    expect(detectTechnologies(["App.swift"])).toContain("swift");
    expect(detectTechnologies(["Main.java"])).toContain("java");
    expect(detectTechnologies(["app.rb"])).toContain("ruby");
    expect(detectTechnologies(["index.php"])).toContain("php");
  });

  test("detects via path hints and is deterministic (sorted, deduped)", () => {
    expect(detectTechnologies(["flutter/widgets/button.dart"])).toContain("flutter");
    expect(detectTechnologies(["infra/main.tf"])).toContain("terraform");
    const result = detectTechnologies(["b.ts", "a.ts", "a.ts"]);
    expect(result).toEqual([...result].sort());
    expect(new Set(result).size).toBe(result.length);
  });
});

describe("rankHandbookFiles", () => {
  const handbook = [
    { path: "flutter/style.md", content: "# Flutter style" },
    { path: "nodejs/api.md", content: "# Node API" },
    { path: "general/reviewing.md", content: "# General reviewing" },
    { path: "git/commits.md", content: "# Commits" },
  ];

  test("technology match dominates: flutter first for a Dart PR, nodejs last", () => {
    const ranked = rankHandbookFiles(handbook, ["lib/main.dart", "test/widget_test.dart"]);
    expect(ranked[0]!.path).toBe("flutter/style.md");
    const paths = ranked.map((r) => r.path);
    expect(paths.indexOf("nodejs/api.md")).toBeGreaterThan(paths.indexOf("general/reviewing.md"));
    expect(ranked.find((r) => r.path === "nodejs/api.md")!.techMatch).toBe(false);
    expect(ranked.find((r) => r.path === "general/reviewing.md")!.general).toBe(true);
    // General categories are always eligible (score > 0), just deprioritized.
    expect(ranked.find((r) => r.path === "general/reviewing.md")!.score).toBeGreaterThan(0);
  });

  test("keyword overlap with changed paths boosts otherwise-unknown files", () => {
    const ranked = rankHandbookFiles([{ path: "testing/widgets.md", content: "# Widgets" }], [
      "test/widgets_test.dart",
    ]);
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });

  test("deterministic ordering (stable tie-breaking by path)", () => {
    const files = [
      { path: "b/x.md", content: "# B" },
      { path: "a/x.md", content: "# A" },
    ];
    const ranked1 = rankHandbookFiles(files, ["src/unknown.zzz"]);
    const ranked2 = rankHandbookFiles([...files].reverse(), ["src/unknown.zzz"]);
    expect(ranked1.map((r) => r.path)).toEqual(ranked2.map((r) => r.path));
  });
});

describe("selectHandbookUnderBudget", () => {
  const dartChanged = ["lib/main.dart"];
  const bigFile = (heading: string, size: number) => `${heading}\n\n${"x".repeat(size)}`;

  test("a Dart PR selects flutter and general content, never nodejs", () => {
    const files = [
      { path: "flutter/style.md", content: "# Style\n\nUse const constructors." },
      { path: "nodejs/api.md", content: "# Node API\n\nUse async/await." },
      { path: "general/reviewing.md", content: "# Reviewing\n\nBe thorough." },
    ];
    const ranked = rankHandbookFiles(files, dartChanged);
    const selection = selectHandbookUnderBudget(ranked, dartChanged, { maxTokens: 3000, maxChars: 12000 });
    expect(selection.files).toContain("flutter/style.md");
    expect(selection.files).toContain("general/reviewing.md");
    expect(selection.files).not.toContain("nodejs/api.md");
    expect(selection.truncated).toBe(false);
    expect(selection.candidates).toBe(3);
    expect(selection.selected).toBe(2);
  });

  test("token budget is enforced (≈4 chars/token) and truncation is flagged", () => {
    const files = [
      { path: "flutter/style.md", content: bigFile("# Style", 2000) },
      { path: "flutter/state.md", content: bigFile("# State", 2000) },
    ];
    const ranked = rankHandbookFiles(files, dartChanged);
    const maxTokens = 500; // ≈2000 chars
    const selection = selectHandbookUnderBudget(ranked, dartChanged, { maxTokens, maxChars: 100_000 });
    expect(selection.text.length).toBeLessThanOrEqual(maxTokens * CHARS_PER_TOKEN + 100);
    expect(selection.truncated).toBe(true);
    expect(selection.selected).toBeLessThan(files.length);
  });

  test("prefers whole higher-ranked files over many fragments", () => {
    const files = [
      { path: "flutter/big.md", content: bigFile("# Big", 1500) },
      { path: "flutter/small.md", content: "# Small\n\nShort guidance." },
    ];
    const ranked = rankHandbookFiles(files, dartChanged);
    const selection = selectHandbookUnderBudget(ranked, dartChanged, { maxTokens: 400, maxChars: 100_000 });
    // The higher-ranked big file is taken WHOLE (never fragmented); the
    // small file that no longer fits contributes nothing partial.
    expect(selection.files).toContain("flutter/big.md");
    expect(selection.text).toContain("x".repeat(1500));
    for (const part of selection.text.split("## handbook file:").filter((p) => p.trim())) {
      const body = part.slice(part.indexOf("\n"));
      expect(body.includes("(truncated)")).toBe(false);
    }
  });

  test("never injects the same file or identical content twice", () => {
    const same = "# Duplicated\n\nSame body everywhere.";
    const files = [
      { path: "flutter/a.md", content: same },
      { path: "flutter/b.md", content: same },
    ];
    const ranked = rankHandbookFiles(files, dartChanged);
    const selection = selectHandbookUnderBudget(ranked, dartChanged, { maxTokens: 3000, maxChars: 100_000 });
    const occurrences = selection.text.split("Same body everywhere.").length - 1;
    expect(occurrences).toBe(1);
  });

  test("deterministic selection for identical inputs", () => {
    const files = [
      { path: "flutter/style.md", content: "# Style\n\nA." },
      { path: "general/reviewing.md", content: "# Reviewing\n\nB." },
    ];
    const run = () =>
      selectHandbookUnderBudget(rankHandbookFiles(files, dartChanged), dartChanged, { maxTokens: 1000, maxChars: 5000 }).text;
    expect(run()).toBe(run());
  });

  test("fallback: when nothing is relevant, general standards still flow", () => {
    const files = [{ path: "git/commits.md", content: "# Commits\n\nWrite good messages." }];
    const ranked = rankHandbookFiles(files, ["unrelated.bin"]);
    const selection = selectHandbookUnderBudget(ranked, ["unrelated.bin"], { maxTokens: 1000, maxChars: 5000 });
    expect(selection.text).toContain("Write good messages.");
  });
});

describe("prompt profiles (§4.1)", () => {
  const skillInjection: PromptInjection = {
    label: "code-review playbook",
    profile: "skill",
    text: "PLAYBOOK-TEXT",
    files: ["skills/code-review/SKILL.md"],
    contentHash: null,
  };
  const handbookInjection: PromptInjection = {
    label: "handbook standards",
    profile: "handbook",
    text: "GUIDELINE-TEXT",
    laterStagesText: "LATER-REFERENCE",
    files: ["flutter/style.md"],
    contentHash: null,
  };

  test("standard reviews receive no injected block", () => {
    expect(composeInjectionStage1(null)).toBe("");
    expect(composeInjectionLaterStages(null)).toBe("");
    expect(composeInjectionStage1(undefined)).toBe("");
  });

  test("non-handbook injection: full guideline text in analysis AND later stages", () => {
    const stage1 = composeInjectionStage1(skillInjection);
    const later = composeInjectionLaterStages(skillInjection);
    expect(stage1).toContain(HANDBOOK_MODE_INSTRUCTIONS);
    expect(stage1).toContain("PLAYBOOK-TEXT");
    expect(later).toContain("PLAYBOOK-TEXT");
    expect(later).toContain(HANDBOOK_MODE_INSTRUCTIONS);
  });

  test("handbook profile: guidelines injected ONCE, later stages reference them", () => {
    const stage1 = composeInjectionStage1(handbookInjection);
    expect(stage1).toContain(HANDBOOK_MODE_INSTRUCTIONS);
    expect(stage1).toContain("GUIDELINE-TEXT");
    expect(stage1).toContain("AUTHORITATIVE STANDARD");

    const later = composeInjectionLaterStages(handbookInjection);
    expect(later).toBe("LATER-REFERENCE");
    expect(later).not.toContain("GUIDELINE-TEXT");
  });

  test("guideline instruction mandates citations and forbids invented standards", () => {
    expect(HANDBOOK_MODE_INSTRUCTIONS).toContain("cite");
    expect(HANDBOOK_MODE_INSTRUCTIONS).toContain("NEVER invent standards");
    expect(HANDBOOK_MODE_INSTRUCTIONS).toContain("no runtime impact");
    expect(HANDBOOK_MODE_INSTRUCTIONS).toContain("report nothing");
    // Common base is shared by all modes and still treats repo content as data.
    expect(COMMON_REVIEW_INSTRUCTIONS).toContain("UNTRUSTED DATA");
    expect(COMMON_REVIEW_INSTRUCTIONS).not.toContain("Do NOT report style nits");
  });
});

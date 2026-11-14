#!/usr/bin/env node
/**
 * Quality metrics for the TypeScript refactor.
 *
 * Walks `src/` and `test/`, then prints a Markdown table followed by a JSON
 * document with the counts. No third-party dependencies, no network, no clock:
 * two consecutive runs produce identical counts.
 *
 * Comments and string literal contents are masked before matching so prose and
 * fixtures are not counted. Definitions are repeated in
 * `docs/typescript-refactor-baseline.md`.
 *
 * Usage:
 *   node scripts/quality-metrics.mjs             # Markdown + JSON
 *   node scripts/quality-metrics.mjs --details   # also list every match site
 *   node scripts/quality-metrics.mjs --json      # JSON only
 */

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const showDetails = args.has("--details");
const jsonOnly = args.has("--json");

/**
 * @typedef {{ file: string, line: number, text: string }} Site
 * @typedef {{ file: string, original: string, masked: string }} Source
 */

/**
 * Heuristic for `/`: a regex literal can start where an expression is
 * expected. Division (`total / count`) follows an identifier, `)`, `]`, or a
 * number, so it is not misread. Regex bodies are masked so quotes and braces
 * inside them cannot desynchronise the scanner.
 * @param {string} text
 * @param {number} index
 */
function startsRegexLiteral(text, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (i < 0) return true;

  const char = text[i];
  if (/[A-Za-z0-9_$]/.test(char)) {
    let start = i;
    while (start >= 0 && /[A-Za-z0-9_$]/.test(text[start])) start -= 1;
    const word = text.slice(start + 1, i + 1);
    return [
      "return",
      "case",
      "throw",
      "typeof",
      "instanceof",
      "in",
      "of",
      "new",
      "delete",
      "void",
      "do",
      "else",
      "yield",
      "await",
      "default",
    ].includes(word);
  }

  return "([{,;=:!&|?+-*%^~<>".includes(char);
}

/**
 * Replace comments, regex literal bodies, and the contents of string/template
 * literals with spaces, keeping newlines and offsets intact. Template `${...}`
 * expressions stay in code mode so casts inside them are still counted.
 * @param {string} text
 * @returns {string}
 */
export function maskCommentsAndStrings(text) {
  const out = text.split("");
  const blank = (index) => {
    if (index >= text.length) return;
    if (text[index] !== "\n" && text[index] !== "\r") out[index] = " ";
  };

  let mode = "code"; // code | line-comment | block-comment | regex | single | double | template
  let regexClass = false;
  /** One brace depth per active `${ ... }` template expression. */
  const templateExpressions = [];
  let braceDepth = 0;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];

    if (mode === "code") {
      if (char === "/" && next === "/") {
        blank(i);
        blank(i + 1);
        mode = "line-comment";
        i += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        blank(i);
        blank(i + 1);
        mode = "block-comment";
        i += 2;
        continue;
      }
      if (char === "/" && startsRegexLiteral(text, i)) {
        blank(i);
        regexClass = false;
        mode = "regex";
        i += 1;
        continue;
      }
      if (char === "'") {
        blank(i);
        mode = "single";
        i += 1;
        continue;
      }
      if (char === '"') {
        blank(i);
        mode = "double";
        i += 1;
        continue;
      }
      if (char === "`") {
        blank(i);
        mode = "template";
        i += 1;
        continue;
      }
      if (templateExpressions.length > 0) {
        if (char === "{") {
          braceDepth += 1;
        } else if (char === "}") {
          if (braceDepth === 0) {
            blank(i);
            templateExpressions.pop();
            mode = "template";
            i += 1;
            continue;
          }
          braceDepth -= 1;
        }
      }
      i += 1;
      continue;
    }

    if (mode === "line-comment") {
      if (char === "\n") {
        mode = "code";
      } else {
        blank(i);
      }
      i += 1;
      continue;
    }

    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        blank(i);
        blank(i + 1);
        mode = "code";
        i += 2;
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }

    if (mode === "regex") {
      if (char === "\\") {
        blank(i);
        blank(i + 1);
        i += 2;
        continue;
      }
      if (char === "\n") {
        // Unterminated regex; resume scanning so one typo cannot blank the file.
        mode = "code";
        i += 1;
        continue;
      }
      if (char === "[") {
        regexClass = true;
      } else if (char === "]") {
        regexClass = false;
      } else if (char === "/" && !regexClass) {
        blank(i);
        i += 1;
        while (i < text.length && /[a-z]/i.test(text[i])) {
          blank(i);
          i += 1;
        }
        mode = "code";
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }

    if (mode === "single" || mode === "double") {
      const closing = mode === "single" ? "'" : '"';
      if (char === "\\") {
        blank(i);
        blank(i + 1);
        i += 2;
        continue;
      }
      if (char === closing) {
        blank(i);
        mode = "code";
        i += 1;
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }

    if (mode === "template") {
      if (char === "\\") {
        blank(i);
        blank(i + 1);
        i += 2;
        continue;
      }
      if (char === "`") {
        blank(i);
        mode = "code";
        i += 1;
        continue;
      }
      if (char === "$" && next === "{") {
        blank(i);
        blank(i + 1);
        templateExpressions.push(0);
        braceDepth = 0;
        mode = "code";
        i += 2;
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }

    i += 1;
  }

  return out.join("");
}

/** @param {string} text @param {number} index @returns {number} 1-based line */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/** @param {string} dir @returns {string[]} Repo-relative, posix-separated .ts paths. */
function collectTypeScriptFiles(dir) {
  const absolute = join(repoRoot, dir);
  /** @type {string[]} */
  const files = [];
  /** @param {string} current */
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        files.push(relative(repoRoot, path).split(sep).join(posix.sep));
      }
    }
  };
  walk(absolute);
  return files;
}

/**
 * @param {Source} source
 * @param {RegExp} pattern Global regex.
 * @returns {Site[]}
 */
function matchSites(source, pattern) {
  /** @type {Site[]} */
  const sites = [];
  for (const match of source.masked.matchAll(pattern)) {
    const index = match.index ?? 0;
    sites.push({ file: source.file, line: lineOf(source.masked, index), text: match[0] });
  }
  return sites;
}

/** Alias tokens in `import * as x` and `{ x as y }` are not casts. */
function isModuleAlias(masked, index) {
  const lineStart = masked.lastIndexOf("\n", index) + 1;
  let lineEnd = masked.indexOf("\n", index);
  if (lineEnd === -1) lineEnd = masked.length;
  const line = masked.slice(lineStart, lineEnd);
  if (!/^\s*(?:import|export)\b/.test(line)) return false;

  const before = masked.slice(lineStart, index);
  const after = masked.slice(index + 2);

  if (/\*\s*$/.test(before) && /^\s+[A-Za-z_$]/.test(after)) return true;

  // `export const x = { ... y as T }` is a cast, not a specifier alias.
  if (before.includes("=")) return false;

  const openBrace = before.lastIndexOf("{");
  if (openBrace === -1) return false;
  const closeBrace = after.indexOf("}");
  if (closeBrace === -1) return false;
  return !masked.slice(lineStart + openBrace + 1, index + 2 + closeBrace).includes(";");
}

/** @param {Source} source @returns {Site[]} */
function anyTypePositionSites(source) {
  /** @type {Site[]} */
  const sites = [];
  for (const match of source.masked.matchAll(/\bany\b/g)) {
    const index = match.index ?? 0;
    const before = source.masked.slice(0, index);
    const after = source.masked.slice(index + 3);
    // `AbortSignal.any(...)` and `expect.any(...)` are property reads.
    if (/[.?!]\s*$/.test(before)) continue;
    // `{ any: ... }` is a property name, not a type position.
    if (/^\s*:/.test(after)) continue;
    sites.push({ file: source.file, line: lineOf(source.masked, index), text: "any" });
  }
  return sites;
}

/** @param {Source} source @returns {Site[]} */
function otherAsCastSites(source) {
  /** @type {Site[]} */
  const sites = [];
  for (const match of source.masked.matchAll(/\bas\b/g)) {
    const index = match.index ?? 0;
    if (isModuleAlias(source.masked, index)) continue;

    const before = source.masked.slice(0, index);
    const after = source.masked.slice(index + 2);
    if (/^\s+const\b/.test(after)) continue;
    if (/^\s+unknown\s+as\b/.test(after)) continue;
    // Second `as` of `as unknown as`.
    if (/\bunknown\s+$/.test(before)) continue;

    sites.push({ file: source.file, line: lineOf(source.masked, index), text: match[0] });
  }
  return sites;
}

/**
 * Indices of the `as` keyword after each balanced `JSON.parse(...)` call.
 * @param {Source} source
 * @returns {Site[]}
 */
function boundaryJsonParseAsSites(source) {
  /** @type {Site[]} */
  const sites = [];
  const marker = "JSON.parse";
  let from = 0;
  while (from < source.masked.length) {
    const start = source.masked.indexOf(marker, from);
    if (start === -1) break;

    let open = start + marker.length;
    while (open < source.masked.length && source.masked[open] !== "(") open += 1;
    if (open >= source.masked.length) break;

    let depth = 0;
    let close = -1;
    for (let i = open; i < source.masked.length; i += 1) {
      if (source.masked[i] === "(") depth += 1;
      else if (source.masked[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) break;

    const rest = source.masked.slice(close + 1);
    const asMatch = /^\s*as\b/.exec(rest);
    if (asMatch) {
      const offset = close + 1 + asMatch[0].indexOf("as");
      sites.push({ file: source.file, line: lineOf(source.masked, offset), text: "JSON.parse(...) as" });
    }
    from = close + 1;
  }
  return sites;
}

/** @param {Source} source @returns {Site[]} */
function prismaImportSites(source) {
  if (/\.repository\.ts$/.test(source.file) || source.file.startsWith("src/platform/db/")) return [];

  /** @type {Site[]} */
  const sites = [];
  for (const { specifier, line } of importSpecifiers(source)) {
    if (specifier === "@prisma/client") sites.push({ file: source.file, line, text: specifier });
  }
  // Dynamic `import("@prisma/client")` and `require("@prisma/client")`. The
  // keyword check rejects matches that live inside a comment.
  const dynamic = /\b(?:import|require)\s*\(\s*(["'])@prisma\/client\1\s*\)/g;
  for (const match of source.original.matchAll(dynamic)) {
    const index = match.index ?? 0;
    const keyword = source.original.startsWith("import", index) ? "import" : "require";
    if (!source.masked.startsWith(keyword, index)) continue;
    sites.push({ file: source.file, line: lineOf(source.masked, index), text: "import(@prisma/client)" });
  }
  return sites;
}

/** @param {Source} source @returns {Site[]} */
function processEnvSites(source) {
  if (source.file.startsWith("src/platform/config/")) return [];
  return matchSites(source, /\bprocess\.env\b/g);
}

/**
 * Static import specifiers, read from the original text so quoted specifiers
 * survive masking. Comment lines cannot match because the statement must start
 * with `import`/`export`.
 * @param {Source} source
 * @returns {{ specifier: string, line: number }[]}
 */
function importSpecifiers(source) {
  const pattern =
    /(?:^|\n)[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*(["'])([^"'\n]+)\1|(?:^|\n)[ \t]*import[ \t]*(["'])([^"'\n]+)\3/g;
  /** @type {{ specifier: string, line: number }[]} */
  const specifiers = [];
  for (const match of source.original.matchAll(pattern)) {
    const specifier = match[2] ?? match[4];
    if (!specifier) continue;
    const index = match.index ?? 0;
    // The match may start with the newline that terminates the previous line.
    const line = lineOf(source.original, match[0].startsWith("\n") ? index + 1 : index);
    specifiers.push({ specifier, line });
  }
  return specifiers;
}

/** @param {string} specifier @param {string} fromFile @returns {string|null} */
function resolveRelativeImport(specifier, fromFile) {
  if (!specifier.startsWith(".")) return null;
  const target = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  return target.replace(/\.(?:js|ts)$/, ".ts");
}

/** @param {string} file @returns {string|null} */
function moduleNameOf(file) {
  const match = /^src\/modules\/([^/]+)\//.exec(file);
  return match ? match[1] : null;
}

/**
 * Imports into another module's internals instead of its public `index.ts`.
 * @param {Source} source
 * @returns {Site[]}
 */
function crossModuleInternalImportSites(source) {
  /** @type {Site[]} */
  const sites = [];
  const fromModule = moduleNameOf(source.file);
  if (!fromModule) return sites;
  for (const { specifier, line } of importSpecifiers(source)) {
    const target = resolveRelativeImport(specifier, source.file);
    if (!target) continue;
    const toModule = moduleNameOf(target);
    if (!toModule || toModule === fromModule) continue;
    if (target === `src/modules/${toModule}/index.ts`) continue;
    sites.push({ file: source.file, line, text: specifier });
  }
  return sites;
}

const TEST_SERVICE_PATTERNS = [
  /\bgetPrisma\b/g,
  /\bnew\s+PrismaClient\b/g,
  /\bdisconnectPrisma\b/g,
  /\bgetRedis\b/g,
  /\bcheckRedis\b/g,
  /\bdisconnectRedis\b/g,
  /\bnew\s+Redis\b/g,
  /\bnew\s+Queue\b/g,
  /\bcreateQueue\b/g,
  /\bgetReviewQueue\b/g,
  /\bcloseReviewQueue\b/g,
  /\bprocess\.env\.(?:DATABASE_URL|REDIS_URL)\s*\?\?=/g,
];

/**
 * Test files that connect to Postgres or Redis: client imports/construction
 * and the local default-env bootstrap. Bare string references such as
 * `postgresOk` do not count.
 * @param {Source} source
 * @returns {Site[]}
 */
function testServiceSites(source) {
  /** @type {Site[]} */
  const sites = [];
  if (source.file.startsWith("test/integration/")) return sites;
  for (const pattern of TEST_SERVICE_PATTERNS) sites.push(...matchSites(source, pattern));
  for (const { specifier, line } of importSpecifiers(source)) {
    if (specifier === "ioredis") sites.push({ file: source.file, line, text: 'from "ioredis"' });
  }
  return sites;
}

/** @param {Site[]} sites @param {"sites"|"files"} unit */
function summarize(sites, unit = "sites") {
  const files = new Set(sites.map((site) => site.file)).size;
  return { count: unit === "files" ? files : sites.length, files };
}

function main() {
  const srcFiles = collectTypeScriptFiles("src");
  const testFiles = collectTypeScriptFiles("test");
  /** @type {Map<string, Source>} */
  const sources = new Map();
  for (const file of [...srcFiles, ...testFiles]) {
    const original = readFileSync(join(repoRoot, file), "utf8");
    sources.set(file, { file, original, masked: maskCommentsAndStrings(original) });
  }
  const srcSources = srcFiles.map((file) => sources.get(file));
  const testSources = testFiles.map((file) => sources.get(file));

  /**
   * @param {(source: Source) => Site[]} collect
   * @param {"both"|"src"|"test"} scope
   */
  const collectScoped = (collect, scope) => ({
    src: scope === "test" ? [] : srcSources.flatMap((source) => collect(source)),
    test: scope === "test" || scope === "both" ? testSources.flatMap((source) => collect(source)) : [],
  });

  const metrics = [
    {
      id: "any_type_positions",
      label: "`any` type positions",
      note: "Occurrences of `any` in a type position; property reads such as `AbortSignal.any` are excluded.",
      scope: "both",
      sites: collectScoped(anyTypePositionSites, "both"),
    },
    {
      id: "non_null_assertions",
      label: "Non-null assertions (`!`)",
      note: "Postfix `!` on an identifier, call, index, or `this`, excluding `!=` and `!==`.",
      scope: "both",
      sites: collectScoped((source) => matchSites(source, /(?:[A-Za-z0-9_$\])]|>)!(?!=)/g), "both"),
    },
    {
      id: "as_const",
      label: "`as const`",
      note: "Safe literal narrowing; tracked separately from casts.",
      scope: "both",
      sites: collectScoped((source) => matchSites(source, /\bas\s+const\b/g), "both"),
    },
    {
      id: "other_as_casts",
      label: "Other `as` casts",
      note: "Every `as` cast that is not `as const` or `as unknown as`.",
      scope: "both",
      sites: collectScoped(otherAsCastSites, "both"),
    },
    {
      id: "as_unknown_as",
      label: "`as unknown as`",
      note: "Double cast; counted once per expression.",
      scope: "both",
      sites: collectScoped((source) => matchSites(source, /\bas\s+unknown\s+as\b/g), "both"),
    },
    {
      id: "json_parse_as",
      label: "Boundary `JSON.parse(...) as`",
      note: "A `JSON.parse` result asserted with `as`; the shape is not parsed.",
      scope: "both",
      sites: collectScoped(boundaryJsonParseAsSites, "both"),
    },
    {
      id: "prisma_imports_outside_repositories",
      label: "Prisma imports outside `*.repository.ts` and `src/platform/db/**`",
      note: "Counts imports of `@prisma/client`, not files.",
      scope: "both",
      sites: collectScoped(prismaImportSites, "both"),
    },
    {
      id: "process_env_outside_platform_config",
      label: "`process.env` reads outside `src/platform/config/**`",
      note: "Counts reads, not files.",
      scope: "both",
      sites: collectScoped(processEnvSites, "both"),
    },
    {
      id: "cross_module_internal_imports",
      label: "Cross-module internal imports",
      note: "Imports into `src/modules/<other>/` other than its public `index.ts`.",
      scope: "src",
      sites: collectScoped(crossModuleInternalImportSites, "src"),
    },
    {
      id: "tests_requiring_postgres_or_redis",
      label: "Test files requiring Postgres/Redis outside `test/integration/**`",
      note: "Counts files that import or construct Prisma/Redis/queue clients, or bootstrap `DATABASE_URL`/`REDIS_URL`.",
      scope: "test",
      unit: "files",
      sites: collectScoped(testServiceSites, "test"),
    },
  ];

  const jsonMetrics = {};
  for (const metric of metrics) {
    const entry = { scope: metric.scope, definition: metric.note };
    const unit = metric.unit ?? "sites";
    if (metric.scope === "both") {
      entry.src = summarize(metric.sites.src, unit);
      entry.test = summarize(metric.sites.test, unit);
      entry.total = summarize([...metric.sites.src, ...metric.sites.test], unit);
    } else if (metric.scope === "src") {
      entry.src = summarize(metric.sites.src, unit);
      entry.total = summarize(metric.sites.src, unit);
    } else {
      entry.test = summarize(metric.sites.test, unit);
      entry.total = summarize(metric.sites.test, unit);
    }
    jsonMetrics[metric.id] = entry;
  }

  const json = {
    schemaVersion: 1,
    scopes: {
      src: { files: srcFiles.length },
      test: { files: testFiles.length },
    },
    metrics: jsonMetrics,
  };

  if (!jsonOnly) {
    process.stdout.write(
      `Scanned ${srcFiles.length} TypeScript files in \`src/\` and ${testFiles.length} in \`test/\`. ` +
        "Run with `--details` to list every match site.\n\n",
    );
    const rows = ["| Metric | Scope | Count | Files |", "|---|---|---:|---:|"];
    for (const metric of metrics) {
      const scopes = metric.scope === "both" ? ["src", "test"] : metric.scope === "src" ? ["src"] : ["test"];
      for (const scope of scopes) {
        const summary = summarize(metric.sites[scope], metric.unit ?? "sites");
        rows.push(`| ${metric.label} | ${scope} | ${summary.count} | ${summary.files} |`);
      }
    }
    process.stdout.write(`${rows.join("\n")}\n\n`);
  }

  if (showDetails && !jsonOnly) {
    for (const metric of metrics) {
      const sites = [...metric.sites.src, ...metric.sites.test].sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
      );
      if (sites.length === 0) continue;
      process.stdout.write(`\n### ${metric.label}\n\n`);
      for (const site of sites) process.stdout.write(`- \`${site.file}:${site.line}\` ${site.text}\n`);
    }
    process.stdout.write("\n");
  }

  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  } else {
    process.stdout.write("```json\n");
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    process.stdout.write("```\n");
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}

/**
 * Boot-time knowledge source initialization (ARCHITECTURE.md §5.3).
 *
 * The code-review skill playbook (from `vercel-labs/open-agents`) and the
 * engineering handbook (from `nativewit/engineering-handbook`) are fetched
 * ONCE per worker boot into a persistent cache — never per review. Reviews
 * never touch the network for knowledge: they read their own snapshot copy
 * materialized from this cache (src/knowledge/materialize.ts).
 *
 * Cache layout (under the configured cacheDir):
 *
 *   skill/<commit-sha>/manifest.json + content files
 *   handbook/<commit-sha>/manifest.json + content files
 *
 * Each manifest.json stores { ref, fetchedAt, contentHash, files, status }.
 * A cached copy is reused (no network) when the manifest validates and every
 * file's sha256 matches.
 *
 * Failure semantics: there is no fallback content. On network/validation
 * failure the source becomes "unavailable" and the worker NEVER crashes, so
 * standard reviews are unaffected — but a review whose type needs the missing
 * source fails fast (SKILL_PLAYBOOK_UNAVAILABLE / HANDBOOK_UNAVAILABLE /
 * HANDBOOK_UNCONFIGURED).
 *
 * Security: fetched content is UNTRUSTED DATA injected into prompts — never
 * code, never configuration. Path traversal is rejected (no absolute paths,
 * no "..", no symlinks), only text extensions are accepted, config-like
 * manifests (opencode.json, *.schema.json, ...) are stripped, and content is
 * written only inside the cache directory, atomically (temp dir + rename).
 * `ensureKnowledgeSources` is idempotent and concurrency-safe per process.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type pino from "pino";
import type { ReviewConfig } from "../config/review-schema.js";
import {
  createDefaultKnowledgeFetcher,
  fetchFileContent,
  fetchRepoTree,
  parseOwnerRepo,
  resolveCommitSha,
  sha256Hex,
} from "./fetch.js";
import {
  knowledgeRefSlug,
  type KnowledgeFetcher,
  type KnowledgeFileRecord,
  type KnowledgeSnapshot,
  type KnowledgeSourceSnapshot,
} from "./types.js";

/** Per-file hard cap so one huge file cannot blow the source budget. */
const MAX_FILE_BYTES = 500_000;
/** Blob count caps per source. */
const MAX_SKILL_FILES = 20;
const MAX_HANDBOOK_FILES = 200;
/** Retries per HTTP request (bounded, short backoff). */
const FETCH_ATTEMPTS = 3;
const FETCH_BACKOFF_MS = 500;

// Extensions accepted per source; everything else is ignored. Content is
// prompt DATA, so executables/config manifests are never accepted.
const SKILL_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);
const HANDBOOK_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"]);

/** Basenames / patterns that look like configuration, not knowledge. */
const REJECTED_BASENAMES = new Set([
  "opencode.json",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "skills-lock.json",
]);

export interface KnowledgeSourceSpec {
  kind: "skill" | "handbook";
  repo: string;
  ref: string;
  /** Repo-relative directory or file prefix; "" = repo root recursively. */
  path: string;
  maxBytes: number;
  /** Resolved env override for the ref (KNOWLEDGE_SKILL_REF / KNOWLEDGE_HANDBOOK_REF). */
  refOverride?: string;
}

export interface EnsureKnowledgeOptions {
  /** Resolved cache directory (worker resolves the workspace-relative default). */
  cacheDir?: string;
  fetcher?: KnowledgeFetcher;
}

export interface KnowledgeManifest {
  ref: string;
  fetchedAt: string;
  contentHash: string;
  status: "fresh";
  files: KnowledgeFileRecord[];
}

// ---------------------------------------------------------------------------
// Path safety + content selection (untrusted input)
// ---------------------------------------------------------------------------

/**
 * Validate a repo-relative path from the (untrusted) tree listing: rejects
 * absolute paths, ".." segments, backslashes and empty segments so a fetched
 * file can never escape its cache directory.
 */
export function validateRelativePath(candidate: string): string {
  if (!candidate || candidate.startsWith("/") || candidate.includes("\\") || candidate.includes("\0")) {
    throw new Error(`unsafe knowledge path rejected: '${candidate}'`);
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`unsafe knowledge path rejected: '${candidate}'`);
  }
  return candidate;
}

function extensionOf(filePath: string): string {
  return path.posix.extname(filePath).toLowerCase();
}

function isConfigLikeManifest(filePath: string): boolean {
  const base = path.posix.basename(filePath).toLowerCase();
  if (REJECTED_BASENAMES.has(base)) return true;
  if (base.endsWith(".schema.json")) return true;
  return false;
}

/** Content hash over the sorted file records ("sha256  path\n" lines). */
export function computeContentHash(files: KnowledgeFileRecord[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256Hex(sorted.map((file) => `${file.sha256}  ${file.path}\n`).join(""));
}

function selectTreeEntries(
  entries: Array<{ path: string; mode: string; type: string; size?: number }>,
  spec: KnowledgeSourceSpec,
): Array<{ path: string }> {
  const prefix = spec.path.replace(/\/+$/, "").replace(/^\/+/, "");
  const extensions = spec.kind === "skill" ? SKILL_EXTENSIONS : HANDBOOK_EXTENSIONS;
  const maxFiles = spec.kind === "skill" ? MAX_SKILL_FILES : MAX_HANDBOOK_FILES;
  const selected: Array<{ path: string }> = [];
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    // Regular files only: symlinks (mode 120000) are rejected outright.
    if (entry.mode !== "100644" && entry.mode !== "100755") continue;
    if (prefix && !(entry.path === prefix || entry.path.startsWith(`${prefix}/`))) continue;
    if (!extensions.has(extensionOf(entry.path))) continue;
    if (isConfigLikeManifest(entry.path)) continue;
    try {
      validateRelativePath(entry.path);
    } catch {
      continue; // untrusted listing: silently drop unsafe entries
    }
    selected.push({ path: entry.path });
    if (selected.length >= maxFiles) break;
  }
  return selected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Fetch + atomic cache write
// ---------------------------------------------------------------------------

/** Bounded-retry wrapper around any fetcher: retries network errors, 5xx and 429 only. */
function retryingFetcher(inner: KnowledgeFetcher): KnowledgeFetcher {
  return async (url, init) => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
      try {
        const response = await inner(url, init);
        if (response.status === 200) return response;
        // Non-2xx: 4xx (except 429) are terminal; 5xx/429 are retryable.
        if (response.status < 500 && response.status !== 429) return response;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt < FETCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, FETCH_BACKOFF_MS * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("fetch failed");
  };
}

/** Deadline wrapper so a source fetch never hangs the worker boot. */
async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its ${timeoutMs}ms deadline`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface FetchedSource {
  ref: string;
  files: KnowledgeFileRecord[];
  contents: Map<string, string>;
}

async function fetchSource(
  fetcher: KnowledgeFetcher,
  spec: KnowledgeSourceSpec,
  timeoutMs: number,
  logger: pino.Logger,
): Promise<FetchedSource> {
  const { owner, repo } = parseOwnerRepo(spec.repo);
  const pinnedSha = await resolveCommitSha(fetcher, owner, repo, spec.ref, timeoutMs);
  const tree = await fetchRepoTree(fetcher, owner, repo, pinnedSha, timeoutMs);
  const selected = selectTreeEntries(tree, spec);
  const files: KnowledgeFileRecord[] = [];
  const contents = new Map<string, string>();
  let totalBytes = 0;
  for (const entry of selected) {
    const text = await fetchFileContent(fetcher, owner, repo, entry.path, pinnedSha, timeoutMs);
    if (text.trim().length === 0) {
      logger.debug({ source: spec.kind, path: entry.path }, "Knowledge file is empty; skipped");
      continue;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > spec.maxBytes || bytes > MAX_FILE_BYTES) {
      throw new Error(`knowledge file '${entry.path}' (${bytes} bytes) exceeds the per-file size limit`);
    }
    totalBytes += bytes;
    if (totalBytes > spec.maxBytes) {
      throw new Error(`knowledge source '${spec.kind}' exceeds its ${spec.maxBytes}-byte budget`);
    }
    contents.set(entry.path, text);
    files.push({ path: entry.path, sha256: sha256Hex(text), bytes });
  }
  if (files.length === 0) {
    throw new Error(`no usable knowledge files found in '${spec.repo}'@${pinnedSha}`);
  }
  return { ref: pinnedSha, files, contents };
}

/** Write a fetched source to the cache: temp dir + atomic rename, manifest last. */
async function writeCacheEntry(
  cacheDir: string,
  kind: "skill" | "handbook",
  ref: string,
  files: KnowledgeFileRecord[],
  contents: Map<string, string>,
): Promise<{ dir: string; manifest: KnowledgeManifest }> {
  const dir = path.join(cacheDir, kind, knowledgeRefSlug(ref));
  const tempDir = path.join(cacheDir, `.tmp-${kind}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(tempDir, { recursive: true });
  try {
    for (const file of files) {
      const target = path.join(tempDir, file.path);
      validateRelativePath(file.path);
      const resolved = path.resolve(target);
      if (!resolved.startsWith(path.resolve(tempDir) + path.sep)) {
        throw new Error(`knowledge write escaped the cache directory: '${file.path}'`);
      }
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      await fsp.writeFile(resolved, contents.get(file.path) ?? "", "utf8");
    }
    const manifest: KnowledgeManifest = {
      ref,
      fetchedAt: new Date().toISOString(),
      contentHash: computeContentHash(files),
      status: "fresh",
      files,
    };
    await fsp.writeFile(path.join(tempDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rename(tempDir, dir); // atomic swap: never leaves a partial tree
    return { dir, manifest };
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Cache validation
// ---------------------------------------------------------------------------

interface CachedEntry {
  dir: string;
  manifest: KnowledgeManifest;
}

/** Read + validate a cached copy: manifest parses and every file hash matches. */
async function readCachedEntry(cacheDir: string, kind: "skill" | "handbook", ref: string): Promise<CachedEntry | null> {
  const dir = path.join(cacheDir, kind, knowledgeRefSlug(ref));
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(dir, "manifest.json"), "utf8");
  } catch {
    return null;
  }
  let manifest: KnowledgeManifest;
  try {
    manifest = JSON.parse(raw) as KnowledgeManifest;
  } catch {
    return null;
  }
  if (manifest.ref !== ref || !Array.isArray(manifest.files) || manifest.files.length === 0) return null;
  try {
    for (const file of manifest.files) {
      validateRelativePath(file.path);
      const content = await fsp.readFile(path.join(dir, file.path), "utf8");
      if (sha256Hex(content) !== file.sha256) return null;
      if (Buffer.byteLength(content, "utf8") !== file.bytes) return null;
    }
  } catch {
    return null;
  }
  if (computeContentHash(manifest.files) !== manifest.contentHash) return null;
  return { dir, manifest };
}

// ---------------------------------------------------------------------------
// Per-source ensure
// ---------------------------------------------------------------------------

async function ensureSource(
  cacheDir: string,
  spec: KnowledgeSourceSpec,
  fetcher: KnowledgeFetcher,
  timeoutMs: number,
  logger: pino.Logger,
): Promise<KnowledgeSourceSnapshot> {
  // Branch names are case-sensitive on GitHub; only SHA comparisons are
  // case-insensitive. Never lowercase a ref before resolving it.
  const requestedRef = (spec.refOverride ?? "").trim() || spec.ref;
  const normalizedSha = requestedRef.toLowerCase();

  // 1. Valid cached copy for the requested ref → reuse, no network.
  if (/^[0-9a-f]{40}$/.test(normalizedSha)) {
    const cached = await readCachedEntry(cacheDir, spec.kind, normalizedSha);
    if (cached) {
      logger.info(
        { source: spec.kind, ref: cached.manifest.ref, status: cached.manifest.status, files: cached.manifest.files.length },
        "Knowledge source: reusing validated cache entry",
      );
      return toSnapshot(cached.manifest.status, cached.manifest.ref, cached.manifest.contentHash, cached.dir, cached.manifest.files);
    }
  }

  // 2. Fetch with a hard per-source deadline (covers every retry attempt).
  try {
    const fetched = await withDeadline(
      fetchSource(fetcher, { ...spec, ref: requestedRef }, timeoutMs, logger),
      timeoutMs,
      `knowledge source '${spec.kind}'`,
    );
    const { dir, manifest } = await writeCacheEntry(
      cacheDir,
      spec.kind,
      fetched.ref,
      fetched.files,
      fetched.contents,
    );
    logger.info(
      { source: spec.kind, ref: manifest.ref, files: manifest.files.length, contentHash: manifest.contentHash },
      "Knowledge source fetched and cached",
    );
    return toSnapshot("fresh", manifest.ref, manifest.contentHash, dir, manifest.files);
  } catch (error) {
    logger.warn(
      { source: spec.kind, err: error instanceof Error ? error.message : String(error) },
      "Knowledge source fetch failed",
    );
    // 3. No fallback content: the source is unavailable, and any review type
    //    that needs it fails fast in injection. Standard reviews unaffected.
    return toSnapshot("unavailable", requestedRef, null, null, []);
  }
}

function toSnapshot(
  status: KnowledgeSourceSnapshot["status"],
  ref: string,
  contentHash: string | null,
  dir: string | null,
  files: KnowledgeFileRecord[],
): KnowledgeSourceSnapshot {
  return { status, ref, contentHash, dir, files };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface EnsureKnowledgeOptions {
  /** Resolved cache directory (worker resolves the workspace-relative default). */
  cacheDir?: string;
  fetcher?: KnowledgeFetcher;
}

/** Per-technology handbook ref resolved from config into a fetchable spec. */
export interface HandbookVariantSpec {
  technologies: string[];
  spec: KnowledgeSourceSpec;
}

/** Build the per-source specs from the (validated) review configuration. */
export function knowledgeSpecsFromConfig(config: ReviewConfig, env: NodeJS.ProcessEnv = process.env): {
  cacheDir: string;
  timeoutMs: number;
  skill: KnowledgeSourceSpec;
  handbook: KnowledgeSourceSpec;
  handbookVariants: HandbookVariantSpec[];
} {
  const knowledge = config.knowledge;
  const handbookBase: KnowledgeSourceSpec = {
    kind: "handbook",
    repo: knowledge.handbook.repo,
    ref: knowledge.handbook.ref,
    path: knowledge.handbook.path,
    maxBytes: knowledge.handbook.maxBytes,
    refOverride: env.KNOWLEDGE_HANDBOOK_REF,
  };
  return {
    cacheDir: knowledge.cacheDir.trim() || (env.KNOWLEDGE_CACHE_DIR ?? "").trim(),
    timeoutMs: knowledge.fetchTimeoutMs,
    skill: {
      kind: "skill",
      repo: knowledge.skill.repo,
      ref: knowledge.skill.ref,
      path: knowledge.skill.skillDir,
      maxBytes: knowledge.skill.maxBytes,
      refOverride: env.KNOWLEDGE_SKILL_REF,
    },
    handbook: handbookBase,
    handbookVariants: knowledge.handbook.technologyRefs.map((variant) => ({
      technologies: variant.technologies.map((tech) => tech.trim().toLowerCase()).filter(Boolean),
      // Variant refs are explicit config; only the default handbook ref can
      // be overridden by KNOWLEDGE_HANDBOOK_REF.
      spec: { ...handbookBase, ref: variant.ref, refOverride: undefined },
    })),
  };
}

let inflight: Promise<KnowledgeSnapshot> | null = null;
let inflightKey = "";

/**
 * Initialize the knowledge sources once per worker boot. Idempotent and
 * concurrency-safe: concurrent calls for the same cache directory share one
 * initialization promise. A failed source degrades to "unavailable" (there
 * is no fallback content) — this function NEVER rejects.
 */
export async function ensureKnowledgeSources(
  config: ReviewConfig,
  logger: pino.Logger,
  options: EnsureKnowledgeOptions = {},
): Promise<KnowledgeSnapshot> {
  const specs = knowledgeSpecsFromConfig(config);
  const cacheDir = (options.cacheDir ?? specs.cacheDir).trim();
  if (!cacheDir) {
    logger.warn("Knowledge cache directory not configured; knowledge sources unavailable");
    return {
      cacheDir: "",
      skill: toSnapshot("unavailable", "", null, null, []),
      handbook: toSnapshot("unavailable", "", null, null, []),
      handbookVariants: [],
    };
  }
  const key = cacheDir;
  if (inflight && inflightKey === key) return inflight;

  const run = (async (): Promise<KnowledgeSnapshot> => {
    await fsp.mkdir(cacheDir, { recursive: true });
    const fetcher = retryingFetcher(options.fetcher ?? createDefaultKnowledgeFetcher());

    // One fetch per distinct handbook ref: variants that reuse the default
    // ref (or each other) share the same cache entry and promise.
    const handbookByRef = new Map<string, Promise<KnowledgeSourceSnapshot>>();
    const ensureHandbookRef = (spec: KnowledgeSourceSpec): Promise<KnowledgeSourceSnapshot> => {
      const effectiveRef = (spec.refOverride ?? "").trim() || spec.ref;
      const key = `${spec.repo}\u0000${effectiveRef}\u0000${spec.path}`;
      let pending = handbookByRef.get(key);
      if (!pending) {
        pending = ensureSource(cacheDir, spec, fetcher, specs.timeoutMs, logger);
        handbookByRef.set(key, pending);
      }
      return pending;
    };

    const [skill, handbook, handbookVariants] = await Promise.all([
      ensureSource(cacheDir, specs.skill, fetcher, specs.timeoutMs, logger),
      ensureHandbookRef(specs.handbook),
      Promise.all(
        specs.handbookVariants.map(async (variant) => ({
          technologies: variant.technologies,
          source: await ensureHandbookRef(variant.spec),
        })),
      ),
    ]);
    return { cacheDir, skill, handbook, handbookVariants };
  })();

  inflight = run;
  inflightKey = key;
  try {
    return await run;
  } finally {
    if (inflightKey === key) {
      inflight = null;
      inflightKey = "";
    }
  }
}

/**
 * Per-review knowledge snapshot materialization (reproducibility, §4).
 *
 * A review must retain the EXACT knowledge content it started with, even if
 * a worker restart refreshes the shared cache mid-review. At pipeline start:
 *
 *  1. The resolved knowledge files for this review's type are copied from
 *     the shared boot-time cache into the review's OWN workspace directory
 *     (`<workspacePath>/knowledge/<source>/...`), where they live and die
 *     with the workspace (no separate cleanup lifecycle needed — note: no
 *     extra ReviewWorkspace rows are created, because the cleanup service
 *     removes the newest "active" row only and separate rows would leak the
 *     clone directory).
 *  2. The snapshot identity { ref, contentHash, files[{path, sha256}] } is
 *     persisted on the Review row (`knowledgeSnapshot` JSON column) — once:
 *     recovery paths never mutate another review's snapshot.
 *  3. Injection reads ONLY the review's own copies, never the shared cache.
 *
 * Recovery (worker restart mid-review): if the review already carries a
 * persisted snapshot, it is honored — the boot-time snapshot must still
 * resolve to the same ref AND content hash; otherwise the review fails fast
 * with KNOWLEDGE_SNAPSHOT_UNAVAILABLE (never silently re-reviewed against
 * different knowledge).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type pino from "pino";
import { sha256Hex } from "./fetch.js";
import {
  knowledgeRefSlug,
  type KnowledgeSnapshot,
  type KnowledgeSourceSnapshot,
  type PersistedKnowledgeSnapshot,
  type PersistedKnowledgeSource,
} from "./types.js";

export type KnowledgeKind = "skill" | "handbook";

/** Kinds each review type materializes (standard reviews need none). */
const KINDS_BY_REVIEW_TYPE: Record<string, KnowledgeKind[]> = {
  skill: ["skill"],
  handbook: ["handbook"],
};

export class KnowledgeSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeSnapshotError";
  }
}

function persistedFromSource(source: KnowledgeSourceSnapshot): PersistedKnowledgeSource {
  return {
    ref: source.ref,
    status: source.status,
    contentHash: source.contentHash ?? "",
    files: source.files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
  };
}

/** Directory holding one handbook variant inside the review's knowledge copy. */
export function handbookVariantDir(knowledgeDir: string, ref: string): string {
  return path.join(knowledgeDir, "handbook-variants", knowledgeRefSlug(ref));
}

/** Copy one source's cached files into a target directory, verifying hashes. */
async function copySource(source: KnowledgeSourceSnapshot, targetRoot: string): Promise<void> {
  if (source.status === "unavailable" || !source.dir) return;
  for (const file of source.files) {
    const sourcePath = path.join(source.dir, file.path);
    const targetPath = path.join(targetRoot, file.path);
    const resolved = path.resolve(targetPath);
    if (!resolved.startsWith(path.resolve(targetRoot) + path.sep)) {
      throw new KnowledgeSnapshotError(`knowledge copy escaped the workspace: '${file.path}'`);
    }
    const content = await fs.readFile(sourcePath, "utf8");
    if (sha256Hex(content) !== file.sha256) {
      throw new KnowledgeSnapshotError(`cached knowledge file '${file.path}' no longer matches its manifest hash`);
    }
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");
  }
}

function sameSource(a: PersistedKnowledgeSource | undefined, b: KnowledgeSourceSnapshot | undefined): boolean {
  if (!a || !b) return false;
  if (a.status === "unavailable" || b.status === "unavailable")
    return a.status === b.status && a.contentHash === (b.contentHash ?? "");
  return a.ref === b.ref && a.contentHash === b.contentHash;
}

/** Same technology list, order-insensitive (config order is not identity). */
function sameTechnologies(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].map((tech) => tech.toLowerCase()).sort();
  const right = [...b].map((tech) => tech.toLowerCase()).sort();
  return left.every((tech, index) => tech === right[index]);
}

/**
 * Recovery-path check for per-technology handbook refs: the persisted set
 * must exactly match the boot snapshot (same technologies + reproducible
 * source), otherwise the review fails fast instead of silently changing the
 * standard it is judged against.
 */
function verifyHandbookVariants(stored: PersistedKnowledgeSnapshot, snapshot: KnowledgeSnapshot): void {
  const persisted = stored.handbookVariants ?? [];
  // Unavailable refs are never persisted; compare against reproducible ones.
  const current = (snapshot.handbookVariants ?? []).filter((variant) => variant.source.status !== "unavailable");
  if (persisted.length !== current.length) {
    throw new KnowledgeSnapshotError("Persisted handbook technology refs can no longer be reproduced from the cache");
  }
  for (const variant of persisted) {
    const match = current.find(
      (candidate) =>
        candidate.source.ref === variant.source.ref && sameTechnologies(candidate.technologies, variant.technologies),
    );
    if (!match || !sameSource(variant.source, match.source)) {
      throw new KnowledgeSnapshotError(
        `Persisted handbook technology ref '${variant.source.ref}' can no longer be reproduced from the cache`,
      );
    }
  }
}

export interface MaterializeKnowledgeInput {
  reviewId: string;
  reviewType: string;
  workspacePath: string;
  /** Boot-time snapshot (may be null when knowledge init never ran). */
  snapshot: KnowledgeSnapshot | null;
  prisma: Pick<PrismaClient, "review">;
  logger: pino.Logger;
}

export interface MaterializeKnowledgeResult {
  /** Directory holding the review's own knowledge copy (null when nothing needed). */
  knowledgeDir: string | null;
  snapshot: KnowledgeSnapshot | null;
}

/**
 * Materialize the review's own knowledge copy and persist its identity.
 * Idempotent: an existing persisted snapshot is reused (verified against the
 * boot snapshot), never rewritten.
 */
export async function materializeReviewKnowledge(
  input: MaterializeKnowledgeInput,
): Promise<MaterializeKnowledgeResult> {
  const kinds = KINDS_BY_REVIEW_TYPE[input.reviewType] ?? [];
  if (kinds.length === 0) return { knowledgeDir: null, snapshot: input.snapshot };

  if (!input.snapshot) {
    // Knowledge init never ran (e.g. tests / degraded boot): there is no
    // fallback content, so skill and handbook reviews fail in injection.
    input.logger.warn({ reviewId: input.reviewId }, "No boot-time knowledge snapshot available");
    return { knowledgeDir: null, snapshot: null };
  }

  const review = await input.prisma.review.findUnique({
    where: { id: input.reviewId },
    select: { knowledgeSnapshot: true },
  });
  if (!review) throw new KnowledgeSnapshotError(`Review '${input.reviewId}' not found for knowledge materialization`);

  const stored = (review.knowledgeSnapshot ?? null) as PersistedKnowledgeSnapshot | null;
  if (stored) {
    // Recovery path: verify the persisted snapshot is still reproducible.
    for (const kind of kinds) {
      const persisted = stored[kind];
      if (!persisted) continue;
      const current = input.snapshot[kind];
      if (!sameSource(persisted, current)) {
        throw new KnowledgeSnapshotError(
          `Persisted knowledge snapshot for '${kind}' (ref '${persisted.ref}', hash '${persisted.contentHash.slice(0, 12)}') can no longer be reproduced from the cache`,
        );
      }
    }
    if (kinds.includes("handbook")) verifyHandbookVariants(stored, input.snapshot);
  }

  const knowledgeDir = path.join(input.workspacePath, "knowledge");
  for (const kind of kinds) {
    await copySource(input.snapshot[kind], path.join(knowledgeDir, kind));
  }
  if (kinds.includes("handbook")) {
    for (const variant of input.snapshot.handbookVariants ?? []) {
      await copySource(variant.source, handbookVariantDir(knowledgeDir, variant.source.ref));
    }
  }

  if (!stored) {
    const persisted: PersistedKnowledgeSnapshot = {};
    for (const kind of kinds) {
      const source = input.snapshot[kind];
      if (source.status !== "unavailable") persisted[kind] = persistedFromSource(source);
    }
    const variants = (input.snapshot.handbookVariants ?? []).filter(
      (variant) => variant.source.status !== "unavailable",
    );
    if (kinds.includes("handbook") && variants.length > 0) {
      persisted.handbookVariants = variants.map((variant) => ({
        technologies: variant.technologies,
        source: persistedFromSource(variant.source),
      }));
    }
    await input.prisma.review.update({
      where: { id: input.reviewId },
      data: { knowledgeSnapshot: persisted as object },
    });
  }

  return { knowledgeDir, snapshot: input.snapshot };
}

/**
 * Persist the per-review knowledge injection metrics (§16.1) on the Review
 * row's knowledgeSnapshot JSON — merged additively, never rewriting the
 * persisted snapshot identity. Best-effort at the call site: metrics
 * failures must not fail a completed review.
 */
export async function persistKnowledgeMetrics(
  prisma: Pick<PrismaClient, "review">,
  reviewId: string,
  source: "skill" | "handbook",
  metrics: {
    injectedTokens: number;
    documentsRetrieved: number;
    candidates: number;
    relevant: number;
    selected: number;
    truncated: boolean;
  },
): Promise<void> {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: { knowledgeSnapshot: true },
  });
  if (!review) return; // row gone — nothing to persist
  const stored = (review.knowledgeSnapshot ?? null) as PersistedKnowledgeSnapshot | null;
  const merged: PersistedKnowledgeSnapshot = { ...(stored ?? {}), metrics: { source, ...metrics } };
  await prisma.review.update({
    where: { id: reviewId },
    data: { knowledgeSnapshot: merged as object },
  });
}

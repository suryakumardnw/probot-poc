import type { Finding, Prisma, PrismaClient } from "@prisma/client";
import type { FindingEvidence } from "../../modules/review/index.js";
import type {
  CreateFindingInput,
  CreateFindingStatusTransitionInput,
  CreatedFindingRecord,
  FindActiveFindingsInput,
  FindPriorFindingsInput,
  FindingRecord,
  FindingRepository,
  FindingStatusRecord,
  FindingStatusTransitionRepository,
  MarkFindingResolvedInput,
  MarkFindingSupersededInput,
  PriorFindingRecord,
} from "./findings.repository.js";
import { isActiveFindingStatus } from "./findings.repository.js";
import type { FindingsRepositories } from "./findings.unit-of-work.js";

/**
 * Prisma implementation of the finding repository ports.
 *
 * Every factory accepts either the root client or a transaction client. The
 * mappers below convert Prisma rows and the `evidence` JSON column into the
 * module's domain records, so no Prisma type escapes this file. The evidence
 * column is parsed on read (a malformed entry is dropped, never asserted) and
 * rebuilt on write from the typed domain value.
 */

export type PrismaRootClient = PrismaClient;
export type PrismaFindingsDatabaseClient = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Evidence JSON conversion
// ---------------------------------------------------------------------------

function evidenceEntryToJson(entry: FindingEvidence): Prisma.InputJsonObject {
  return {
    file: entry.file,
    ...(entry.line === undefined ? {} : { line: entry.line }),
    excerpt: entry.excerpt,
    reason: entry.reason,
  };
}

function evidenceToJson(evidence: readonly FindingEvidence[]): Prisma.InputJsonArray {
  return evidence.map(evidenceEntryToJson);
}

function mapEvidence(value: Prisma.JsonValue): FindingEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries: FindingEvidence[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const file = item.file;
    const line = item.line;
    const excerpt = item.excerpt;
    const reason = item.reason;
    if (typeof file !== "string" || typeof excerpt !== "string" || typeof reason !== "string") {
      continue;
    }
    if (line !== undefined && line !== null && typeof line !== "number") {
      continue;
    }
    entries.push({
      file,
      ...(typeof line === "number" ? { line } : {}),
      excerpt,
      reason,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapFinding(row: Finding): FindingRecord {
  return {
    id: row.id,
    reviewId: row.reviewId,
    repositoryId: row.repositoryId,
    fingerprint: row.fingerprint,
    category: row.category,
    severity: row.severity,
    confidence: row.confidence,
    title: row.title,
    filePath: row.filePath,
    lineNumber: row.lineNumber,
    description: row.description,
    impact: row.impact,
    recommendation: row.recommendation,
    guideline: row.guideline,
    evidence: mapEvidence(row.evidence),
    verified: row.verified,
    status: row.status,
    reopenedFromFindingId: row.reopenedFromFindingId,
    supersededByReviewId: row.supersededByReviewId,
    resolvedAt: row.resolvedAt,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapCreatedFinding(row: Finding): CreatedFindingRecord {
  const finding = mapFinding(row);
  if (!isActiveFindingStatus(finding.status)) {
    throw new Error(`Persisted finding '${row.id}' has non-active status '${finding.status}'`);
  }
  return { ...finding, status: finding.status };
}

function mapPriorFinding(row: {
  id: string;
  fingerprint: string;
  status: FindingRecord["status"];
  severity: string;
  lineNumber: number;
  createdAt: Date;
}): PriorFindingRecord {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    status: row.status,
    severity: row.severity,
    lineNumber: row.lineNumber,
    createdAt: row.createdAt,
  };
}

function mapFindingStatus(row: { id: string; status: FindingRecord["status"] }): FindingStatusRecord | null {
  return isActiveFindingStatus(row.status) ? { id: row.id, status: row.status } : null;
}

// ---------------------------------------------------------------------------
// Repository factories
// ---------------------------------------------------------------------------

export function createFindingRepository(client: PrismaFindingsDatabaseClient): FindingRepository {
  return {
    async findPriorOccurrences(input: FindPriorFindingsInput): Promise<PriorFindingRecord[]> {
      const rows = await client.finding.findMany({
        where: { repositoryId: input.repositoryId, reviewId: { not: input.excludeReviewId } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          fingerprint: true,
          status: true,
          severity: true,
          lineNumber: true,
          createdAt: true,
        },
      });
      return rows.map(mapPriorFinding);
    },

    async findActiveByReview(input: FindActiveFindingsInput): Promise<FindingStatusRecord[]> {
      const rows = await client.finding.findMany({
        where: { reviewId: input.reviewId, status: { in: [...input.statuses] } },
        select: { id: true, status: true },
      });
      return rows.flatMap((row) => {
        const finding = mapFindingStatus(row);
        return finding ? [finding] : [];
      });
    },

    async findByReview(reviewId: string): Promise<FindingRecord[]> {
      const rows = await client.finding.findMany({
        where: { reviewId },
        orderBy: [{ verified: "desc" }, { severity: "asc" }, { createdAt: "asc" }],
      });
      return rows.map(mapFinding);
    },

    async create(input: CreateFindingInput): Promise<CreatedFindingRecord> {
      const row = await client.finding.create({
        data: {
          reviewId: input.reviewId,
          repositoryId: input.repositoryId,
          fingerprint: input.fingerprint,
          category: input.category,
          severity: input.severity,
          confidence: input.confidence,
          title: input.title,
          filePath: input.filePath,
          lineNumber: input.lineNumber,
          description: input.description,
          impact: input.impact,
          recommendation: input.recommendation,
          guideline: input.guideline,
          evidence: evidenceToJson(input.evidence),
          verified: input.verified,
          status: input.status,
          reopenedFromFindingId: input.reopenedFromFindingId,
        },
      });
      return mapCreatedFinding(row);
    },

    async markResolved(input: MarkFindingResolvedInput): Promise<void> {
      await client.finding.update({
        where: { id: input.findingId },
        data: { status: "resolved", resolvedAt: input.resolvedAt },
      });
    },

    async markSuperseded(input: MarkFindingSupersededInput): Promise<void> {
      await client.finding.update({
        where: { id: input.findingId },
        data: { status: "superseded", supersededByReviewId: input.supersededByReviewId },
      });
    },
  };
}

export function createFindingStatusTransitionRepository(
  client: PrismaFindingsDatabaseClient,
): FindingStatusTransitionRepository {
  return {
    async create(input: CreateFindingStatusTransitionInput): Promise<void> {
      await client.findingStatusTransition.create({
        data: {
          findingId: input.findingId,
          reviewId: input.reviewId,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          reason: input.reason,
        },
      });
    },
  };
}

/** Build the findings repository bundle for one client (root or transaction-scoped). */
export function createFindingsRepositories(client: PrismaFindingsDatabaseClient): FindingsRepositories {
  return {
    findings: createFindingRepository(client),
    statusTransitions: createFindingStatusTransitionRepository(client),
  };
}

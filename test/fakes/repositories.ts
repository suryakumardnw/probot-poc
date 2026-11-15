import type {
  AuditEntry,
  AuditListInput,
  AuditPage,
  AuditRecord,
  AuditRepository,
} from "../../src/modules/admin/audit.repository.js";
import {
  isActiveFindingStatus,
  type ActiveFindingStatus,
  type CreateFindingInput,
  type CreateFindingStatusTransitionInput,
  type CreatedFindingRecord,
  type FindingRecord,
  type FindingRepository,
  type FindingStatusRecord,
  type FindingStatusTransitionRepository,
  type MarkFindingResolvedInput,
  type MarkFindingSupersededInput,
  type PriorFindingRecord,
} from "../../src/modules/findings/findings.repository.js";
import type { FindingsRepositories, FindingsUnitOfWork } from "../../src/modules/findings/findings.unit-of-work.js";
import type {
  OutboxEventRecord,
  OutboxEventWithJob,
  ReviewJobRecord,
} from "../../src/modules/ingestion/ingestion.repository.js";
import type { CreateOutboxEventInput, OutboxRepository } from "../../src/modules/ingestion/outbox.repository.js";
import type {
  PublishedFingerprintRecord,
  PublishingRepositories,
  RecordPublicationInput,
  RecordReviewUsageInput,
  ReviewCommentRepository,
  ReviewPublicationContext,
  ReviewPublicationRepository,
} from "../../src/modules/publishing/publishing.repository.js";
import type {
  CreateWorkspaceInput,
  MarkWorkspaceCleanedInput,
  WorkspaceRecord,
  WorkspaceRepository,
} from "../../src/modules/workspace/workspace.repository.js";
import type { Clock } from "../../src/ports/clock.js";
import { FakeClock } from "./clock.js";

/**
 * In-memory repository fakes for the unit tier.
 *
 * Each class implements its full port, including mutation failures and
 * ordering rules the production queries guarantee, so unit tests can exercise
 * module services without Prisma. Integration and characterization suites keep
 * the real Prisma adapters.
 */

function idFactory(prefix: string): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${next}`;
  };
}

/** Mirrors the Prisma adapter's text-column severity rank (most severe first). */
const SEVERITY_RANK: Readonly<Record<string, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export class FakeFindingRepository implements FindingRepository {
  private readonly clock: Clock;
  private readonly nextId: () => string;
  private rows: FindingRecord[] = [];

  constructor(options: { clock?: Clock; idPrefix?: string } = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.nextId = idFactory(options.idPrefix ?? "finding");
  }

  /** Insert an exact historical row (fixtures with older timestamps). */
  seed(record: FindingRecord): void {
    this.rows.push({ ...record, evidence: [...record.evidence] });
  }

  async findPriorOccurrences(input: { repositoryId: string; excludeReviewId: string }): Promise<PriorFindingRecord[]> {
    return this.rows
      .filter((row) => row.repositoryId === input.repositoryId && row.reviewId !== input.excludeReviewId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => ({
        id: row.id,
        fingerprint: row.fingerprint,
        status: row.status,
        severity: row.severity,
        lineNumber: row.lineNumber,
        createdAt: row.createdAt,
      }));
  }

  async findActiveByReview(input: {
    reviewId: string;
    statuses: readonly ActiveFindingStatus[];
  }): Promise<FindingStatusRecord[]> {
    return this.rows
      .filter(
        (row) =>
          row.reviewId === input.reviewId && isActiveFindingStatus(row.status) && input.statuses.includes(row.status),
      )
      .map((row) => ({ id: row.id, status: activeStatus(row.status) }));
  }

  async findByReview(reviewId: string): Promise<FindingRecord[]> {
    return this.rows
      .filter((row) => row.reviewId === reviewId)
      .sort((a, b) => {
        if (a.verified !== b.verified) {
          // Prisma orderBy: [{ verified: "desc" }, ...].
          return a.verified ? -1 : 1;
        }
        if (a.severity !== b.severity) {
          // Prisma orders severity by the documented severity rank, not the
          // text column's lexicographic order.
          return severityRank(a.severity) - severityRank(b.severity);
        }
        return a.createdAt.getTime() - b.createdAt.getTime();
      })
      .map(copyFinding);
  }

  async create(input: CreateFindingInput): Promise<CreatedFindingRecord> {
    const duplicate = this.rows.some((row) => row.reviewId === input.reviewId && row.fingerprint === input.fingerprint);
    if (duplicate) {
      // Production enforces @@unique([repositoryId, reviewId, fingerprint]);
      // a review already implies its repository, so the review/fingerprint
      // pair is the same constraint for valid rows.
      throw new Error(
        `fake finding repository: duplicate fingerprint ${input.fingerprint} in review ${input.reviewId}`,
      );
    }
    const now = this.clock.now();
    const row: CreatedFindingRecord = {
      id: this.nextId(),
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
      evidence: [...input.evidence],
      verified: input.verified,
      status: input.status,
      reopenedFromFindingId: input.reopenedFromFindingId,
      supersededByReviewId: null,
      resolvedAt: null,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return { ...row, evidence: [...row.evidence] };
  }

  async markResolved(input: MarkFindingResolvedInput): Promise<void> {
    const row = this.require(input.findingId);
    row.status = "resolved";
    row.resolvedAt = input.resolvedAt;
    row.updatedAt = this.clock.now();
  }

  async markSuperseded(input: MarkFindingSupersededInput): Promise<void> {
    const row = this.require(input.findingId);
    row.status = "superseded";
    row.supersededByReviewId = input.supersededByReviewId;
    row.updatedAt = this.clock.now();
  }

  snapshot(): FindingRecord[] {
    return this.rows.map(copyFinding);
  }

  restore(snapshot: readonly FindingRecord[]): void {
    this.rows = snapshot.map(copyFinding);
  }

  private require(findingId: string): FindingRecord {
    const row = this.rows.find((candidate) => candidate.id === findingId);
    if (row === undefined) {
      throw new Error(`fake finding repository: unknown finding ${findingId}`);
    }
    return row;
  }
}

function activeStatus(status: FindingRecord["status"]): ActiveFindingStatus {
  if (!isActiveFindingStatus(status)) {
    throw new Error(`fake finding repository: ${status} is not an active status`);
  }
  return status;
}

function copyFinding(row: FindingRecord): FindingRecord {
  return { ...row, evidence: [...row.evidence] };
}

export class FakeFindingStatusTransitionRepository implements FindingStatusTransitionRepository {
  readonly transitions: Array<CreateFindingStatusTransitionInput & { id: string; createdAt: Date }> = [];
  private readonly clock: Clock;
  private readonly nextId: () => string;

  constructor(options: { clock?: Clock; idPrefix?: string } = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.nextId = idFactory(options.idPrefix ?? "finding-transition");
  }

  async create(input: CreateFindingStatusTransitionInput): Promise<void> {
    this.transitions.push({ ...input, id: this.nextId(), createdAt: this.clock.now() });
  }

  snapshot(): Array<CreateFindingStatusTransitionInput & { id: string; createdAt: Date }> {
    return this.transitions.map((transition) => ({ ...transition }));
  }

  restore(snapshot: ReadonlyArray<CreateFindingStatusTransitionInput & { id: string; createdAt: Date }>): void {
    this.transitions.splice(0, this.transitions.length, ...snapshot.map((transition) => ({ ...transition })));
  }
}

/**
 * Findings unit of work with snapshot rollback: a throwing callback restores
 * both repositories, matching the production transaction boundary.
 */
export class FakeFindingsUnitOfWork implements FindingsUnitOfWork {
  constructor(private readonly repositories: FindingsRepositories) {}

  async execute<T>(work: (repos: FindingsRepositories) => Promise<T>): Promise<T> {
    const findings = this.repositories.findings;
    const transitions = this.repositories.statusTransitions;
    const findingsSnapshot = findings instanceof FakeFindingRepository ? findings.snapshot() : null;
    const transitionsSnapshot =
      transitions instanceof FakeFindingStatusTransitionRepository ? transitions.snapshot() : null;
    try {
      return await work(this.repositories);
    } catch (error) {
      if (findings instanceof FakeFindingRepository && findingsSnapshot !== null) {
        findings.restore(findingsSnapshot);
      }
      if (transitions instanceof FakeFindingStatusTransitionRepository && transitionsSnapshot !== null) {
        transitions.restore(transitionsSnapshot);
      }
      throw error;
    }
  }
}

export function createFakeFindings(options: { clock?: Clock } = {}): {
  findings: FakeFindingRepository;
  statusTransitions: FakeFindingStatusTransitionRepository;
  repositories: FindingsRepositories;
  unitOfWork: FakeFindingsUnitOfWork;
} {
  const findings = new FakeFindingRepository({ ...options, idPrefix: "finding" });
  const statusTransitions = new FakeFindingStatusTransitionRepository({ ...options, idPrefix: "finding-transition" });
  const repositories: FindingsRepositories = { findings, statusTransitions };
  return { findings, statusTransitions, repositories, unitOfWork: new FakeFindingsUnitOfWork(repositories) };
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export class FakeWorkspaceRepository implements WorkspaceRepository {
  private readonly clock: Clock;
  private readonly nextId: () => string;
  private readonly mutationErrors: unknown[] = [];
  private rows: WorkspaceRecord[] = [];

  constructor(options: { clock?: Clock; idPrefix?: string } = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.nextId = idFactory(options.idPrefix ?? "workspace");
  }

  queueMutationError(error: unknown): this {
    this.mutationErrors.push(error);
    return this;
  }

  seed(record: WorkspaceRecord): void {
    this.rows.push({ ...record });
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    const row: WorkspaceRecord = {
      id: this.nextId(),
      reviewId: input.reviewId,
      path: input.path,
      headSha: input.headSha,
      baseSha: input.baseSha,
      mergeBaseSha: input.mergeBaseSha,
      status: "active",
      lastError: null,
      createdAt: this.clock.now(),
      cleanedAt: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async findLatestActive(reviewId: string): Promise<WorkspaceRecord | null> {
    const active = this.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.reviewId === reviewId && row.status === "active")
      .sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime() || b.index - a.index);
    const latest = active[0];
    return latest === undefined ? null : { ...latest.row };
  }

  async findActive(reviewId: string): Promise<WorkspaceRecord[]> {
    return this.rows.filter((row) => row.reviewId === reviewId && row.status === "active").map(copyWorkspace);
  }

  async findActiveCreatedBefore(cutoff: Date): Promise<WorkspaceRecord[]> {
    return this.rows
      .filter((row) => row.status === "active" && row.createdAt.getTime() < cutoff.getTime())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(copyWorkspace);
  }

  /** Test inspection helper; not part of the repository port. */
  findById(workspaceId: string): WorkspaceRecord | null {
    const row = this.rows.find((candidate) => candidate.id === workspaceId);
    return row === undefined ? null : { ...row };
  }

  async markCleaned(workspaceId: string, input?: MarkWorkspaceCleanedInput): Promise<void> {
    this.throwQueuedMutationError();
    const row = this.require(workspaceId);
    row.status = "cleaned";
    row.cleanedAt = this.clock.now();
    if (input !== undefined && input.lastError !== undefined) {
      row.lastError = input.lastError;
    }
  }

  async markFailed(workspaceId: string, lastError: string | null): Promise<void> {
    this.throwQueuedMutationError();
    const row = this.require(workspaceId);
    row.status = "failed";
    row.cleanedAt = this.clock.now();
    row.lastError = lastError;
  }

  private throwQueuedMutationError(): void {
    const error = this.mutationErrors.shift();
    if (error !== undefined) {
      throw error;
    }
  }

  private require(workspaceId: string): WorkspaceRecord {
    const row = this.rows.find((candidate) => candidate.id === workspaceId);
    if (row === undefined) {
      throw new Error(`fake workspace repository: unknown workspace ${workspaceId}`);
    }
    return row;
  }
}

function copyWorkspace(row: WorkspaceRecord): WorkspaceRecord {
  return { ...row };
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

interface FakeCommentState {
  summaryCommentId: number | null;
  inline: Map<string, PublishedFingerprintRecord>;
  failed: boolean;
}

export class FakeReviewCommentRepository implements ReviewCommentRepository {
  private readonly reviews = new Map<string, FakeCommentState>();
  private readonly recordPublicationErrors: unknown[] = [];

  queueRecordPublicationError(error: unknown): this {
    this.recordPublicationErrors.push(error);
    return this;
  }

  async listPublishedFingerprints(reviewId: string): Promise<PublishedFingerprintRecord[]> {
    const state = this.reviews.get(reviewId);
    return state === undefined ? [] : [...state.inline.values()].map((record) => ({ ...record }));
  }

  async findPublishedSummaryCommentId(reviewId: string): Promise<number | null> {
    return this.reviews.get(reviewId)?.summaryCommentId ?? null;
  }

  async recordPublication(input: RecordPublicationInput): Promise<void> {
    throwQueuedError(this.recordPublicationErrors);
    const state = this.stateFor(input.reviewId);
    if (input.summary !== null) {
      state.summaryCommentId = input.summary.githubCommentId;
    }
    for (const inline of input.inlineComments) {
      state.inline.set(inline.fingerprint, {
        fingerprint: inline.fingerprint,
        githubCommentId: inline.githubCommentId,
      });
    }
  }

  async recordFailure(reviewId: string): Promise<void> {
    // Matches the Prisma adapter: the failure marker is best-effort, so a
    // write problem must not turn into a caller-visible exception.
    this.stateFor(reviewId).failed = true;
  }

  wasMarkedFailed(reviewId: string): boolean {
    return this.reviews.get(reviewId)?.failed ?? false;
  }

  private stateFor(reviewId: string): FakeCommentState {
    const existing = this.reviews.get(reviewId);
    if (existing !== undefined) {
      return existing;
    }
    const state: FakeCommentState = { summaryCommentId: null, inline: new Map(), failed: false };
    this.reviews.set(reviewId, state);
    return state;
  }
}

export class FakeReviewPublicationRepository implements ReviewPublicationRepository {
  private readonly contexts = new Map<string, ReviewPublicationContext>();
  private readonly markPublishSkippedErrors: unknown[] = [];
  private readonly recordUsageErrors: unknown[] = [];
  readonly skippedReviewIds = new Set<string>();
  readonly usage: RecordReviewUsageInput[] = [];

  constructor(contexts: readonly ReviewPublicationContext[] = []) {
    for (const context of contexts) {
      this.contexts.set(context.reviewId, { ...context });
    }
  }

  queueMarkPublishSkippedError(error: unknown): this {
    this.markPublishSkippedErrors.push(error);
    return this;
  }

  queueRecordUsageError(error: unknown): this {
    this.recordUsageErrors.push(error);
    return this;
  }

  setReviewContext(context: ReviewPublicationContext): void {
    this.contexts.set(context.reviewId, { ...context });
  }

  async findReviewContext(reviewId: string): Promise<ReviewPublicationContext | null> {
    const context = this.contexts.get(reviewId);
    return context === undefined ? null : { ...context };
  }

  async markPublishSkipped(reviewId: string): Promise<void> {
    throwQueuedError(this.markPublishSkippedErrors);
    this.skippedReviewIds.add(reviewId);
  }

  async recordUsage(input: RecordReviewUsageInput): Promise<void> {
    throwQueuedError(this.recordUsageErrors);
    this.usage.push({ ...input });
  }
}

function throwQueuedError(errors: unknown[]): void {
  const error = errors.shift();
  if (error !== undefined) {
    throw error;
  }
}

export function createFakePublishingRepositories(
  contexts: readonly ReviewPublicationContext[] = [],
): PublishingRepositories & { comments: FakeReviewCommentRepository; reviews: FakeReviewPublicationRepository } {
  return {
    comments: new FakeReviewCommentRepository(),
    reviews: new FakeReviewPublicationRepository(contexts),
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export class FakeAuditRepository implements AuditRepository {
  readonly rows: AuditRecord[] = [];
  private readonly clock: Clock;
  private readonly nextId: () => string;
  private readonly recordErrors: unknown[] = [];

  constructor(options: { clock?: Clock; idPrefix?: string } = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.nextId = idFactory(options.idPrefix ?? "audit");
  }

  queueRecordError(error: unknown): this {
    this.recordErrors.push(error);
    return this;
  }

  async record(entry: AuditEntry): Promise<void> {
    const error = this.recordErrors.shift();
    if (error !== undefined) {
      throw error;
    }
    this.rows.push({
      id: this.nextId(),
      actor: entry.actor,
      action: entry.action,
      resource: entry.resource,
      metadata: entry.metadata ?? null,
      createdAt: this.clock.now(),
    });
  }

  async listPage(input: AuditListInput): Promise<AuditPage> {
    const newestFirst = [...this.rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      total: newestFirst.length,
      rows: newestFirst.slice(input.offset, input.offset + input.limit).map((row) => ({ ...row })),
    };
  }
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export class FakeOutboxRepository implements OutboxRepository {
  private readonly clock: Clock;
  private readonly nextId: () => string;
  private readonly jobs: ReadonlyMap<string, ReviewJobRecord>;
  private rows: OutboxEventRecord[] = [];

  constructor(options: { clock?: Clock; idPrefix?: string; jobs?: ReadonlyMap<string, ReviewJobRecord> } = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.nextId = idFactory(options.idPrefix ?? "outbox");
    this.jobs = options.jobs ?? new Map();
  }

  seed(record: OutboxEventRecord): void {
    this.rows.push({ ...record });
  }

  async create(input: CreateOutboxEventInput): Promise<OutboxEventRecord> {
    const row: OutboxEventRecord = {
      id: this.nextId(),
      reviewJobId: input.reviewJobId,
      type: input.type,
      payload: input.payload,
      status: "pending",
      attempts: 0,
      lastError: null,
      publishedAt: null,
      createdAt: this.clock.now(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async findByIdWithJob(eventId: string): Promise<OutboxEventWithJob | null> {
    const row = this.rows.find((candidate) => candidate.id === eventId);
    if (row === undefined) {
      return null;
    }
    const job = this.jobs.get(row.reviewJobId);
    if (job === undefined) {
      throw new Error(`fake outbox repository: review job ${row.reviewJobId} is not registered`);
    }
    return { ...row, reviewJob: { ...job } };
  }

  async findLatestForJob(reviewJobId: string): Promise<OutboxEventRecord | null> {
    const matches = this.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.reviewJobId === reviewJobId)
      .sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime() || b.index - a.index);
    const latest = matches[0];
    return latest === undefined ? null : { ...latest.row };
  }

  async findPendingIds(limit: number): Promise<string[]> {
    return this.rows
      .filter((row) => row.status === "pending")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((row) => row.id);
  }

  async markPublished(eventId: string, publishedAt: Date): Promise<void> {
    const row = this.require(eventId);
    row.status = "published";
    row.publishedAt = publishedAt;
    row.lastError = null;
  }

  async discard(eventId: string, lastError: string): Promise<void> {
    const row = this.require(eventId);
    row.status = "discarded";
    row.lastError = lastError;
  }

  async discardIfPending(eventId: string, lastError: string): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === eventId);
    if (row === undefined || row.status !== "pending") {
      return false;
    }
    row.status = "discarded";
    row.lastError = lastError;
    return true;
  }

  async discardPendingForJob(reviewJobId: string, lastError: string): Promise<void> {
    for (const row of this.rows) {
      if (row.reviewJobId === reviewJobId && row.status === "pending") {
        row.status = "discarded";
        row.lastError = lastError;
      }
    }
  }

  async incrementAttemptsIfPending(eventId: string, lastError: string): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === eventId);
    if (row !== undefined && row.status === "pending") {
      row.attempts += 1;
      row.lastError = lastError;
    }
  }

  private require(eventId: string): OutboxEventRecord {
    const row = this.rows.find((candidate) => candidate.id === eventId);
    if (row === undefined) {
      throw new Error(`fake outbox repository: unknown outbox event ${eventId}`);
    }
    return row;
  }
}

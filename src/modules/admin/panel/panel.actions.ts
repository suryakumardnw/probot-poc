import type { ServerResponse } from "node:http";
import { ConfigValidationError, type LoadedReviewConfig, type ReviewConfig } from "../../../ports/review-config.js";
import type { AdminPanelDeps } from "../admin.types.js";
import type { AuditAction, AuditMetadata } from "../audit.repository.js";
import type { AdminSession } from "../auth/session.js";
import { SECTION_LABELS, type PanelSection } from "./fields.js";
import { buildCandidate, lastValue, sensitiveChanges } from "./forms.js";
import {
  noticeText,
  page,
  parseIssuePaths,
  redirect,
  renderAuditBody,
  renderInterstitialBody,
  renderSectionBody,
  type PanelVersion,
} from "./render.js";

const AUDIT_PAGE_SIZE = 20;

/**
 * Admin panel write-side actions (ticket 14).
 *
 * Every write goes through the SAME primitives as PUT /api/admin/config
 * (`ReviewConfigStore.update` / `restoreLastKnownGood`), so the atomicity,
 * validation-before-write and last-known-good guarantees are identical.
 */

export interface PanelActions {
  handleReload(res: ServerResponse, session: AdminSession): Promise<void>;
  handleRollback(res: ServerResponse, session: AdminSession): Promise<void>;
  handleSectionPost(
    res: ServerResponse,
    url: URL,
    section: PanelSection,
    form: Record<string, string | string[]>,
    session: AdminSession,
    version: PanelVersion | null,
  ): Promise<void>;
  handleAuditHistory(res: ServerResponse, url: URL, session: AdminSession, version: PanelVersion | null): Promise<void>;
}

export function createPanelActions(deps: AdminPanelDeps): PanelActions {
  async function audit(actor: string, action: AuditAction, resource: string, metadata?: AuditMetadata): Promise<void> {
    await deps.audit.record({ actor, action, resource, metadata });
  }

  // -------------------------------------------------------------------------
  // Reload / rollback (same primitives as the admin API)
  // -------------------------------------------------------------------------

  async function handleReload(res: ServerResponse, session: AdminSession): Promise<void> {
    const loaded = deps.config.load({ updateLastKnownGood: true });
    await audit(session.login, "config.reload", "configuration", {
      fromLastKnownGood: loaded.fromLastKnownGood,
      hash: loaded.snapshot.hash,
    });
    deps.logger.info({ login: session.login, hash: loaded.snapshot.hash }, "Admin panel: configuration reloaded");
    redirect(res, "/admin?notice=reloaded");
  }

  async function handleRollback(res: ServerResponse, session: AdminSession): Promise<void> {
    // Existence probe only; restore validates the snapshot.
    if (deps.config.lastKnownGoodStatus() === "missing") {
      await audit(session.login, "config.rollback_failed", "configuration", { reason: "no last-known-good snapshot" });
      redirect(res, "/admin?error=no-snapshot");
      return;
    }
    try {
      const restored = deps.config.restoreLastKnownGood();
      await audit(session.login, "config.rollback", "configuration", { restoredHash: restored.snapshot.hash });
      deps.logger.info(
        { login: session.login, hash: restored.snapshot.hash },
        "Admin panel: configuration rolled back",
      );
      redirect(res, "/admin?notice=rolledback");
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        await audit(session.login, "config.rollback_failed", "configuration", {
          reason: "last-known-good snapshot failed validation",
        });
        redirect(res, "/admin?error=rollback-failed");
        return;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Section save / validate
  // -------------------------------------------------------------------------

  async function handleSectionPost(
    res: ServerResponse,
    url: URL,
    section: PanelSection,
    form: Record<string, string | string[]>,
    session: AdminSession,
    version: PanelVersion | null,
  ): Promise<void> {
    const action = lastValue(form, "action") === "validate" ? "validate" : "save";
    const loaded = deps.config.load();
    const { candidate, fieldErrors, submitted } = buildCandidate(section, loaded.config, form);

    if (!submitted && action === "save" && lastValue(form, "confirm") !== "confirmed") {
      redirect(res, `/admin/${section}?error=no-changes`);
      return;
    }

    // Validate the candidate (never persists). Field errors are mapped back to
    // the originating paths so they render beside the fields.
    let validated: ReviewConfig | null = null;
    try {
      validated = deps.config.validate(candidate).config;
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        for (const [issuePath, message] of parseIssuePaths(error.message)) {
          if (issuePath === "(root)" || !fieldErrors.has(issuePath)) {
            fieldErrors.set(issuePath, message);
          }
        }
      } else {
        throw error;
      }
    }

    if (!validated) {
      if (action === "save") {
        await audit(session.login, "config.update_rejected", "configuration", { reason: "validation failed" });
      }
      renderSection(
        res,
        section,
        loaded,
        fieldErrors,
        action === "save" ? "Validation failed — nothing was saved." : null,
        400,
        session,
        version,
        url,
      );
      return;
    }

    if (action === "validate") {
      // Validate WITHOUT persisting.
      renderSection(res, section, loaded, fieldErrors, null, 200, session, version, url, true);
      return;
    }

    // --- Save flow ---------------------------------------------------------

    const redactedPrevious = deps.config.redact(loaded.config);
    const redactedNext = deps.config.redact(validated);
    const changes = sensitiveChanges(section, redactedPrevious, redactedNext);
    const confirmed = lastValue(form, "confirm") === "confirmed";

    if (changes.length > 0 && !confirmed) {
      // Confirmation interstitial: nothing has been persisted yet.
      const candidateJson = JSON.stringify(validated);
      const body = renderInterstitialBody({
        section,
        csrfToken: session.csrfToken,
        changes,
        candidateJson,
      });
      page(res, 200, `Confirm changes — ${SECTION_LABELS[section]}`, body, { active: section, session, version });
      return;
    }

    let finalCandidate: unknown = candidate;
    if (confirmed) {
      const submittedCandidate = lastValue(form, "candidate");
      if (typeof submittedCandidate === "string") {
        try {
          const parsed: unknown = JSON.parse(submittedCandidate);
          finalCandidate = parsed;
        } catch {
          // A malformed hidden field is tampering or a stale page. Fail closed:
          // report a validation error and persist nothing.
          await audit(session.login, "config.update_rejected", "configuration", {
            reason: "invalid candidate JSON",
          });
          fieldErrors.set("(root)", "Submitted configuration is not valid JSON.");
          renderSection(
            res,
            section,
            loaded,
            fieldErrors,
            "Submitted configuration is not valid JSON. Nothing was saved.",
            400,
            session,
            version,
            url,
          );
          return;
        }
      }
    }

    try {
      const result = deps.config.update(finalCandidate);
      await audit(session.login, "config.update", "configuration", {
        previousHash: result.previous.snapshot.hash,
        nextHash: result.next.snapshot.hash,
        nextCapturedAt: result.next.snapshot.capturedAt,
        source: "panel",
        section,
      });
      deps.logger.info(
        { login: session.login, section, hash: result.next.snapshot.hash },
        "Admin panel: configuration saved",
      );
      redirect(res, `/admin/${section}?notice=saved`);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        // Atomic: the store validates before any write.
        await audit(session.login, "config.update_rejected", "configuration", { reason: "validation failed" });
        const errors = parseIssuePaths(error.message);
        for (const [issuePath, message] of errors) {
          if (!fieldErrors.has(issuePath)) {
            fieldErrors.set(issuePath, message);
          }
        }
        renderSection(
          res,
          section,
          loaded,
          fieldErrors,
          "Validation failed — nothing was saved.",
          400,
          session,
          version,
          url,
        );
        return;
      }
      throw error;
    }
  }

  function renderSection(
    res: ServerResponse,
    section: PanelSection,
    loaded: LoadedReviewConfig,
    fieldErrors: Map<string, string>,
    error: string | null,
    status: number,
    session: AdminSession,
    version: PanelVersion | null,
    url: URL,
    validationPassed = false,
  ): void {
    const redacted = deps.config.redact(loaded.config);
    const body = renderSectionBody({
      section,
      config: redacted,
      csrfToken: session.csrfToken,
      fieldErrors,
      notice: noticeText(url.searchParams.get("notice")),
      error,
      validationPassed,
    });
    page(res, status, SECTION_LABELS[section], body, { active: section, session, version });
  }

  // -------------------------------------------------------------------------
  // Audit history
  // -------------------------------------------------------------------------

  async function handleAuditHistory(
    res: ServerResponse,
    url: URL,
    session: AdminSession,
    version: PanelVersion | null,
  ): Promise<void> {
    const pageParam = Number(url.searchParams.get("page") ?? "1");
    const currentPage = Number.isFinite(pageParam) ? Math.max(Math.trunc(pageParam), 1) : 1;

    const auditPage = await deps.audit.listPage({
      limit: AUDIT_PAGE_SIZE,
      offset: (currentPage - 1) * AUDIT_PAGE_SIZE,
    });
    const totalPages = Math.max(Math.ceil(auditPage.total / AUDIT_PAGE_SIZE), 1);

    const body = renderAuditBody({
      rows: auditPage.rows.map((row) => ({
        actor: row.actor,
        action: row.action,
        resource: row.resource,
        createdAt: row.createdAt.toISOString(),
        metadata: row.metadata ? JSON.stringify(row.metadata) : "",
      })),
      page: currentPage,
      totalPages,
    });
    page(res, 200, "Audit History", body, { active: "audit", session, version });
  }

  return { handleReload, handleRollback, handleSectionPost, handleAuditHistory };
}

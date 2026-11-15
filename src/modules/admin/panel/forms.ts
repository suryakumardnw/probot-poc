import type { IncomingMessage } from "node:http";
import { parse as parseFormBody } from "node:querystring";
import type { ReviewConfig } from "../../../ports/review-config.js";
import { getPath, setPath } from "../../../shared/object-path.js";
import { PANEL_FIELDS, type PanelSection } from "./fields.js";
import { displayValue, type SensitiveChange } from "./render.js";

/**
 * Admin panel form parsing and candidate construction (ticket 14).
 *
 * The panel NEVER invents a write path: each field descriptor path is applied
 * to a cloned copy of the current configuration, and the whole candidate is
 * re-validated by the config store before anything is persisted.
 */

const MAX_FORM_BYTES = 512 * 1024;

export interface FormResult {
  ok: boolean;
  fields: Record<string, string | string[]>;
}

export async function readUrlEncodedForm(req: IncomingMessage): Promise<FormResult> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, c) => n + c.length, 0) > MAX_FORM_BYTES) {
      return { ok: false, fields: {} };
    }
  }
  const raw = parseFormBody(Buffer.concat(chunks).toString("utf8"));
  const fields: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    fields[key] = value;
  }
  return { ok: true, fields };
}

export function lastValue(fields: Record<string, string | string[]>, key: string): string | undefined {
  const value = fields[key];
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value[value.length - 1] : value;
}

export interface CandidateResult {
  candidate: ReviewConfig;
  fieldErrors: Map<string, string>;
  submitted: boolean;
}

export function buildCandidate(
  section: PanelSection,
  baseConfig: ReviewConfig,
  form: Record<string, string | string[]>,
): CandidateResult {
  const candidate = structuredClone(baseConfig);
  const fieldErrors = new Map<string, string>();
  let submitted = false;

  for (const field of PANEL_FIELDS[section]) {
    if (field.readonly) {
      continue;
    } // read-only fields are never written by the panel
    const raw = lastValue(form, `f:${field.path}`);
    if (raw === undefined) {
      continue;
    } // untouched (e.g. interstitial round-trip)
    submitted = true;
    try {
      switch (field.type) {
        case "boolean":
          setPath(candidate, field.path, raw === "true");
          break;
        case "number": {
          if (raw.trim() === "") {
            break;
          } // leave unchanged
          const numeric = Number(raw);
          if (!Number.isFinite(numeric)) {
            fieldErrors.set(field.path, "must be a finite number");
            break;
          }
          setPath(candidate, field.path, numeric);
          break;
        }
        case "list":
          setPath(
            candidate,
            field.path,
            raw
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          );
          break;
        default:
          setPath(candidate, field.path, raw);
      }
    } catch {
      fieldErrors.set(field.path, "cannot be applied");
    }
  }
  return { candidate, fieldErrors, submitted };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Detect changes to sensitive (execution-policy) fields, redacted for display. */
export function sensitiveChanges(
  section: PanelSection,
  redactedPrevious: unknown,
  redactedNext: unknown,
): SensitiveChange[] {
  const changes: SensitiveChange[] = [];
  for (const field of PANEL_FIELDS[section]) {
    if (!field.sensitive) {
      continue;
    }
    const before = getPath(redactedPrevious, field.path);
    const after = getPath(redactedNext, field.path);
    if (!deepEqual(before, after)) {
      changes.push({
        path: field.path,
        oldValue: displayValue(before),
        newValue: displayValue(after),
      });
    }
  }
  return changes;
}

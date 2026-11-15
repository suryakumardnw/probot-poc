import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import { adminErrorEnvelopeSchema, type AdminErrorEnvelope } from "../../contracts/admin.js";
import { ERROR_CODES } from "../../contracts/errors.js";
import { toHttpEnvelope } from "../../shared/errors/http-mapper.js";
import { ValidationError, redactDetails, redactSecrets } from "../../shared/errors/index.js";

/**
 * HTTP primitives shared by the admin route modules.
 *
 * Every successful response is parsed against its contract before it is
 * written; every failure goes through the shared error projection so the admin
 * surface keeps one error envelope.
 */

export function sendJson<T>(
  res: ServerResponse,
  status: number,
  schema: z.ZodType<T>,
  body: T,
  headers: Record<string, string> = {},
): void {
  // Parse before writing anything: a response that violates its own contract
  // must fail the request (and map to the internal envelope) instead of
  // leaking an unvalidated shape.
  const payload = schema.parse(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.end(JSON.stringify(payload));
}

/** Map any error through the shared HTTP projection and send the envelope. */
export function sendError(res: ServerResponse, error: unknown, headers: Record<string, string> = {}): void {
  const envelope = toHttpEnvelope(error);
  sendJson(res, envelope.statusCode, adminErrorEnvelopeSchema, envelope.body, headers);
}

/**
 * A known operational 5xx that must keep its status. The shared mapper
 * intentionally collapses caller-authored 5xx text to a generic 500, so these
 * few envelopes are built from literal, developer-authored messages only.
 */
export function sendOperationalError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  details?: AdminErrorEnvelope["details"],
): void {
  const body = adminErrorEnvelopeSchema.parse({
    code: redactSecrets(code),
    message: redactSecrets(message),
    statusCode,
    ...(details === undefined ? {} : { details: redactDetails(details) }),
  });
  sendJson(res, statusCode, adminErrorEnvelopeSchema, body);
}

/** Turn a boundary Zod failure into the standard 400 envelope. */
export function sendValidationFailure(res: ServerResponse, error: z.ZodError): void {
  sendError(
    res,
    new ValidationError("invalid request", {
      code: ERROR_CODES.ADMIN_INVALID_REQUEST,
      details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    }),
  );
}

export function parseQuery<T>(schema: z.ZodType<T>, url: URL) {
  return schema.safeParse(Object.fromEntries(url.searchParams));
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, c) => n + c.length, 0) > maxBytes) {
      throw new BodyTooLargeError();
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidBodyError();
  }
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
  }
}

export class InvalidBodyError extends Error {
  constructor() {
    super("request body must be JSON");
  }
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

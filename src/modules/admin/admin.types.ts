import type { IncomingMessage, ServerResponse } from "node:http";
import type { Env } from "../../config/env.js";
import type { ReviewConfigStore } from "../../ports/review-config.js";
import type { IngestionReadService } from "../ingestion/index.js";
import type { AuditRepository } from "./audit.repository.js";

/** Structured logger surface the admin HTTP and panel entry points need. */
export interface AdminLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/** Dependencies of the JSON admin API (`/api/admin/*`). */
export interface AdminApiDeps {
  env: Env;
  audit: AuditRepository;
  /** Ingestion public service: review status, listing, comparison, manual trigger. */
  ingestion: IngestionReadService;
  /** Review config port: read/validate/update happens behind it. */
  config: ReviewConfigStore;
  logger: AdminLogger;
  now?: () => number;
}

/** Dependencies of the server-rendered HTML panel (`/admin`). */
export interface AdminPanelDeps {
  env: Env;
  audit: AuditRepository;
  config: ReviewConfigStore;
  logger: AdminLogger;
}

/** Per-request state shared by the API route handlers. */
export interface AdminRequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  deps: AdminApiDeps;
  env: Env;
  ip: string;
  now: () => number;
}

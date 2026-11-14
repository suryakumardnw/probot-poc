/**
 * Line-delimited JSON protocol between the parent `SdkHostClient` and the
 * in-child `runHostProcess` host.
 *
 * One JSON request per stdin line, one JSON response per stdout line. Log
 * entries are forwarded as `{ type: "log", ... }` JSON lines on stderr. The
 * parent never parses stderr as protocol; the child never writes diagnostics
 * to stdout.
 */

export type SdkHostMethod =
  | "create"
  | "session.create"
  | "session.get"
  | "session.prompt"
  | "message.list"
  | "session.remove"
  | "close"
  | "health";

export interface SdkHostRequest {
  id: number;
  method: SdkHostMethod;
  params?: unknown;
}

export type SdkHostResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: { message: string; code?: string } };

export interface SdkHostLogEvent {
  type: "log";
  level?: string;
  message?: string;
  cause?: string;
}

/**
 * Isolated SDK host child process (Task 3).
 *
 * Runs the `SdkHostDispatcher` on a line-delimited JSON protocol over
 * stdin/stdout: one request per stdin line, one response per stdout line. SDK
 * log entries are forwarded as `{ type: "log", ... }` JSON lines on stderr.
 *
 * When run directly (`node lib/agent/sdk/host-process.js`) it wires
 * `process.stdin`/`stdout`/`stderr`; when imported (tests, or a future in-memory
 * use) it does nothing until `runHostProcess` is called explicitly.
 */

import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

import { createSdkHostDispatcher, type SdkHostDispatcher } from "./host.js";
import {
  parseSdkHostRequestLine,
  type SdkHostLogEvent,
  type SdkHostRequest,
  type SdkHostResponse,
} from "./protocol.js";
import type { SdkLoader, SdkLogEntry, SdkModule } from "./types.js";

/** Maximum bytes of a single protocol line (a global protocol constraint). */
const MAX_LINE_BYTES = 1024 * 1024; // 1 MiB

export interface RunHostProcessOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
  /** Injectable SDK loader (tests supply a fake module). */
  loadSdk?: SdkLoader;
}

/**
 * Default loader: a dynamic import with a variable specifier. `tsc` must not
 * resolve `@opencode/sdk` (it is not installed in the production image and
 * cannot load on Node 20/22).
 */
const defaultLoadSdk: SdkLoader = async () => {
  const specifier = "@opencode/sdk";
  return (await import(specifier)) as unknown as SdkModule;
};

/** Serialize a single SDK log entry to the stderr stream as a JSON line. */
function writeLogEntry(error: NodeJS.WritableStream, entry: SdkLogEntry): void {
  const event: SdkHostLogEvent = {
    type: "log",
    ...(typeof entry.level === "string" ? { level: entry.level } : {}),
    ...(typeof entry.message === "string"
      ? { message: entry.message }
      : entry.message != null
        ? { message: String(entry.message) }
        : {}),
    ...(entry.cause != null ? { cause: entry.cause instanceof Error ? entry.cause.message : String(entry.cause) } : {}),
  };
  error.write(`${JSON.stringify(event)}\n`);
}

/**
 * Read the input stream as UTF-8 lines and dispatch each non-blank line.
 * Lines are processed sequentially (one response fully written before the next
 * line is handled) and the returned promise resolves once the input closes and
 * every in-flight request has been answered.
 */
export async function runHostProcess(options: RunHostProcessOptions): Promise<void> {
  const { input, output, error } = options;
  const dispatcher: SdkHostDispatcher = createSdkHostDispatcher(
    options.loadSdk ?? defaultLoadSdk,
    (entry: SdkLogEntry) => writeLogEntry(error, entry),
  );

  return await new Promise<void>((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let chain = Promise.resolve();
    let settled = false;

    const respond = (response: SdkHostResponse): void => {
      output.write(`${JSON.stringify(response)}\n`);
    };

    const handleLine = (line: string): Promise<void> => {
      const request = parseRequest(line);
      if (!request.ok) {
        respond({ id: 0, ok: false, error: { message: request.error } });
        return Promise.resolve();
      }
      return dispatcher.handle(request.value).then(respond);
    };

    input.on("data", (chunk: Buffer | string) => {
      buffer += decoder.write(chunk);
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.trim() !== "") {
          chain = chain.then(() => handleLine(line));
        }
        idx = buffer.indexOf("\n");
      }
      // A partial line that outgrows the cap without a newline is discarded so
      // the child never buffers unbounded data.
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        buffer = "";
      }
    });

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      chain.then(() => dispatcher.handle({ id: 0, method: "close" })).then(() => resolve(), reject);
    };

    input.once("end", () => {
      const rest = decoder.end();
      if (rest) {
        buffer += rest;
      }
      if (buffer.trim() !== "") {
        chain = chain.then(() => handleLine(buffer));
        buffer = "";
      }
    });
    input.once("close", finish);
    input.once("error", reject);
  });
}

/** Parse a request line; never throws. */
function parseRequest(line: string): { ok: true; value: SdkHostRequest } | { ok: false; error: string } {
  const parsed = parseSdkHostRequestLine(line);
  if (!parsed.ok) {
    return { ok: false, error: "malformed request line" };
  }
  return { ok: true, value: parsed.value };
}

/** True when this file is the process entry point (invoked with `node ...`). */
function isDirectExecution(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void runHostProcess({
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
  });
}

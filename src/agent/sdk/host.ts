/**
 * In-child SDK host dispatcher (Task 3).
 *
 * Translates line-delimited JSON protocol requests into `@opencode/sdk`
 * `OpenCode.create` host calls. The SDK module is lazy-loaded behind the
 * injectable loader and cached; `@opencode/sdk` is never imported statically
 * here (it cannot load on Node 20/22).
 *
 * Every `handle` call resolves to a protocol response — an SDK failure becomes
 * `{ ok: false, error: { message } }` and never throws out of the dispatcher.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import type { SdkHostRequest, SdkHostResponse } from "./protocol.js";
import type {
  SdkCreateSessionInput,
  SdkHost,
  SdkHostOptions,
  SdkLoader,
  SdkLogEntry,
  SdkMessage,
  SdkPromptInput,
  SdkSessionRef,
  SdkModule,
} from "./types.js";

/** Params for the `create` request (supplied by the parent-side client). */
export interface SdkHostCreateParams {
  configContent: string;
  databasePath: string;
}

export interface SdkHostDispatcher {
  handle(request: SdkHostRequest): Promise<SdkHostResponse>;
}

export function createSdkHostDispatcher(
  loadSdk: SdkLoader,
  onLog: (entry: SdkLogEntry) => void,
): SdkHostDispatcher {
  let module: SdkModule | undefined;
  let host: SdkHost | undefined;
  let closed = false;

  async function loadModule(): Promise<SdkModule> {
    if (!module) module = await loadSdk();
    return module;
  }

  function requireHost(): SdkHost {
    if (!host) throw new Error("SDK host is not created");
    return host;
  }

  async function handle(request: SdkHostRequest): Promise<SdkHostResponse> {
    try {
      switch (request.method) {
        case "create": {
          const params = request.params as SdkHostCreateParams;
          if (host) throw new Error("SDK host already created");
          const sdk = await loadModule();
          const options: SdkHostOptions = {
            config: { content: params.configContent, project: false, claude: false },
            database: { path: params.databasePath },
            models: { fetch: false },
            fs: { filewatcher: false },
            log: { level: "error", emit: onLog },
          };
          host = await sdk.OpenCode.create(options);
          closed = false;
          return { id: request.id, ok: true };
        }
        case "session.create": {
          const row = await requireHost().sessions.create(request.params as SdkCreateSessionInput);
          return { id: request.id, ok: true, result: row };
        }
        case "session.get": {
          const row = await requireHost().sessions.get(request.params as SdkSessionRef);
          return { id: request.id, ok: true, result: row };
        }
        case "session.prompt": {
          await requireHost().sessions.prompt(request.params as SdkPromptInput);
          return { id: request.id, ok: true };
        }
        case "message.list": {
          const response = await requireHost().message.list(
            request.params as SdkSessionRef & { order?: "asc" | "desc" },
          );
          const messages: SdkMessage[] = Array.isArray(response)
            ? response
            : (response.data ?? []);
          return { id: request.id, ok: true, result: messages };
        }
        case "session.remove": {
          await requireHost().sessions.remove(request.params as SdkSessionRef);
          return { id: request.id, ok: true };
        }
        case "close": {
          await close();
          return { id: request.id, ok: true };
        }
        case "health": {
          const sdk = await loadModule();
          if (!sdk?.OpenCode || typeof sdk.OpenCode.create !== "function") {
            throw new Error("opencode-sdk module has no OpenCode.create");
          }
          return { id: request.id, ok: true, result: { version: resolveSdkVersion() } };
        }
        default:
          throw new Error(`unknown SDK host method: ${String((request as { method: string }).method)}`);
      }
    } catch (cause) {
      return {
        id: request.id,
        ok: false,
        error: { message: cause instanceof Error ? cause.message : String(cause) },
      };
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    const current = host;
    host = undefined;
    if (!current) return;
    await current.close();
  }

  return { handle };
}

/** Resolve the installed SDK version without importing it at build time. */
function resolveSdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@opencode/sdk/package.json") as { version?: unknown };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // Fall through to entry-point traversal.
  }
  try {
    const require = createRequire(import.meta.url);
    let dir = path.dirname(require.resolve("@opencode/sdk"));
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (pkg.name === "@opencode/sdk" && typeof pkg.version === "string") {
          return pkg.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Unknown version is acceptable; health is still healthy once import works.
  }
  return "unknown";
}

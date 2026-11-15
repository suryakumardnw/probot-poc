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

import {
  parseSdkHostValue,
  sdkCreateSessionInputSchema,
  sdkHostCreateParamsSchema,
  sdkMessageListParamsSchema,
  sdkMessageListResultSchema,
  sdkPackageManifestSchema,
  sdkPromptInputSchema,
  sdkSessionRefSchema,
  type ContractParseResult,
  type SdkHostMethod,
  type SdkHostRequest,
  type SdkHostResponse,
} from "./protocol.js";
import type { SdkHost, SdkHostOptions, SdkLoader, SdkLogEntry, SdkMessage, SdkModule } from "./types.js";

/** Params for the `create` request (supplied by the parent-side client). */
export type { SdkHostCreateParams } from "./protocol.js";

export interface SdkHostDispatcher {
  handle(request: SdkHostRequest): Promise<SdkHostResponse>;
}

/** Unwrap a boundary parse or turn it into a protocol error response. */
function requireValue<T>(result: ContractParseResult<T>, method: SdkHostMethod): T {
  if (!result.ok) {
    throw new Error(`invalid ${method} params: ${result.error}`);
  }
  return result.value;
}

export function createSdkHostDispatcher(loadSdk: SdkLoader, onLog: (entry: SdkLogEntry) => void): SdkHostDispatcher {
  let module: SdkModule | undefined;
  let host: SdkHost | undefined;
  let closed = false;

  async function loadModule(): Promise<SdkModule> {
    if (!module) {
      module = await loadSdk();
    }
    return module;
  }

  function requireHost(): SdkHost {
    if (!host) {
      throw new Error("SDK host is not created");
    }
    return host;
  }

  async function handle(request: SdkHostRequest): Promise<SdkHostResponse> {
    try {
      switch (request.method) {
        case "create": {
          const params = requireValue(parseSdkHostValue(sdkHostCreateParamsSchema, request.params), "create");
          if (host) {
            throw new Error("SDK host already created");
          }
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
          const params = requireValue(parseSdkHostValue(sdkCreateSessionInputSchema, request.params), "session.create");
          const row = await requireHost().sessions.create(params);
          return { id: request.id, ok: true, result: row };
        }
        case "session.get": {
          const params = requireValue(parseSdkHostValue(sdkSessionRefSchema, request.params), "session.get");
          const row = await requireHost().sessions.get(params);
          return { id: request.id, ok: true, result: row };
        }
        case "session.prompt": {
          const params = requireValue(parseSdkHostValue(sdkPromptInputSchema, request.params), "session.prompt");
          await requireHost().sessions.prompt(params);
          return { id: request.id, ok: true };
        }
        case "message.list": {
          const params = requireValue(parseSdkHostValue(sdkMessageListParamsSchema, request.params), "message.list");
          const response = await requireHost().message.list(params);
          const parsed = parseSdkHostValue(sdkMessageListResultSchema, response);
          if (!parsed.ok) {
            throw new Error(`invalid message.list result: ${parsed.error}`);
          }
          const messages: SdkMessage[] = Array.isArray(parsed.value) ? parsed.value : (parsed.value.data ?? []);
          return { id: request.id, ok: true, result: messages };
        }
        case "session.remove": {
          const params = requireValue(parseSdkHostValue(sdkSessionRefSchema, request.params), "session.remove");
          await requireHost().sessions.remove(params);
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
          throw new Error(`unknown SDK host method: ${String(request.method)}`);
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
    if (closed) {
      return;
    }
    closed = true;
    const current = host;
    host = undefined;
    if (!current) {
      return;
    }
    await current.close();
  }

  return { handle };
}

/** Resolve the installed SDK version without importing it at build time. */
function resolveSdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@opencode/sdk/package.json");
    const parsed = parseSdkHostValue(sdkPackageManifestSchema, pkg);
    if (parsed.ok && parsed.value.version !== undefined) {
      return parsed.value.version;
    }
  } catch {
    // Fall through to entry-point traversal.
  }
  try {
    const require = createRequire(import.meta.url);
    let dir = path.dirname(require.resolve("@opencode/sdk"));
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8"));
        const parsed = parseSdkHostValue(sdkPackageManifestSchema, pkg);
        if (parsed.ok && parsed.value.name === "@opencode/sdk" && parsed.value.version !== undefined) {
          return parsed.value.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch {
    // Unknown version is acceptable; health is still healthy once import works.
  }
  return "unknown";
}

/**
 * Review-scoped Promise plugin for the Phase 0 spike.
 *
 * The plugin closure owns the review identity and workspace root. The model
 * can only supply a relative path through `review_read_file`; it can never
 * choose the workspace or the review id. Every tool execution is audited via
 * the `execute.before` hook into a closure-local list.
 *
 * Throwaway spike code; not production.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Plugin } from "@opencode/plugin";

export const MAX_READ_BYTES = 64 * 1024;

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function isSecretPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const base = path.posix.basename(normalized);
  return (
    // `.env`, `.env.local`, and any name containing `.env.` such as
    // `prod.env.local` or `config.prod.env.bak`.
    base === ".env" ||
    base.endsWith(".env") ||
    base.startsWith(".env.") ||
    base.includes(".env.") ||
    // Secret directories/files anywhere in the relative path.
    normalized.includes("credential") ||
    normalized.includes("credentials") ||
    segments.includes(".git-credentials")
  );
}

/** Create the safe reader for one workspace root. Throws on any rejection. */
export function createSafeReader(workspacePath) {
  const root = realpathSync(workspacePath);

  return function readFile(requestedPath) {
    if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
      throw new Error("path must be a non-empty string");
    }
    if (requestedPath.includes("\0")) throw new Error("path contains a null byte");
    if (path.isAbsolute(requestedPath)) throw new Error("absolute paths are not allowed");
    if (requestedPath.split(/[\\/]+/).some((part) => part === "..")) {
      throw new Error("parent-directory segments are not allowed");
    }

    const lexical = path.resolve(root, requestedPath);
    if (!isInside(root, lexical)) throw new Error("path escapes the review workspace");

    // realpath resolves symlinks; reject anything whose real target is outside.
    const real = realpathSync(lexical);
    if (!isInside(root, real)) throw new Error("symlink target escapes the review workspace");

    const relative = path.relative(root, real).split(path.sep).join("/");
    if (isSecretPath(relative)) throw new Error("reading environment/secret files is not allowed");

    const stat = statSync(real);
    if (!stat.isFile()) throw new Error("path is not a regular file");

    const buffer = readFileSync(real);
    const truncated = buffer.length > MAX_READ_BYTES;
    const returned = buffer.subarray(0, MAX_READ_BYTES).toString("utf8");
    return {
      path: relative,
      content: returned,
      truncated,
      bytesReturned: Math.min(buffer.length, MAX_READ_BYTES),
      totalBytes: buffer.length,
    };
  };
}

function summarizeInput(input) {
  try {
    const text = JSON.stringify(input ?? null);
    return text.length > 300 ? text.slice(0, 300) + "…" : text;
  } catch {
    return "[unserializable input]";
  }
}

/**
 * Create an independent plugin bundle for one review.
 * Returns the plugin plus its closure-local audit list and reader so the spike
 * can inspect them (the model can never reach these objects).
 */
export function createReviewPlugin({ reviewId, workspacePath }) {
  const reader = createSafeReader(workspacePath);
  const audits = [];
  const state = { setupCalls: 0, setupError: null };

  const reviewReadFile = {
    name: "review_read_file",
    description:
      "Read a UTF-8 text file from THIS review's workspace. Supply a path relative to the workspace root. Absolute paths, parent segments, symlink escapes and environment/secret files are rejected. Output is capped at 64 KiB.",
    input: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path, e.g. src/app.js",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    // `read` keeps this tool exposed under the read permission allow-rule and
    // keeps it out of the catch-all deny bucket.
    options: { permission: "read", codemode: false },
    execute: async (input) => {
      const result = reader(input?.path);
      const header = `FILE ${result.path} (${result.bytesReturned}${result.truncated ? `/${result.totalBytes}` : ""} bytes${result.truncated ? ", truncated" : ""})`;
      return {
        content: [{ type: "text", text: `${header}\n\n${result.content}` }],
        metadata: {
          reviewId,
          path: result.path,
          bytesReturned: result.bytesReturned,
          truncated: result.truncated,
        },
      };
    },
  };

  const plugin = Plugin.define({
    id: `spike.review.${reviewId}`,
    async setup(context) {
      state.setupCalls += 1;
      try {
        await context.tool.transform((editor) => {
          editor.add(reviewReadFile);
        });
        await context.tool.hook("execute.before", (input) => {
          audits.push({
            at: Date.now(),
            reviewId,
            tool: input.tool,
            sessionID: input.sessionID,
            messageID: input.messageID,
            inputSummary: summarizeInput(input.input),
          });
        });
      } catch (error) {
        state.setupError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
  });

  return {
    reviewId,
    workspacePath,
    plugin,
    reader,
    audits,
    state,
  };
}

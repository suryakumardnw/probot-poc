/**
 * Controlled repository tool-request protocol (ticket 07; ARCHITECTURE.md
 * §5.2, §10.1).
 *
 * The agent NEVER touches the filesystem or network itself for repository
 * content. It may only *request* tools by listing workspace-relative paths;
 * the application resolves every path through the path-safe workspace
 * resolvers (symlinks and `..` rejected) under an enforced retrieval budget.
 *
 * Repository content is untrusted: every request is parsed defensively and a
 * malformed or malicious request is recorded as a violation, never thrown
 * into the agent's control flow.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  FileNotFoundError,
  FileTooLargeError,
  PathEscapeError,
  readWorkspaceFile,
  resolveWorkspacePath,
} from "../workspace/index.js";

export type ToolName = "read_file" | "list_files" | "get_diff" | "search_code";

export interface ToolRequest {
  tool: ToolName;
  /** Workspace-relative path (read_file, list_files, search_code). */
  path?: string;
  /** Content search term (search_code). */
  query?: string;
  /** When true, the agent asks for the PR diff again (get_diff). */
  includeDiff?: boolean;
}

export type ToolResult =
  | { ok: true; tool: ToolName; path?: string; content: string; truncated: boolean }
  | { ok: false; tool: ToolName; path?: string; error: string };

/** Upper bound on one directory listing (names only, sorted). */
const MAX_LISTED_ENTRIES = 200;
/** Upper bound of the per-call context block, in characters. */
export const MAX_CONTEXT_CHARS = 48_000;
/** Upper bound on search_code matches returned in one call. */
const MAX_SEARCH_MATCHES = 100;
/** Directories that are never useful (or safe) to search per request. */
const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo"]);

/**
 * Model-facing aliases. OpenCode exposes native tools as `read`/`glob`/`grep`,
 * while the review protocol uses `read_file`/`list_files`/`search_code`; models
 * routinely mix them. Accept both spellings instead of rejecting useful reads.
 */
const TOOL_ALIASES: Record<string, ToolName> = {
  read: "read_file",
  read_file: "read_file",
  file_read: "read_file",
  glob: "list_files",
  list_files: "list_files",
  ls: "list_files",
  get_diff: "get_diff",
  diff: "get_diff",
  grep: "search_code",
  rg: "search_code",
  search: "search_code",
  search_code: "search_code",
  inspect_symbols: "search_code",
};

/**
 * Mutable retrieval budget shared across the whole review. Enforced here —
 * the agent cannot raise it.
 */
export class RetrievalBudget {
  used = 0;
  readonly violations: string[] = [];

  constructor(public readonly max: number) {}

  get exhausted(): boolean {
    return this.used >= this.max;
  }

  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }

  consume(): boolean {
    if (this.exhausted) {
      return false;
    }
    this.used++;
    return true;
  }

  violation(message: string): void {
    this.violations.push(message);
  }
}

/**
 * Parse the agent's tool requests defensively. Anything that is not a
 * well-formed request object with a known tool name is recorded as a
 * violation and dropped — unknown tool names (e.g. shell, network, write)
 * are always rejected.
 */
export function parseToolRequests(value: unknown, budget: RetrievalBudget): ToolRequest[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    budget.violation("tool_requests: not an array; ignored");
    return [];
  }
  const requests: ToolRequest[] = [];
  for (const raw of value.slice(0, 20)) {
    if (typeof raw !== "object" || raw === null) {
      budget.violation("tool request: not an object; ignored");
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const args =
      typeof candidate.args === "object" && candidate.args !== null ? (candidate.args as Record<string, unknown>) : {};
    const pathValue = candidate.path ?? candidate.file ?? candidate.filePath ?? args.path ?? args.file ?? args.filePath;
    const queryValue =
      candidate.query ?? candidate.pattern ?? candidate.search ?? args.query ?? args.pattern ?? args.search;
    let tool = candidate.tool;
    // Model drift: some providers omit `tool` and send only `path`/`reason`,
    // and native tool names arrive as read/glob/grep. Infer the safe read-only
    // tool instead of discarding the request.
    if (tool === undefined) {
      if (typeof queryValue === "string") {
        tool = "search_code";
      } else if (typeof pathValue === "string") {
        tool = /diff/i.test(pathValue) ? "get_diff" : "read_file";
      }
    }
    const mappedTool = typeof tool === "string" ? TOOL_ALIASES[tool] : undefined;
    if (!mappedTool) {
      budget.violation(`tool request: unsupported tool '${String(tool)}'; rejected`);
      continue;
    }
    const path = typeof pathValue === "string" ? pathValue : undefined;
    const query = typeof queryValue === "string" ? queryValue : undefined;
    if ((mappedTool === "read_file" || mappedTool === "list_files") && !path) {
      budget.violation(`tool request '${mappedTool}': missing path; rejected`);
      continue;
    }
    if (mappedTool === "search_code" && !query) {
      budget.violation("tool request 'search_code': missing query; rejected");
      continue;
    }
    if (path !== undefined && (path.length === 0 || path.length > 512)) {
      budget.violation(`tool request '${mappedTool}': path length out of bounds; rejected`);
      continue;
    }
    if (query !== undefined && (query.length === 0 || query.length > 512)) {
      budget.violation(`tool request '${mappedTool}': query length out of bounds; rejected`);
      continue;
    }
    const request: ToolRequest = {
      tool: mappedTool,
      includeDiff: candidate.includeDiff === true || args.includeDiff === true,
    };
    if (path !== undefined) {
      request.path = path;
    }
    if (query !== undefined) {
      request.query = query;
    }
    requests.push(request);
  }
  return requests;
}

/** Render a ToolResult into the context block handed back to the agent. */
function renderResult(result: ToolResult): string {
  if (!result.ok) {
    return `[${result.tool}${result.path ? ` ${result.path}` : ""}] NOT AVAILABLE: ${result.error}`;
  }
  const header = result.path
    ? `[${result.tool} ${result.path}${result.truncated ? " (truncated)" : ""}]`
    : `[${result.tool}]`;
  return `${header}\n${result.content}`;
}

/** Recursively collect regular files under a directory, skipping noise dirs. */
async function collectSearchFiles(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 30 || out.length >= 2_000) {
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (SEARCH_SKIP_DIRS.has(entry.name)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSearchFiles(full, out, depth + 1);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

/**
 * search_code: bounded literal content search inside the workspace. Returns
 * `path:line: text` matches; unsupported/binary/oversized files are skipped.
 * The agent cannot escape the workspace because every file is read through
 * the path-safe resolver.
 */
async function searchCode(
  workspacePath: string,
  relativePath: string,
  query: string,
  maxFileBytes: number,
): Promise<string> {
  const start = resolveWorkspacePath(workspacePath, relativePath);
  const stat = await fs.stat(start);
  const files: string[] = [];
  if (stat.isFile()) {
    files.push(start);
  } else if (stat.isDirectory()) {
    await collectSearchFiles(start, files, 0);
  } else {
    return `No matches for '${query}'.`;
  }

  const needle = query.toLowerCase();
  const matches: string[] = [];
  for (const full of files) {
    if (matches.length >= MAX_SEARCH_MATCHES) {
      break;
    }
    const relative = path.relative(workspacePath, full).split(path.sep).join("/") || relativePath;
    let file;
    try {
      file = await readWorkspaceFile(workspacePath, relative, { maxFileBytes });
    } catch {
      continue;
    }
    if (file.encoding !== "utf-8" || file.text === undefined) {
      continue;
    }
    const lines = file.text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.toLowerCase().includes(needle)) {
        matches.push(`${relative}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`);
        if (matches.length >= MAX_SEARCH_MATCHES) {
          break;
        }
      }
    }
  }
  return matches.length > 0 ? matches.join("\n") : `No matches for '${query}'.`;
}

/** list_files: names-only directory listing inside the workspace. */
async function listFiles(workspacePath: string, relativePath: string): Promise<string> {
  const resolved = resolveWorkspacePath(workspacePath, relativePath);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const names = entries
    .slice(0, MAX_LISTED_ENTRIES)
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
  const truncated = entries.length > MAX_LISTED_ENTRIES;
  return names.join("\n") + (truncated ? `\n(${entries.length - MAX_LISTED_ENTRIES} more entries omitted)` : "");
}

/**
 * Fulfil tool requests under the budget. Path-escape attempts, oversized
 * files, budget exhaustion and missing files become per-request error
 * results plus violations — they never crash the review and never give the
 * agent control.
 */
export async function fulfillToolRequests(
  workspacePath: string,
  requests: ToolRequest[],
  budget: RetrievalBudget,
  diff: string,
  maxFileBytes: number,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const request of requests) {
    if (budget.exhausted) {
      budget.violation(`retrieval budget exhausted; '${request.tool}' request dropped`);
      results.push({ ok: false, tool: request.tool, path: request.path, error: "budget_exhausted" });
      continue;
    }
    try {
      let content: string;
      let truncated = false;
      if (request.tool === "get_diff") {
        content = diff;
      } else if (request.tool === "list_files") {
        content = await listFiles(workspacePath, request.path!);
      } else if (request.tool === "search_code") {
        content = await searchCode(workspacePath, request.path ?? ".", request.query!, maxFileBytes);
      } else {
        const file = await readWorkspaceFile(workspacePath, request.path!, { maxFileBytes });
        if (file.encoding === "binary") {
          results.push({ ok: false, tool: request.tool, path: request.path, error: "binary_file" });
          budget.violation(`read_file ${request.path}: binary content withheld`);
          continue;
        }
        content = file.text ?? "";
      }
      budget.consume();
      if (content.length > MAX_CONTEXT_CHARS) {
        content = content.slice(0, MAX_CONTEXT_CHARS);
        truncated = true;
      }
      results.push({ ok: true, tool: request.tool, path: request.path, content, truncated });
    } catch (error) {
      const reason =
        error instanceof PathEscapeError
          ? "path_escape"
          : error instanceof FileTooLargeError
            ? "file_too_large"
            : error instanceof FileNotFoundError
              ? "not_found"
              : "unreadable";
      budget.violation(`${request.tool} ${request.path ?? ""}: ${reason}`.trim());
      results.push({ ok: false, tool: request.tool, path: request.path, error: reason });
    }
  }
  return results;
}

/** Render fulfilled results as the next instruction's context section. */
export function renderToolContext(results: ToolResult[]): string {
  if (results.length === 0) {
    return "";
  }
  return results.map(renderResult).join("\n\n");
}

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Changed-file enumeration, PR diff generation and safe file content
 * retrieval inside a review workspace (ARCHITECTURE.md §5.1, §5.2).
 *
 * Security invariants:
 * - Resolved paths must never escape the workspace root (symlinks included).
 * - Binary content is never decoded as text.
 * - File size is bounded by the configurable `maxFileBytes` limit.
 */

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "changed";

export interface ChangedFile {
  path: string;
  /** For renames/copies: the path before the change. */
  previousPath?: string;
  status: ChangeStatus;
}

export class PathEscapeError extends Error {
  constructor(public readonly relativePath: string) {
    super(`Workspace path escapes the workspace root: ${relativePath}`);
    this.name = "PathEscapeError";
  }
}

export class FileTooLargeError extends Error {
  constructor(
    public readonly relativePath: string,
    public readonly sizeBytes: number,
    public readonly maxFileBytes: number,
  ) {
    super(`File ${relativePath} (${sizeBytes} bytes) exceeds maxFileBytes limit (${maxFileBytes})`);
    this.name = "FileTooLargeError";
  }
}

export class FileNotFoundError extends Error {
  constructor(public readonly relativePath: string) {
    super(`File not found in workspace: ${relativePath}`);
    this.name = "FileNotFoundError";
  }
}

const STATUS_MAP: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "changed",
};

/**
 * Parse the output of `git diff --name-status -M`.
 * Lines look like `A\tpath`, `M\tpath`, `R100\told\tnew`, `C75\told\tnew`.
 */
export function parseNameStatus(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const status = STATUS_MAP[parts[0][0]];
    if (!status) continue;
    if ((status === "renamed" || status === "copied") && parts.length >= 3) {
      files.push({ status, previousPath: parts[1], path: parts[parts.length - 1] });
    } else {
      files.push({ status, path: parts[parts.length - 1] });
    }
  }
  return files;
}

/**
 * Resolve a relative path inside the workspace root, rejecting anything that
 * escapes it (absolute paths, `..` segments, symlinks pointing outside).
 */
export function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new PathEscapeError(relativePath);
  }
  const root = path.resolve(workspaceRoot);
  // The root itself may sit behind a symlink (e.g. macOS /var → /private/var),
  // so compare real paths on both sides.
  const realRoot = fs.realpathSync.native(root);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError(relativePath);
  }
  // Symlink escape check: the resolved file must live inside the real root.
  // A missing path is a normal lookup miss, not an I/O failure: classify it
  // as FileNotFoundError so tool callers can report `not_found` accurately.
  let real: string;
  try {
    real = fs.realpathSync.native(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileNotFoundError(relativePath);
    }
    throw error;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new PathEscapeError(relativePath);
  }
  return resolved;
}

export interface FileContent {
  path: string;
  /** Raw bytes — safe for binary files. */
  bytes: Buffer;
  /** "utf-8" when the content decodes as UTF-8, "binary" otherwise. */
  encoding: "utf-8" | "binary";
  sizeBytes: number;
  /** True when the file was truncated to `maxFileBytes`. */
  truncated: boolean;
  /** Decoded text (only present for UTF-8 content). */
  text?: string;
}

const BINARY_SNIFF_BYTES = 8_192;

/** Detect binary content by looking for NUL bytes in the leading bytes. */
export function looksBinary(bytes: Buffer): boolean {
  const sniff = bytes.subarray(0, Math.min(bytes.length, BINARY_SNIFF_BYTES));
  return sniff.includes(0);
}

/**
 * Read a file from the workspace with binary-safe handling and a configurable
 * size limit. Text content is only decoded when it is valid UTF-8.
 */
export async function readWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  opts: { maxFileBytes: number },
): Promise<FileContent> {
  const resolved = resolveWorkspacePath(workspaceRoot, relativePath);
  const stat = await fsp.stat(resolved);
  if (stat.isDirectory()) {
    throw new FileNotFoundError(relativePath);
  }
  if (stat.size > opts.maxFileBytes) {
    throw new FileTooLargeError(relativePath, stat.size, opts.maxFileBytes);
  }
  const bytes = await fsp.readFile(resolved);
  if (looksBinary(bytes)) {
    return { path: relativePath, bytes, encoding: "binary", sizeBytes: bytes.length, truncated: false };
  }
  const text = bytes.toString("utf-8");
  const isUtf8 = Buffer.compare(Buffer.from(text, "utf-8"), bytes) === 0;
  return {
    path: relativePath,
    bytes,
    encoding: isUtf8 ? "utf-8" : "binary",
    sizeBytes: bytes.length,
    truncated: false,
    text: isUtf8 ? text : undefined,
  };
}

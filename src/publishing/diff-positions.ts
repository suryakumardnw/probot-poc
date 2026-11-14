/**
 * Diff position resolution (ARCHITECTURE.md §7.4; ticket 09).
 *
 * Parses the PR unified diff produced by the review workspace (ticket 04) and
 * resolves each finding's (file, line) anchor to a GitHub review comment
 * position:
 *
 *  - Added and modified (context on the new side) lines are inline-eligible
 *    and map to `side: "RIGHT"` + the new-file line number.
 *  - Deleted lines, deleted files and lines outside the diff are NOT
 *    inline-eligible — the finding becomes summary-only (§7.4: never force an
 *    incorrect inline location).
 */

export interface DiffLine {
  type: "context" | "added" | "deleted";
  /** Old-file line number (context and deleted lines). */
  oldLine?: number;
  /** New-file line number (context and added lines). */
  newLine?: number;
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedDiffFile {
  /** Path on the new side (b/<path>, or the rename target). */
  path: string;
  /** Path on the old side when different (rename/delete). */
  previousPath?: string;
  isNewFile: boolean;
  isDeletedFile: boolean;
  isBinary: boolean;
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff (as produced by `git diff --find-renames`) into
 * per-file hunks with resolved line numbers.
 */
export function parseUnifiedDiff(diff: string): Map<string, ParsedDiffFile> {
  const files = new Map<string, ParsedDiffFile>();
  if (!diff) return files;

  let current: ParsedDiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const flushHunk = () => {
    hunk = null;
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flushHunk();
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(raw);
      current = match
        ? {
            path: match[2],
            previousPath: match[1] !== match[2] ? match[1] : undefined,
            isNewFile: false,
            isDeletedFile: false,
            isBinary: false,
            hunks: [],
          }
        : null;
      if (current) files.set(current.path, current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("new file mode")) {
      current.isNewFile = true;
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      current.isDeletedFile = true;
      continue;
    }
    if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) {
      current.isBinary = true;
      continue;
    }
    if (raw.startsWith("rename from ")) {
      current.previousPath = raw.slice("rename from ".length);
      continue;
    }
    if (raw.startsWith("rename to ")) {
      current.path = raw.slice("rename to ".length);
      files.delete(current.previousPath ?? "__unset__");
      files.set(current.path, current);
      continue;
    }
    const hunkMatch = HUNK_HEADER.exec(raw);
    if (raw.startsWith("@@") && hunkMatch) {
      flushHunk();
      hunk = {
        oldStart: Number(hunkMatch[1]),
        oldCount: hunkMatch[2] ? Number(hunkMatch[2]) : 1,
        newStart: Number(hunkMatch[3]),
        newCount: hunkMatch[4] ? Number(hunkMatch[4]) : 1,
        lines: [],
      };
      current.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("+")) {
      hunk.lines.push({ type: "added", newLine, content: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ type: "deleted", oldLine, content: raw.slice(1) });
      oldLine += 1;
    } else if (raw.startsWith(" ") || raw === "") {
      hunk.lines.push({ type: "context", oldLine, newLine, content: raw.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
    // "\ No newline at end of file" and other markers are ignored.
  }
  return files;
}

/** New-side (RIGHT) line numbers present in the diff for one file: added + context. */
export function newSideLines(file: ParsedDiffFile): Set<number> {
  const lines = new Set<number>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== undefined) lines.add(line.newLine);
    }
  }
  return lines;
}

/** Old-side (LEFT) line numbers present in the diff for one file: deleted + context. */
export function oldSideLines(file: ParsedDiffFile): Set<number> {
  const lines = new Set<number>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.oldLine !== undefined) lines.add(line.oldLine);
    }
  }
  return lines;
}

export interface InlinePosition {
  path: string;
  line: number;
  side: "RIGHT";
}

export type InlineResolution =
  | { kind: "anchored"; position: InlinePosition }
  | { kind: "deleted_line" | "deleted_file" | "binary_file" | "file_not_in_diff" | "line_not_in_diff" };

/**
 * Resolve a finding anchor (file path on the new side + 1-based line number)
 * to a GitHub review comment position, or explain why inline publication is
 * impossible (§7.4 — summary-only fallback).
 */
export function resolveInlinePosition(
  diffFiles: Map<string, ParsedDiffFile>,
  filePath: string,
  line: number,
): InlineResolution {
  const file = diffFiles.get(filePath);
  if (!file) return { kind: "file_not_in_diff" };
  if (file.isBinary) return { kind: "binary_file" };
  if (file.isDeletedFile) return { kind: "deleted_file" };
  if (newSideLines(file).has(line)) {
    return { kind: "anchored", position: { path: filePath, line, side: "RIGHT" } };
  }
  // The line exists only on the old side (deleted) or outside every hunk.
  if (oldSideLines(file).has(line)) return { kind: "deleted_line" };
  return { kind: "line_not_in_diff" };
}

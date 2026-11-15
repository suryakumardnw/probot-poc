/**
 * Dot-path reads and writes over plain objects.
 *
 * The admin panel edits arbitrary configuration paths, so it needs one small
 * shape-agnostic helper pair rather than a hand-written accessor per field.
 * Callers own validation; a missing or non-object segment simply stops the
 * walk (read) or fails loudly (write).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getPath(target: unknown, path: string): unknown {
  let current: unknown = target;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function setPath(target: unknown, path: string, value: unknown): void {
  const segments = path.split(".");
  const leaf = segments.pop();
  if (leaf === undefined) {
    return;
  }

  let current: unknown = target;
  for (const segment of segments) {
    if (!isRecord(current)) {
      throw new Error(`Cannot set '${path}': '${segment}' is not an object`);
    }
    current = current[segment];
  }
  if (!isRecord(current)) {
    throw new Error(`Cannot set '${path}'`);
  }
  current[leaf] = value;
}

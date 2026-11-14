/**
 * Secret redaction for error envelopes and log payloads.
 *
 * Error messages and details are caller-controlled. Even with an allow-list
 * projection, a caller can embed a token, a credential-bearing URL, or a
 * secret-named field. These redactors are a second line of defense: they mask
 * recognizable credential formats and secret-named keys while preserving field
 * paths and ordinary validation messages.
 */

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const MAX_DETAIL_DEPTH = 6;

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*:[^/\s@]+@/gi;
const URL_TOKEN_USERINFO = /(https?:\/\/)[^/\s:@]+@/gi;
const X_ACCESS_TOKEN = /x-access-token:[^\s@]+@/gi;
const AUTH_HEADER = /(["']?)\b(authorization|proxy-authorization|cookie|set-cookie)\b\1(\s*[:=]\s*)[^\r\n]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g;
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g;

const SECRET_KEY_PATTERN = "(?:[A-Za-z0-9]+[_-])*(?:token|secret|password|api[_-]?key|private[_-]?key)";
const SECRET_KEY_QUOTED = new RegExp(
  `(["']?)(${SECRET_KEY_PATTERN})(["']?)(\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\5)[^\\\\])*\\5`,
  "gi",
);
const SECRET_KEY_UNQUOTED = new RegExp(
  `(["']?)(${SECRET_KEY_PATTERN})(["']?)(\\s*[:=]\\s*)([^"'\\s,;}][^,\\s;}]*)`,
  "gi",
);

const SECRET_KEY_NAME = /(^|_)(token|secret|password|api_?key|authorization|cookie|private_?key)($|_)/;

/** Mask recognizable secret formats and secret-named key/value pairs in text. */
export function redactSecrets(message: string): string {
  return message
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(URL_TOKEN_USERINFO, `$1${REDACTED}@`)
    .replace(X_ACCESS_TOKEN, `x-access-token:${REDACTED}@`)
    .replace(AUTH_HEADER, `$1$2$1$3${REDACTED}`)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(OPENAI_KEY, REDACTED)
    .replace(AWS_ACCESS_KEY, REDACTED)
    .replace(SLACK_TOKEN, REDACTED)
    .replace(SECRET_KEY_QUOTED, `$1$2$3$4$5${REDACTED}$5`)
    .replace(SECRET_KEY_UNQUOTED, `$1$2$3$4${REDACTED}`);
}

/**
 * Recursively redact a details value.
 *
 * Secret-named keys are masked entirely; other strings go through
 * `redactSecrets`. Depth is capped so a cyclic or pathological value cannot
 * consume the process. Non-JSON values are returned as-is and later dropped by
 * the envelope contract parser.
 */
export function redactDetails(value: unknown): unknown {
  return redactValue(value, 0);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_DETAIL_DEPTH) {
    return TRUNCATED;
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      redacted[key] = isSecretKey(key) ? REDACTED : redactValue(child, depth + 1);
    }
    return redacted;
  }
  return value;
}

function isSecretKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  return SECRET_KEY_NAME.test(normalized);
}

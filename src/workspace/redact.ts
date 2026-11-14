/**
 * Credential redaction helpers (ARCHITECTURE.md §10.6).
 *
 * Installation tokens travel inside git remote URLs for the duration of one
 * clone/fetch. They must never appear in logs, error messages or persisted
 * metadata. Every path that can carry a URL or stderr/stdout text goes
 * through `redactCredentials` before it leaves the workspace layer.
 */

const REDACTED = "[REDACTED]";

/**
 * Remove any userinfo component from a URL: `https://user:pass@host/x`
 * becomes `https://[REDACTED]@host/x`. Also accepts plain host URLs.
 */
export function sanitizeGitUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = REDACTED;
      parsed.password = "";
      return parsed.toString().replace(/\/$/, url.endsWith("/") ? "/" : "");
    }
    return url;
  } catch {
    // Not a parseable URL (e.g. a local path): return as-is.
    return url;
  }
}

/**
 * Redact a known secret from arbitrary text (stderr, stdout, error
 * messages). When `secret` is empty this is a no-op. Unknown credentials
 * embedded as URL userinfo are additionally caught by the generic pattern.
 */
export function redactCredentials(text: string, secret?: string): string {
  let output = text;
  if (secret && secret.length > 0) {
    // Split on every occurrence, including URL-encoded variants.
    output = output.split(secret).join(REDACTED).split(encodeURIComponent(secret)).join(REDACTED);
  }
  // Generic defense: `scheme://user:secret@host` and `x-access-token:<t>@`.
  output = output.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  output = output.replace(/x-access-token:[^\s@]+@/gi, `x-access-token:${REDACTED}@`);
  return output;
}

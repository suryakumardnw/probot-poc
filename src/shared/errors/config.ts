/**
 * Review-configuration validation error.
 *
 * This is the stable error callers branch on when a configuration candidate
 * (or the active file) fails validation. It lives in the shared error family
 * so the `ReviewConfigStore` port can re-export it without depending on the
 * concrete loader in `src/platform/config`.
 *
 * Deliberately a plain `Error`, not an `AppError`: configuration validation
 * failures are surfaced by admin handlers and scripts, not classified into
 * HTTP/queue retry dispositions. Moving it into the `AppError` family would
 * change `instanceof` and classification behavior, which is out of scope for
 * a move-only PR.
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

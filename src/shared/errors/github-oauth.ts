/**
 * GitHub OAuth/identity failure raised by the platform identity client.
 *
 * Admin HTTP maps the stable `code`/`status` to its error envelope. The class
 * lives in `shared` so both the admin module and the platform adapter can use
 * it without a cross-layer import.
 */
export class GithubOauthError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "GithubOauthError";
    this.code = code;
    this.status = status;
  }
}

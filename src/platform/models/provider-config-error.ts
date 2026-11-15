/**
 * Provider *construction* failure: invalid adapter configuration (missing
 * API-key environment variable, unsupported provider type, non-HTTP base URL).
 *
 * This is a platform-adapter error, not part of the provider port: callers
 * that only use the `ModelProvider` interface never see it.
 *
 * TODO(error-family): migrate to the shared `AppError` family with a stable
 * code when adapter-construction errors get their taxonomy. Keep this a plain
 * `Error` only until then so it does not become permanent by accident.
 */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

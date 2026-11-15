/**
 * Provider *construction* failure: invalid adapter configuration (missing
 * API-key environment variable, unsupported provider type, non-HTTP base URL).
 *
 * This is a platform-adapter error, not part of the provider port: callers
 * that only use the `ModelProvider` interface never see it. It stays a plain
 * `Error` in this move-only PR; the shared `AppError` migration for adapter
 * configuration errors is tracked separately.
 */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

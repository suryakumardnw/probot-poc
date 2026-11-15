/**
 * Resolve the model identifier actually sent to the provider endpoint.
 *
 * Per ticket 05: the configured endpoint requires the `provider/model`
 * `MODEL_NAME` form (e.g. `workers-ai/@cf/zai-org/glm-4.7-flash`); the central
 * `provider.model` value is used as a fallback only.
 *
 * Pure and dependency-free so both the platform agent adapters and the
 * publishing module (publication metadata) share the exact same precedence.
 */
export function resolveModelId(config: { provider: { model: string } }, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.MODEL_NAME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return config.provider.model;
}

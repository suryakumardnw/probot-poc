/**
 * Knowledge source fetching port.
 *
 * The knowledge module parses and caches the responses; the concrete HTTP
 * adapter lives in `src/platform/knowledge` because network I/O belongs to
 * the platform layer. Tests inject a fake fetcher, so knowledge tests never
 * touch the network.
 */
export type KnowledgeFetcher = (url: string, init?: { timeoutMs: number }) => Promise<{ status: number; text: string }>;

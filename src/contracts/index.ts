/**
 * Public contract surface.
 *
 * Everything here is a Zod schema, a schema-derived type, or a contract
 * constant. Implementation helpers (loaders, fetchers, parsers) stay in their
 * modules so importing the barrel never pulls in runtime behavior.
 */

// Admin HTTP API.
export {
  ADMIN_JOB_STATUSES,
  ADMIN_REVIEW_STATES,
  ADMIN_ROLE_POLICIES,
  adminErrorEnvelopeSchema,
  compareQuerySchema,
  compareReviewsResponseSchema,
  configDryRunResponseSchema,
  configObjectSchema,
  configReadResponseSchema,
  configReloadResponseSchema,
  configRollbackResponseSchema,
  configUpdateBodySchema,
  configUpdateResponseSchema,
  configValidateResponseSchema,
  loginResponseSchema,
  logoutResponseSchema,
  oauthCallbackQuerySchema,
  reviewComparisonRowSchema,
  reviewListItemSchema,
  reviewListQuerySchema,
  reviewListResponseSchema,
  reviewStatusResponseSchema,
  reviewTriggerResponseSchema,
  sessionResponseSchema,
  sessionUserSchema,
  triggerReviewBodySchema,
} from "./admin.js";
export type {
  AdminErrorEnvelope,
  AdminJobStatus,
  AdminReviewState,
  AdminRolePolicy,
  CompareQuery,
  CompareReviewsResponse,
  ConfigDryRunResponse,
  ConfigObject,
  ConfigReadResponse,
  ConfigReloadResponse,
  ConfigRollbackResponse,
  ConfigUpdateBody,
  ConfigUpdateResponse,
  ConfigValidateResponse,
  LoginResponse,
  LogoutResponse,
  OAuthCallbackQuery,
  ReviewComparisonRow,
  ReviewListItem,
  ReviewListQuery,
  ReviewListResponse,
  ReviewStatusResponse,
  ReviewTriggerResponse,
  SessionResponse,
  SessionUser,
  TriggerReviewBody,
} from "./admin.js";

// Agent events and OpenCode SDK host protocol.
export {
  SDK_HOST_METHODS,
  agentEventPartSchema,
  agentEventSchema,
  agentTokenUsageSchema,
  sdkCreateSessionInputSchema,
  sdkHealthResultSchema,
  sdkHostCreateParamsSchema,
  sdkHostLogEventSchema,
  sdkHostMethodSchema,
  sdkHostRequestSchema,
  sdkHostResponseSchema,
  sdkMessageListParamsSchema,
  sdkMessageListResultSchema,
  sdkMessageListSchema,
  sdkMessagePartSchema,
  sdkMessageSchema,
  sdkPackageManifestSchema,
  sdkPromptInputSchema,
  sdkSessionRefSchema,
  sdkSessionRowSchema,
  sdkUsageSchema,
} from "./agent.js";
export type {
  AgentEvent,
  AgentEventPart,
  AgentTokenUsage,
  SdkCreateSessionInputPayload,
  SdkHealthResultPayload,
  SdkHostCreateParams,
  SdkHostLogEvent,
  SdkHostMethod,
  SdkHostRequest,
  SdkHostResponse,
  SdkMessageListParams,
  SdkMessageListPayload,
  SdkMessageListResultPayload,
  SdkMessagePartPayload,
  SdkMessagePayload,
  SdkPackageManifest,
  SdkPromptInputPayload,
  SdkSessionRefPayload,
  SdkSessionRowPayload,
  SdkUsagePayload,
} from "./agent.js";

// Configuration: environment + review.json.
export { CURRENT_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS, envSchema, reviewConfigSchema } from "./config.js";
export type { Env, ReviewConfig } from "./config.js";

// Error envelope and codes.
export { ERROR_CODES, errorCodeSchema, errorEnvelopeSchema } from "./errors.js";
export type { ErrorEnvelope, KnownErrorCode } from "./errors.js";

// GitHub OAuth identity responses.
export {
  githubOauthTokenErrorSchema,
  githubOauthTokenSuccessSchema,
  githubOrgMembershipResponseSchema,
  githubUserResponseSchema,
} from "./github.js";
export type {
  GithubOauthTokenError,
  GithubOauthTokenSuccess,
  GithubOrgMembershipResponse,
  GithubUserResponse,
} from "./github.js";

// Benchmark suite files.
export {
  benchmarkCaseSchema,
  benchmarkChangedFileSchema,
  benchmarkFileSchema,
  benchmarkSuiteSchema,
  expectedFindingSchema,
} from "./evaluation.js";
export type {
  BenchmarkCase,
  BenchmarkChangedFile,
  BenchmarkFile,
  BenchmarkSuite,
  ExpectedFinding,
} from "./evaluation.js";

// GitHub responses and the knowledge cache manifest.
export {
  githubCommitResponseSchema,
  githubContentResponseSchema,
  githubTreeEntrySchema,
  githubTreeResponseSchema,
  knowledgeFileRecordSchema,
  knowledgeManifestSchema,
} from "./knowledge.js";
export type {
  GitHubCommitResponse,
  GitHubContentResponse,
  GitHubTreeEntry,
  GitHubTreeResponse,
  KnowledgeFileRecord,
  KnowledgeManifest,
} from "./knowledge.js";

// OpenAI-compatible model provider.
export {
  chatCompletionChoiceSchema,
  chatCompletionMessageSchema,
  chatCompletionPayloadSchema,
  chatCompletionUsageSchema,
  providerErrorPayloadSchema,
} from "./model.js";
export type {
  ChatCompletionChoice,
  ChatCompletionMessage,
  ChatCompletionPayload,
  ChatCompletionUsage,
  ProviderErrorPayload,
} from "./model.js";

// Queue and outbox payloads.
export {
  INGEST_OUTCOMES,
  REVIEW_MODES,
  REVIEW_TRIGGERS,
  REVIEW_TYPES,
  ingestOutcomeSchema,
  outboxPayloadSchema,
  reviewJobPayloadSchema,
} from "./queue.js";
export type {
  IngestOutcome,
  OutboxPayload,
  ReviewJobPayload,
  ReviewModeValue,
  ReviewTriggerValue,
  ReviewTypeValue,
} from "./queue.js";

// Review result and the finding taxonomy.
export {
  FINDING_CATEGORIES,
  analysisOutputSchema,
  findingCategorySchema,
  findingSchema,
  findingSeveritySchema,
  reviewResultSchema,
} from "./review.js";
export type { FindingCategoryValue, FindingSeverityValue, ParsedAnalysisOutput, ParsedReviewResult } from "./review.js";

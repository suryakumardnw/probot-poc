/**
 * Line-delimited JSON protocol between the parent `SdkHostClient` and the
 * in-child `runHostProcess` host.
 *
 * One JSON request per stdin line, one JSON response per stdout line. Log
 * entries are forwarded as `{ type: "log", ... }` JSON lines on stderr. The
 * parent never parses stderr as protocol; the child never writes diagnostics
 * to stdout.
 *
 * The schemas and inferred types live in `src/contracts/agent.ts`; this module
 * is the SDK-host-local view of that wire contract.
 */

export {
  SDK_HOST_METHODS,
  parseSdkHostRequestLine,
  parseSdkHostResponseLine,
  parseSdkHostValue,
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
  type ContractParseResult,
  type SdkCreateSessionInputPayload,
  type SdkHealthResultPayload,
  type SdkHostCreateParams,
  type SdkHostLogEvent,
  type SdkHostMethod,
  type SdkHostRequest,
  type SdkHostResponse,
  type SdkMessageListParams,
  type SdkMessageListResultPayload,
  type SdkMessageListPayload,
  type SdkMessagePartPayload,
  type SdkMessagePayload,
  type SdkPackageManifest,
  type SdkPromptInputPayload,
  type SdkSessionRefPayload,
  type SdkSessionRowPayload,
  type SdkUsagePayload,
} from "../../contracts/agent.js";

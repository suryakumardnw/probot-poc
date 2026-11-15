import { z } from "zod";

/**
 * OpenAI-compatible `/chat/completions` wire contracts.
 *
 * The model adapter parses the raw HTTP body against these schemas before any
 * field is read. The schemas are deliberately permissive about optional and
 * provider-specific fields — reasoning models add `reasoning_content`, token
 * usage may be missing, finish reasons vary — but they fail closed when the
 * structural essentials (a `choices` array of objects) are absent, so a
 * malformed body can never flow through the adapter as an unchecked cast.
 *
 * Fields the adapter previously normalized from `unknown` (token counts,
 * content, reasoning) are parsed leniently to `undefined` here. That keeps the
 * normalization behavior identical while making the shape explicit.
 *
 * This module is a wire contract only: it imports Zod and nothing else.
 */

/** A numeric token count. A non-numeric or missing value is treated as absent. */
const tokenCountSchema = z.number().finite().optional().catch(undefined);

/** An optional provider string. `null` and wrong types are treated as absent. */
const optionalStringSchema = z.string().optional().catch(undefined);

/**
 * Token usage metadata. Providers vary in spelling and presence; the adapter
 * only consumes the three canonical OpenAI counts and ignores the rest.
 */
export const chatCompletionUsageSchema = z
  .object({
    prompt_tokens: tokenCountSchema,
    completion_tokens: tokenCountSchema,
    total_tokens: tokenCountSchema,
  })
  .loose();
export type ChatCompletionUsage = z.infer<typeof chatCompletionUsageSchema>;

/**
 * The assistant message of one choice.
 *
 * `content: null` is legitimate for reasoning models that exhausted the token
 * budget in `reasoning_content`; the adapter falls back to the reasoning text.
 */
export const chatCompletionMessageSchema = z
  .object({
    content: optionalStringSchema,
    reasoning_content: optionalStringSchema,
    reasoning: optionalStringSchema,
  })
  .loose();
export type ChatCompletionMessage = z.infer<typeof chatCompletionMessageSchema>;

/** One completion choice. `finish_reason` stays a raw string and is normalized above. */
export const chatCompletionChoiceSchema = z
  .object({
    finish_reason: optionalStringSchema,
    message: chatCompletionMessageSchema.optional().catch(undefined),
  })
  .loose();
export type ChatCompletionChoice = z.infer<typeof chatCompletionChoiceSchema>;

/**
 * A successful chat-completions response body. `choices` is the structural
 * requirement: a body without an array of choice objects is not a completion
 * and is rejected with `unexpected_format`.
 */
export const chatCompletionPayloadSchema = z
  .object({
    id: optionalStringSchema,
    model: optionalStringSchema,
    choices: z.array(chatCompletionChoiceSchema),
    usage: chatCompletionUsageSchema.optional().catch(undefined),
  })
  .loose();
export type ChatCompletionPayload = z.infer<typeof chatCompletionPayloadSchema>;

/**
 * A provider error body. OpenAI-compatible gateways return either a plain text
 * body, `{ error: { message } }` (sometimes with extra type/param/code keys),
 * `{ error: "..." }`, or `{ message: "..." }`.
 */
export const providerErrorPayloadSchema = z.union([
  z.string(),
  z
    .object({
      error: z
        .union([z.string(), z.object({ message: z.string() }).loose()])
        .optional()
        .catch(undefined),
      message: z.string().optional().catch(undefined),
    })
    .loose(),
]);
export type ProviderErrorPayload = z.infer<typeof providerErrorPayloadSchema>;

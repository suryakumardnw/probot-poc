import { z } from "zod";

/**
 * GitHub OAuth identity wire contracts (admin web flow).
 *
 * The platform `github/oauth-client` adapter parses every response body
 * against these schemas before reading a field. GitHub adds fields over time,
 * so the objects are `.loose()`; the structural essentials fail closed so a
 * malformed body can never flow through as an unchecked cast. The adapter maps
 * the parsed values onto the `GithubOAuthClient` port types.
 *
 * Only the fields this application consumes are declared. The token response is
 * modeled as two schemas because GitHub reports OAuth failures with HTTP 200
 * and an `error` body instead of a non-2xx status.
 *
 * This module is a wire contract only: it imports Zod and nothing else.
 */

/**
 * A successful `POST https://github.com/login/oauth/access_token` body.
 * `token_type` and `scope` are not consumed and ride along as unknown keys.
 */
export const githubOauthTokenSuccessSchema = z
  .object({
    access_token: z.string().min(1),
  })
  .loose();
export type GithubOauthTokenSuccess = z.infer<typeof githubOauthTokenSuccessSchema>;

/**
 * A failed `POST https://github.com/login/oauth/access_token` body. The error
 * code and description are GitHub's own and are safe to surface (they never
 * contain the client secret).
 */
export const githubOauthTokenErrorSchema = z
  .object({
    error: z.string().min(1),
    error_description: z.string().optional(),
  })
  .loose();
export type GithubOauthTokenError = z.infer<typeof githubOauthTokenErrorSchema>;

/** GET https://api.github.com/user — only the identity fields are consumed. */
export const githubUserResponseSchema = z
  .object({
    login: z.string().min(1),
    id: z.number().int(),
  })
  .loose();
export type GithubUserResponse = z.infer<typeof githubUserResponseSchema>;

/**
 * GET https://api.github.com/orgs/{org}/memberships/{login}. GitHub only
 * reports `admin`/`member` roles and `active`/`pending` states; anything else
 * is a malformed payload rather than a value to guess at.
 */
export const githubOrgMembershipResponseSchema = z
  .object({
    role: z.enum(["admin", "member"]),
    state: z.enum(["active", "pending"]),
  })
  .loose();
export type GithubOrgMembershipResponse = z.infer<typeof githubOrgMembershipResponseSchema>;

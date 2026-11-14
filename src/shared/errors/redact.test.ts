import { describe, expect, test } from "vitest";
import { redactDetails, redactSecrets } from "./redact.js";

const TOKEN = "ghp_superSecretToken1234567890";

describe("redactSecrets", () => {
  test.each([
    ["GitHub classic token", `token ${TOKEN}`, TOKEN],
    [
      "GitHub fine-grained token",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    ],
    ["OpenAI-style key", "key sk-proj-1234567890abcdef", "sk-proj-1234567890abcdef"],
    ["Bearer token", "Authorization: Bearer abc.def.ghi-123", "abc.def.ghi-123"],
    ["AWS access key", "aws AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    ["Slack token", "slack xoxb-1234567890-abcdef", "xoxb-1234567890-abcdef"],
    [
      "private key block",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA",
    ],
    ["URL credentials", "https://user:hunter2@example.test/org/repo.git", "hunter2"],
    ["x-access-token URL", "https://x-access-token:hunter2@example.test/org/repo.git", "hunter2"],
    ["database URL credentials", "postgres://user:hunter2@localhost:5432/reviewer", "hunter2"],
    ["token key/value", `token=${TOKEN}`, TOKEN],
    ["prefixed token key/value", `access_token=${TOKEN}`, TOKEN],
    ["quoted password key/value", '"password": "hunter2"', "hunter2"],
    ["apiKey key/value", "apiKey: abc123", "abc123"],
    ["camelCase token key/value", "githubToken: abc123", "abc123"],
    ["client_secret key/value", "client_secret: abc123", "abc123"],
    ["cookie key/value", "cookie: session=abc123; theme=dark", "abc123"],
    ["quoted authorization key/value", '"authorization": "Bearer abc123"', "abc123"],
    ["quoted cookie key/value", '"cookie": "session=abc123"', "abc123"],
    ["privateKey key/value", 'privateKey: "-----BEGIN PRIVATE KEY-----abc"', "PRIVATE KEY-----abc"],
  ])("masks %s", (_name, input, secret) => {
    const redacted = redactSecrets(input);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[REDACTED]");
  });

  test("preserves ordinary field messages and paths", () => {
    const input = "field repository must match owner/repo; see /api/admin/config";
    expect(redactSecrets(input)).toBe(input);
  });

  test("is idempotent", () => {
    const once = redactSecrets(`token ${TOKEN}`);
    expect(redactSecrets(once)).toBe(once);
  });
});

describe("redactDetails", () => {
  test("masks secret keys and token patterns while preserving field errors", () => {
    const details = {
      token: TOKEN,
      nested: { password: "hunter2", apiKey: "abc123" },
      field: "repository",
      issues: [{ path: "repository", message: `token ${TOKEN} is invalid` }],
    };

    const redacted = redactDetails(details);
    expect(redacted).toEqual({
      token: "[REDACTED]",
      nested: { password: "[REDACTED]", apiKey: "[REDACTED]" },
      field: "repository",
      issues: [{ path: "repository", message: "token [REDACTED] is invalid" }],
    });
    expect(JSON.stringify(redacted)).not.toContain(TOKEN);
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
  });

  test("preserves arrays and scalar values", () => {
    expect(redactDetails(["owner/repo", 42, true, null])).toEqual(["owner/repo", 42, true, null]);
  });

  test("truncates values beyond the depth cap", () => {
    const deep = { level: { level: { level: { level: { level: { level: { level: "secret" } } } } } } };
    const redacted = redactDetails(deep);
    expect(JSON.stringify(redacted)).toContain("[TRUNCATED]");
    expect(JSON.stringify(redacted)).not.toContain("secret");
  });

  test("passes through undefined", () => {
    expect(redactDetails(undefined)).toBeUndefined();
  });
});

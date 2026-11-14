import { describe, expect, test } from "vitest";
import { ERROR_CODES, errorEnvelopeSchema } from "../../contracts/errors.js";
import {
  AppError,
  AuthError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ProviderError,
  RateLimitError,
  ValidationError,
} from "../../shared/errors/index.js";
import { toErrorLogPayload, toHttpEnvelope } from "./error-mapper.js";

interface MapperCase {
  name: string;
  create: () => AppError;
  code: string;
  statusCode: number;
  retryable: boolean;
}

const CASES: MapperCase[] = [
  {
    name: "ValidationError",
    create: () => new ValidationError("invalid input"),
    code: ERROR_CODES.VALIDATION_ERROR,
    statusCode: 400,
    retryable: false,
  },
  {
    name: "AuthError",
    create: () => new AuthError("authentication required"),
    code: ERROR_CODES.UNAUTHORIZED,
    statusCode: 401,
    retryable: false,
  },
  {
    name: "ForbiddenError",
    create: () => new ForbiddenError("access denied"),
    code: ERROR_CODES.FORBIDDEN,
    statusCode: 403,
    retryable: false,
  },
  {
    name: "NotFoundError",
    create: () => new NotFoundError("missing"),
    code: ERROR_CODES.NOT_FOUND,
    statusCode: 404,
    retryable: false,
  },
  {
    name: "ConflictError",
    create: () => new ConflictError("conflict"),
    code: ERROR_CODES.CONFLICT,
    statusCode: 409,
    retryable: false,
  },
  {
    name: "RateLimitError",
    create: () => new RateLimitError("slow down"),
    code: ERROR_CODES.RATE_LIMITED,
    statusCode: 429,
    retryable: true,
  },
  {
    name: "ProviderError(rate_limit)",
    create: () => new ProviderError("rate_limit", "provider rate limited"),
    code: ERROR_CODES.PROVIDER_ERROR,
    statusCode: 503,
    retryable: true,
  },
  {
    name: "ProviderError(network)",
    create: () => new ProviderError("network", "connection reset"),
    code: ERROR_CODES.PROVIDER_ERROR,
    statusCode: 502,
    retryable: true,
  },
  {
    name: "InternalError",
    create: () => new InternalError("unexpected"),
    code: ERROR_CODES.INTERNAL_ERROR,
    statusCode: 500,
    retryable: false,
  },
];

describe("toHttpEnvelope", () => {
  test.each(CASES)("$name maps to its status and stable code", (testCase) => {
    const result = toHttpEnvelope(testCase.create());
    const serverFailure = testCase.statusCode >= 500;
    expect(result.statusCode).toBe(serverFailure ? 500 : testCase.statusCode);
    expect(result.body.code).toBe(serverFailure ? ERROR_CODES.INTERNAL_ERROR : testCase.code);
    expect(result.body.statusCode).toBe(serverFailure ? 500 : testCase.statusCode);
    expect(result.body.message).toBe(serverFailure ? "Internal server error" : testCase.create().message);
    expect(errorEnvelopeSchema.safeParse(result.body).success).toBe(true);
  });

  test("includes safe details and preserves a custom code", () => {
    const details = { field: "repository", expected: "owner/repo" };
    const result = toHttpEnvelope(new ValidationError("invalid repository", { code: "INVALID_REPOSITORY", details }));

    expect(result.statusCode).toBe(400);
    expect(result.body).toEqual({
      code: "INVALID_REPOSITORY",
      message: "invalid repository",
      statusCode: 400,
      details,
    });
    expect(errorEnvelopeSchema.safeParse(result.body).success).toBe(true);
  });

  test("omits the details key when no details were supplied", () => {
    const result = toHttpEnvelope(new NotFoundError("missing"));
    expect(result.body).not.toHaveProperty("details");
  });

  test("redacts tokens in a 4xx message", () => {
    const token = "ghp_messageSecret1234567890";
    const result = toHttpEnvelope(new ValidationError(`invalid token ${token}`));

    expect(result.statusCode).toBe(400);
    expect(result.body.message).toBe("invalid token [REDACTED]");
    expect(JSON.stringify(result.body)).not.toContain(token);
  });

  test("redacts tokens in 4xx details while preserving field paths and messages", () => {
    const token = "ghp_detailsSecret1234567890";
    const result = toHttpEnvelope(
      new ValidationError("invalid request", {
        details: {
          token,
          fields: [{ path: "repository", message: `token ${token} is invalid` }],
        },
      }),
    );

    expect(result.statusCode).toBe(400);
    expect(result.body.details).toEqual({
      token: "[REDACTED]",
      fields: [{ path: "repository", message: "token [REDACTED] is invalid" }],
    });
    expect(JSON.stringify(result.body)).not.toContain(token);
  });

  test("drops invalid details without downgrading the 4xx status or code", () => {
    const result = toHttpEnvelope(
      new ValidationError("invalid request", {
        details: { callback: () => undefined },
      }),
    );

    expect(result.statusCode).toBe(400);
    expect(result.body).toEqual({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: "invalid request",
      statusCode: 400,
    });
    expect(result.body).not.toHaveProperty("details");
  });

  test("never exposes a 5xx message or details, including SQL and paths", () => {
    const error = new InternalError("query failed: SELECT * FROM reviews at /srv/app/db.ts", {
      details: { query: "SELECT * FROM reviews", path: "/srv/app/db.ts" },
    });
    const result = toHttpEnvelope(error);

    expect(result).toEqual({
      statusCode: 500,
      body: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: "Internal server error",
        statusCode: 500,
      },
    });
    expect(JSON.stringify(result)).not.toContain("SELECT");
    expect(JSON.stringify(result)).not.toContain("/srv/app");
  });

  test("maps an unknown error to a generic 500 without its message or stack", () => {
    const error = new Error("database password hunter2 failed at /srv/app/secret.ts");
    const result = toHttpEnvelope(error);

    expect(result.statusCode).toBe(500);
    expect(result.body).toEqual({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: "Internal server error",
      statusCode: 500,
    });
    expect(JSON.stringify(result.body)).not.toContain("hunter2");
    expect(JSON.stringify(result.body)).not.toContain("/srv/app");
    expect(result.body).not.toHaveProperty("stack");
    expect(result.body).not.toHaveProperty("cause");
    expect(errorEnvelopeSchema.safeParse(result.body).success).toBe(true);
  });
});

describe("toErrorLogPayload", () => {
  test.each(CASES)("$name produces a safe structured log payload", (testCase) => {
    const payload = toErrorLogPayload(testCase.create(), "queue");
    const serverFailure = testCase.statusCode >= 500;
    expect(payload.code).toBe(testCase.code);
    expect(payload.statusCode).toBe(testCase.statusCode);
    expect(payload.message).toBe(serverFailure ? "Internal server error" : testCase.create().message);
    expect(payload.retryable).toBe(testCase.retryable);
    expect(payload.disposition).toBe(testCase.retryable ? "retry" : "fail");
  });

  test("reports retry dispositions for retryable errors", () => {
    const payload = toErrorLogPayload(new RateLimitError("slow down"), "queue");
    expect(payload).toMatchObject({ disposition: "retry", retryable: true, code: ERROR_CODES.RATE_LIMITED });
  });

  test("unknown errors produce a generic payload", () => {
    const payload = toErrorLogPayload(new Error("token ghp_logSecret"), "outbox");
    expect(payload).toMatchObject({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: "Internal server error",
      statusCode: 500,
      retryable: false,
      disposition: "fail",
    });
    expect(JSON.stringify(payload)).not.toContain("ghp_logSecret");
  });

  test("redacts tokens in 4xx messages and details but keeps field errors", () => {
    const token = "ghp_logDetailsSecret1234567890";
    const error = new ValidationError(`invalid token ${token}`, {
      details: { token, field: "repository", issues: [{ path: "repository", message: `token ${token}` }] },
      cause: new Error(token),
    });
    const payload = toErrorLogPayload(error, "queue");

    expect(payload.message).toBe("invalid token [REDACTED]");
    expect(payload.details).toEqual({
      token: "[REDACTED]",
      field: "repository",
      issues: [{ path: "repository", message: "token [REDACTED]" }],
    });
    expect(JSON.stringify(payload)).not.toContain(token);
    expect(payload).not.toHaveProperty("cause");
    expect(payload).not.toHaveProperty("stack");
  });

  test("suppresses 5xx messages, details, and caller reasons in the log payload", () => {
    const token = "ghp_internalSecret1234567890";
    const error = new InternalError("query failed: SELECT * FROM reviews at /srv/app/db.ts", {
      retryable: true,
      retryableReason: `token ${token} at /srv/app/db.ts`,
      details: { query: "SELECT * FROM reviews" },
    });
    const payload = toErrorLogPayload(error, "queue");

    expect(payload.message).toBe("Internal server error");
    expect(payload).not.toHaveProperty("details");
    expect(payload.reason).not.toContain(token);
    expect(payload.reason).not.toContain("SELECT");
    expect(payload.reason).not.toContain("/srv/app");
    expect(payload).not.toHaveProperty("cause");
    expect(payload).not.toHaveProperty("stack");
  });
});

describe("secret leakage", () => {
  test("an error cause carrying a token never reaches an envelope or log payload", () => {
    const token = "ghp_superSecretToken1234567890";
    const error = new AppError("provider request failed", {
      code: ERROR_CODES.PROVIDER_ERROR,
      statusCode: 502,
      retryable: true,
      details: { providerCode: "network" },
      cause: {
        token,
        authorization: `Bearer ${token}`,
        url: `https://x-access-token:${token}@example.test/org/repo.git`,
      },
    });

    const envelope = toHttpEnvelope(error);
    const logPayload = toErrorLogPayload(error, "queue");
    const serialized = JSON.stringify({ envelope, logPayload });

    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("x-access-token");
    expect(serialized).not.toContain("example.test");
    expect(serialized).not.toContain("cause");
    expect(serialized).not.toContain("stack");
    expect(errorEnvelopeSchema.safeParse(envelope.body).success).toBe(true);
  });
});

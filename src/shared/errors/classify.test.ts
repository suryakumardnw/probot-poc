import { describe, expect, test } from "vitest";
import { ERROR_CODES } from "../../contracts/errors.js";
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
  classifyFailure,
  type ProviderFailureCode,
} from "./index.js";

interface ErrorCase {
  name: string;
  create: () => AppError;
  code: string;
  statusCode: number;
  retryable: boolean;
}

const rateLimitProvider = (options: { statusCode?: number } = {}) =>
  new ProviderError("rate_limit", "provider rate limited", options);

const CASES: ErrorCase[] = [
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
    create: () => rateLimitProvider(),
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
    name: "ProviderError(provider_unavailable)",
    create: () => new ProviderError("provider_unavailable", "provider down"),
    code: ERROR_CODES.PROVIDER_ERROR,
    statusCode: 503,
    retryable: true,
  },
  {
    name: "ProviderError(timeout)",
    create: () => new ProviderError("timeout", "provider timed out"),
    code: ERROR_CODES.PROVIDER_ERROR,
    statusCode: 502,
    retryable: false,
  },
  {
    name: "ProviderError(auth_failure)",
    create: () => new ProviderError("auth_failure", "provider rejected credentials"),
    code: ERROR_CODES.PROVIDER_ERROR,
    statusCode: 502,
    retryable: false,
  },
  {
    name: "ProviderError(invalid_request)",
    create: () => new ProviderError("invalid_request", "provider rejected the request"),
    code: ERROR_CODES.PROVIDER_ERROR,
    statusCode: 502,
    retryable: false,
  },
  {
    name: "ProviderError(unknown)",
    create: () => new ProviderError("unknown", "provider failed"),
    code: ERROR_CODES.PROVIDER_ERROR,
    statusCode: 502,
    retryable: false,
  },
  {
    name: "ProviderError(explicit 5xx)",
    create: () => new ProviderError("auth_failure", "upstream 500", { statusCode: 500 }),
    code: ERROR_CODES.PROVIDER_ERROR,
    statusCode: 500,
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

describe("AppError family", () => {
  test.each(CASES)("$name has the documented status and retryability", (testCase) => {
    const error = testCase.create();
    expect(error).toBeInstanceOf(AppError);
    expect(error.name).toBe(testCase.name.startsWith("ProviderError") ? "ProviderError" : testCase.name);
    expect(error.code).toBe(testCase.code);
    expect(error.statusCode).toBe(testCase.statusCode);
    expect(error.retryable).toBe(testCase.retryable);
  });

  test("AppError itself defaults to INTERNAL_ERROR, 500, not retryable", () => {
    const error = new AppError("unexpected");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AppError");
    expect(error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(error.statusCode).toBe(500);
    expect(error.retryable).toBe(false);
  });

  test("subclasses preserve custom codes, safe details, and cause", () => {
    const cause = new Error("root cause");
    const details = { repository: "org/repo", pullRequest: 42 };
    const error = new NotFoundError("review not found", {
      code: "REVIEW_NOT_FOUND",
      details,
      cause,
    });

    expect(error.code).toBe("REVIEW_NOT_FOUND");
    expect(error.statusCode).toBe(404);
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual(details);
    expect(error.cause).toBe(cause);
  });

  test("ProviderError keeps the provider code separate from the stable app code", () => {
    const error = new ProviderError("rate_limit", "slow down");
    expect(error.providerCode).toBe("rate_limit");
    expect(error.code).toBe(ERROR_CODES.PROVIDER_ERROR);
    expect(error.details).toEqual({ providerCode: "rate_limit" });
  });

  test("ProviderError defaults retryability per provider code", () => {
    const retryableCodes: ProviderFailureCode[] = ["rate_limit", "network", "provider_unavailable"];
    for (const code of retryableCodes) {
      expect(new ProviderError(code, "transient").retryable).toBe(true);
    }
    const permanentCodes: ProviderFailureCode[] = [
      "auth_failure",
      "timeout",
      "invalid_request",
      "invalid_json",
      "unexpected_format",
      "missing_usage",
      "unknown",
    ];
    for (const code of permanentCodes) {
      expect(new ProviderError(code, "permanent").retryable).toBe(false);
    }
  });

  test("ProviderError treats an explicit 5xx status as retryable", () => {
    expect(new ProviderError("invalid_json", "upstream 503", { statusCode: 503 }).retryable).toBe(true);
  });

  test("ProviderError and InternalError may override retryability with an explicit reason", () => {
    const provider = new ProviderError("auth_failure", "transient auth failure", {
      retryable: true,
      retryableReason: "provider rotates credentials during deploys",
    });
    expect(provider.retryable).toBe(true);
    expect(classifyFailure(provider, "queue").reason).toBe("provider rotates credentials during deploys");

    const internal = new InternalError("database connection lost", {
      retryable: true,
      retryableReason: "database failover is in progress",
    });
    expect(internal.retryable).toBe(true);
    expect(classifyFailure(internal, "outbox").reason).toBe("database failover is in progress");
  });

  test("the classifier does not copy messages or causes into its reason", () => {
    const token = "ghp_classifierSecret123";
    const error = new AppError(`request failed for ${token}`, {
      code: "PROVIDER_ERROR",
      statusCode: 502,
      retryable: true,
      cause: { token },
    });

    for (const context of ["http", "queue", "outbox"] as const) {
      const result = classifyFailure(error, context);
      expect(result.reason).not.toContain(token);
    }
  });
});

describe("classifyFailure", () => {
  test.each(CASES)("$name is never retried for an HTTP request", (testCase) => {
    const result = classifyFailure(testCase.create(), "http");
    expect(result).toEqual({
      disposition: "fail",
      code: testCase.code,
      reason: expect.any(String),
    });
  });

  test.each(CASES)("$name maps to the documented queue disposition", (testCase) => {
    const result = classifyFailure(testCase.create(), "queue");
    expect(result).toEqual({
      disposition: testCase.retryable ? "retry" : "fail",
      code: testCase.code,
      reason: expect.any(String),
    });
  });

  test.each(CASES)("$name maps to the documented outbox disposition", (testCase) => {
    const result = classifyFailure(testCase.create(), "outbox");
    expect(result).toEqual({
      disposition: testCase.retryable ? "retry" : "fail",
      code: testCase.code,
      reason: expect.any(String),
    });
  });

  test.each([
    ["an Error", new Error("boom")],
    ["a string", "boom"],
    ["null", null],
    ["undefined", undefined],
    ["an object with a code-like shape", { code: ERROR_CODES.VALIDATION_ERROR, retryable: true }],
  ])("treats %s as a non-retryable internal failure", (_name, error) => {
    for (const context of ["http", "queue", "outbox"] as const) {
      const result = classifyFailure(error, context);
      expect(result.disposition).toBe("fail");
      expect(result.code).toBe(ERROR_CODES.INTERNAL_ERROR);
      expect(result.reason).not.toContain("boom");
    }
  });

  test("rate-limited provider failures retry in queue and outbox contexts", () => {
    const error = rateLimitProvider();
    expect(classifyFailure(error, "queue")).toMatchObject({ disposition: "retry", code: ERROR_CODES.PROVIDER_ERROR });
    expect(classifyFailure(error, "outbox")).toMatchObject({
      disposition: "retry",
      code: ERROR_CODES.PROVIDER_ERROR,
    });
  });

  test("explicit HTTP classification stays fail even for a retryable error", () => {
    expect(classifyFailure(new RateLimitError("slow down"), "http").disposition).toBe("fail");
  });
});

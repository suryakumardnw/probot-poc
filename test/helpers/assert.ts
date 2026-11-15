/**
 * Narrowing helpers for tests.
 *
 * `expect(value).toBeDefined()` does not narrow the TypeScript type, and the
 * repository forbids non-null assertions. These helpers fail the test with a
 * clear message instead, so indexing fixture arrays and reading `findFirst`
 * results stays both checked and assertion-free.
 */

/** Return a present value or fail the test when it is null/undefined. */
export function defined<T>(value: T | null | undefined, label = "value"): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  // The guard above proves the value is present; TypeScript cannot express
  // `T | null | undefined -> NonNullable<T>` on a generic without a cast.
  return value as NonNullable<T>;
}

/** Return one array element or fail the test when it is missing. */
export function at<T>(values: readonly T[], index: number, label = `element ${index}`): T {
  return defined(values[index], label);
}

/** Return the first array element or fail the test when the array is empty. */
export function first<T>(values: readonly T[], label = "first element"): T {
  return at(values, 0, label);
}

/** Await a rejection or fail the test when the promise resolves. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

/** Narrow a rejection to a known error class without a cast. */
export function instanceOf<T>(
  value: unknown,
  constructor: abstract new (...args: never[]) => T,
  label = constructor.name,
): T {
  if (!(value instanceof constructor)) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

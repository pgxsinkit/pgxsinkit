/**
 * The error a promise rejects with; fails when it resolves. Lets a test assert on the rejection with
 * plain matchers (`toBeInstanceOf`, `toBe`, a message regex) rather than `.rejects`, whose bun-types
 * signature is `void`.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error rejection, got ${String(error)}`, { cause: error });
  }
  throw new Error("expected the promise to reject, but it resolved");
}

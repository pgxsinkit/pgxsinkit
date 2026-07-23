import { describe, expect, it } from "bun:test";

import { describeErrorChain } from "../../packages/client/src/error-chain";

// Driver wrappers (drizzle's "Failed query: …") carry the REAL database error on `.cause` — the chain
// flattener is what keeps SQLSTATE/detail visible in `status.lastError` and the worker's sync-error
// broadcast instead of dying at the wrapper text.
describe("describeErrorChain", () => {
  it("flattens a drizzle-shaped wrapper down to the database error with code and detail", () => {
    const pgError = Object.assign(new Error('invalid input syntax for type json, Token "object" is invalid'), {
      code: "22P02",
      detail: "Expected JSON value, but found object.",
    });
    const wrapper = new Error("Failed query: UPDATE ...\nparams: [object Object]", { cause: pgError });

    expect(describeErrorChain(wrapper)).toBe(
      'Failed query: UPDATE ...\nparams: [object Object] ← caused by: invalid input syntax for type json, Token "object" is invalid [22P02] (Expected JSON value, but found object.)',
    );
  });

  it("handles plain errors, string causes, and bounds the depth", () => {
    expect(describeErrorChain(new Error("plain"))).toBe("plain");
    expect(describeErrorChain(new Error("outer", { cause: "inner string" }))).toBe("outer ← caused by: inner string");
    let deep: Error = new Error("level-0");
    for (let i = 1; i < 10; i += 1) deep = new Error(`level-${i}`, { cause: deep });
    expect(describeErrorChain(deep).split("← caused by:").length).toBe(5);
  });
});

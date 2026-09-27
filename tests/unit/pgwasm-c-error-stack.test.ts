import { afterEach, describe, expect, it } from "bun:test";

import type { BackendMessage } from "../../packages/pgwasm/src/protocol";
import { protocol, serialize } from "../../packages/pgwasm/src/protocol";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";

afterEach(closeTestPgwasms);

// A Postgres ERROR reaches the host as a throw that abandons the wasm frames without their epilogues, so
// each one would leave the shadow stack pointer where the deepest frame put it (about 1.2 kB for
// `SELECT 1/0`): unrestored, the ~1,700th error in one instance became "stack depth limit exceeded", and
// so did every statement after it. Enough errors to pass that point comfortably.
const ERRORS = 2500;
const DIVISION_BY_ZERO = "division by zero";

/** The first reply, in order, whose error is not `expected`, with its 1-based number. */
function firstWrongError(
  replies: readonly (readonly BackendMessage[])[],
  expected: string,
): { readonly error: number; readonly message: string } | undefined {
  let error = 0;
  for (const reply of replies) {
    for (const message of reply) {
      if (message.name !== "error") continue;
      error += 1;
      const text = (message as { message?: unknown }).message;
      if (text !== expected) return { error, message: String(text) };
    }
  }
  return error === ERRORS ? undefined : { error, message: `only ${error} errors of ${ERRORS}` };
}

describe("the C build's shadow stack across Postgres errors", () => {
  it("stays put across thousands of errors, one exchange each", async () => {
    const pg = await createTestPgwasm();
    const wire = protocol(pg);
    const statement = serialize.query("SELECT 1/0");
    const replies: BackendMessage[][] = [];
    for (let i = 0; i < ERRORS; i += 1) {
      replies.push((await wire.execProtocol(statement, { throwOnError: false })).messages);
    }
    expect(firstWrongError(replies, DIVISION_BY_ZERO)).toBeUndefined();
    expect((await pg.query<{ ok: number }>("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
  });

  it("stays put across thousands of errors batched into one exchange", async () => {
    const pg = await createTestPgwasm();
    const wire = protocol(pg);
    const statement = serialize.query("SELECT 1/0");
    const batch = new Uint8Array(statement.length * ERRORS);
    for (let i = 0; i < ERRORS; i += 1) batch.set(statement, i * statement.length);
    const reply = (await wire.execProtocol(batch, { throwOnError: false })).messages;
    expect(firstWrongError([reply], DIVISION_BY_ZERO)).toBeUndefined();
    expect((await pg.query<{ ok: number }>("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
  });
});

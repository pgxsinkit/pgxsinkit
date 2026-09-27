import { afterEach, describe, expect, it } from "bun:test";

import { PgwasmFailedError } from "../../packages/pgwasm/src";
import type { BackendMessage } from "../../packages/pgwasm/src/protocol";
import { protocol, serialize } from "../../packages/pgwasm/src/protocol";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { rejectionOf } from "./support/rejection";

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

// A FATAL error exits the backend (proc_exit), whose exit callbacks tear the session down (they even write
// the shutdown checkpoint): the main loop must not resume on it. A client reaches one through protocol(pg).
describe("a FATAL error through protocol(pg)", () => {
  const ENDED =
    /^pgwasm failed and must be closed: the build threw Error: Postgres exited with status 1 during an exchange: a FATAL error ended the C build's session:\n/;

  async function expectFailedFor(message: Uint8Array, fatal: RegExp): Promise<void> {
    const pg = await createTestPgwasm();
    const failure = await rejectionOf(protocol(pg).execProtocolRaw(message));
    expect(failure).toBeInstanceOf(PgwasmFailedError);
    expect(failure.message).toMatch(ENDED);
    expect(failure.message).toMatch(fatal);
    // The instance is failed: every later statement throws that failure at once, and close reports it.
    expect(await rejectionOf(pg.query("SELECT 1"))).toBe(failure);
    expect(pg.ready).toBe(false);
    expect(await rejectionOf(pg.close())).toBe(failure);
    expect(pg.closed).toBe(true);
  }

  it("fails the instance when a protocol violation in the main loop ends the session", async () => {
    // A message type no frontend sends: PostgresMain answers it with FATAL.
    await expectFailedFor(new Uint8Array([0x01, 0, 0, 0, 4]), /FATAL: {2}invalid frontend message type 1\n/);
  });

  it("fails the instance when a startup packet is refused with FATAL", async () => {
    // Protocol version 0.0, which no server supports.
    await expectFailedFor(new Uint8Array([0, 0, 0, 8, 0, 0, 0, 0]), /FATAL: {2}unsupported frontend protocol 0\.0/);
  });
});

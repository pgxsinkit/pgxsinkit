import { afterEach, describe, expect, it } from "bun:test";

import { cBuild } from "../../packages/pgwasm-c/src";
import { createPgwasm, type Pgwasm } from "../../packages/pgwasm/src";
import { live, type LiveNamespace } from "../../packages/pgwasm/src/live";
import { closeTestPgwasms, seedBackup } from "./support/pgwasm";

// Type-level contract, checked by `bun run typecheck` (this file is in its program): an extension
// written inline in `createPgwasm({ extensions })` gets `pg: Pgwasm` in its `setup` without an
// annotation, and the namespaces of inline and predefined extensions are still inferred onto the
// database. If `pg` regresses to an implicit `any`, the typecheck fails on the `Equal` lines below
// (and on noImplicitAny); if namespace inference regresses, it fails on the namespace lines.

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(value: T): T => value;

let open: Pgwasm | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
  await closeTestPgwasms();
});

describe("extensions written inline", () => {
  it("get a typed pg in setup, and their namespaces on the database", async () => {
    const setupSaw: string[] = [];
    const db = await createPgwasm({
      build: cBuild,
      loadDataDir: await seedBackup(),
      extensions: {
        live,
        greeter: {
          name: "greeter",
          setup: async (pg) => {
            assertType<Equal<typeof pg, Pgwasm>>(true);
            setupSaw.push(pg.storage.kind);
            return {
              namespace: { greet: (who: string) => `hello ${who}`, answer: 42 as const },
              init: async () => {
                setupSaw.push(String((await pg.query<{ one: number }>("SELECT 1 AS one")).rows[0]?.one));
              },
            };
          },
        },
        silent: {
          name: "silent",
          setup: async (pg) => {
            assertType<Equal<typeof pg, Pgwasm>>(true);
            return {};
          },
        },
      },
    });
    open = db;

    // Namespaces: the inline one exactly as returned, the predefined one as declared, and none for an
    // extension that attaches nothing.
    assertType<Equal<typeof db.greeter, { greet: (who: string) => string; answer: 42 }>>(true);
    assertType<Equal<typeof db.live, LiveNamespace>>(true);
    assertType<Equal<"silent" extends keyof typeof db ? true : false, false>>(true);

    expect(db.greeter.greet("pgwasm")).toBe("hello pgwasm");
    expect(db.greeter.answer).toBe(42);
    expect(typeof db.live.query).toBe("function");
    expect(setupSaw).toEqual(["memory", "1"]);
  });
});

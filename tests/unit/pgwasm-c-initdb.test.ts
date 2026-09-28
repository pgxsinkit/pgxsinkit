// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { createCBuild } from "../../packages/pgwasm-c/src";
import { commandWords } from "../../packages/pgwasm-c/src/host/command-line";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { MemoryVfs } from "./support/pgwasm-memory-vfs";

afterEach(closeTestPgwasms);

describe("creating a data directory", () => {
  it("runs initdb on its own scratch instance, never on the storage it fills", async () => {
    // A filesystem holding exclusive resources (an OPFS store's handles) must be initialised once.
    const fs = new MemoryVfs();
    const pg = await createTestPgwasm({ fs, fresh: true });
    expect(fs.initialSyncs).toBe(1);
    expect(fs.has("/PG_VERSION")).toBe(true);
    expect(fs.has("/PGWASM_BUILD")).toBe(true);
    await pg.exec("CREATE TABLE t (id int); INSERT INTO t VALUES (1);");
    expect((await pg.query<{ id: number }>("SELECT id FROM t")).rows).toEqual([{ id: 1 }]);
    await pg.close();
    expect(fs.closed).toBe(true);
  });

  it("splits the command lines initdb runs into the backend's arguments", async () => {
    const commands: string[] = [];
    const build = createCBuild({ onInitdbCommand: (command) => commands.push(command) });
    const pg = await createTestPgwasm({ build, fresh: true });
    expect((await pg.query<{ one: number }>("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);

    // initdb runs the backend twice: bootstrap mode, then single-user mode for the post-bootstrap SQL.
    expect(commands.length).toBeGreaterThanOrEqual(2);
    for (const command of commands) {
      const words = commandWords(command);
      expect(words[0]).toBe("/pgwasm/bin/postgres");
      // Redirections never reach the backend's arguments.
      expect(words.some((word) => /[<>|&;]/.test(word))).toBe(false);
    }
    expect(commands.some((command) => commandWords(command).includes("--boot"))).toBe(true);
    expect(commands.some((command) => commandWords(command).includes("--single"))).toBe(true);
  });
});

describe("commandWords", () => {
  it("keeps quoted words whole and stops at the first operator", () => {
    expect(commandWords(`"/pgwasm/bin/postgres" --boot -X 1048576 -F -c log_checkpoints=false`)).toEqual([
      "/pgwasm/bin/postgres",
      "--boot",
      "-X",
      "1048576",
      "-F",
      "-c",
      "log_checkpoints=false",
    ]);
    expect(commandWords(`"/pgwasm/bin/postgres" --single -F -O -j template1 >"/dev/null"`)).toEqual([
      "/pgwasm/bin/postgres",
      "--single",
      "-F",
      "-O",
      "-j",
      "template1",
    ]);
    expect(commandWords(`a 'b c' "d \\"e\\"" f\\ g 2>&1 ignored`)).toEqual(["a", "b c", 'd "e"', "f g", "2"]);
    expect(commandWords(`  spaced   out  `)).toEqual(["spaced", "out"]);
  });

  it("refuses an unterminated quote", () => {
    expect(() => commandWords(`"unterminated`)).toThrow(SyntaxError);
    expect(() => commandWords(`'unterminated`)).toThrow(SyntaxError);
  });
});

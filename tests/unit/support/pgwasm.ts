import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";

import { cBuild } from "../../../packages/pgwasm-c/src";
import { createPgwasm, type Extensions, type Pgwasm, type PgwasmOptions } from "../../../packages/pgwasm/src";
import type { PostgresBuild } from "../../../packages/pgwasm/src/build";

/**
 * Test databases on the C build.
 *
 * A database starts from a seed data directory rather than running initdb every time: the
 * prepopulated data directory, an unmarked C-build directory made before builds were recorded. Every
 * seeded boot therefore also exercises the rule that an unmarked directory is the C build's, and that a
 * created directory gets marked. Step 2 of ADR-0062 moves the seed into pgwasm-c; this file is the one
 * place to switch.
 */

let seed: Promise<Blob> | undefined;

/** The seed data directory, as a Store backup. */
export function seedBackup(): Promise<Blob> {
  seed ??= prepopulatedDataDir();
  return seed;
}

const open = new Set<Pgwasm>();

export type TestPgwasmOptions<E extends Extensions> = Omit<PgwasmOptions<E>, "build"> & {
  readonly build?: PostgresBuild;
  /** Run initdb instead of starting from the seed. */
  readonly fresh?: boolean;
};

/** A database on the C build (or `build`), seeded unless it opens existing storage or is `fresh`. */
export async function createTestPgwasm<E extends Extensions = Record<never, never>>(
  options: TestPgwasmOptions<E> = {},
) {
  const { fresh = false, build = cBuild, ...rest } = options;
  const opensExisting = rest.dataDir !== undefined && !rest.dataDir.startsWith("memory://");
  const seeded = !fresh && !opensExisting && rest.fs === undefined && rest.loadDataDir === undefined;
  const pg = await createPgwasm<E>({
    ...rest,
    build,
    ...(seeded ? { loadDataDir: await seedBackup() } : {}),
  });
  open.add(pg);
  return pg;
}

/** Close every database the helpers opened that is still open. */
export async function closeTestPgwasms(): Promise<void> {
  const closing = [...open];
  open.clear();
  for (const pg of closing) {
    if (!pg.closed) {
      await pg.close().catch(() => undefined);
    }
  }
}

/**
 * A fresh scratch directory under the repository's `tmp/agents/` (never the system temp directory),
 * removed by `cleanup`. The unit runner's working directory is the repository root.
 */
export function scratchDir(prefix: string): { readonly path: string; cleanup(): void } {
  const parent = path.resolve("tmp/agents");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, `${prefix}-`));
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

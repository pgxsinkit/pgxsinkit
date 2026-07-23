/**
 * ADR-0046 — a restore boot whose recovered journal is CLEAN (the server-built bootstrap-artifact case) must
 * come ONLINE and RESUME sync, converging to server changes made AFTER the backup was taken. On the
 * pre-ADR-0046 always-offline restore this is the exact production failure: the restored client reports
 * `ready` but never syncs, so it is silently stale forever.
 *
 * Runs against real Electric+Postgres on the repo's Podman lane (DATABASE_URL/ELECTRIC_URL are set by
 * scripts/run-integration-suite.ts; the `projects` server table is provisioned by `db:migrate`). The store is
 * file-backed under the repo-local `tmp/agents` (gitignored) per the temp-file rule.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { createSyncClient } from "@pgxsinkit/client";
import { projectsSyncRegistry, projectsTable } from "@pgxsinkit/schema";
import { createServerDb, readIntegrationEnv, waitFor } from "@pgxsinkit/test-utils";

const env = readIntegrationEnv();
// A well-formed but dead write endpoint. This test never writes/flushes (a clean journal, no `autoSync`), so
// the write path is never exercised — only read/sync convergence matters, which rides `electricUrl`.
const DEAD_WRITE = "http://127.0.0.1:1/api/mutations";
const STORE_ROOT = "tmp/agents";

describe("restore resume (ADR-0046)", () => {
  const serverDb = createServerDb(projectsSyncRegistry, env.databaseUrl);
  const createdStorePaths: string[] = [];

  beforeAll(async () => {
    await mkdir(STORE_ROOT, { recursive: true });
  });

  beforeEach(async () => {
    await serverDb.db.delete(projectsTable);
  });

  afterAll(async () => {
    for (const path of createdStorePaths.splice(0)) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
    await serverDb.close();
  });

  it("a clean-journal restore comes online and converges to a post-export server change", async () => {
    const goalId = randomUUID();
    // A goal-like row: uuid pk + a text title (`name`). The server-side defaults fill the audit columns.
    await serverDb.db.insert(projectsTable).values({ id: goalId, name: "before export" });

    // ── Client A: sync the row to ready on a file-backed store, then take a store backup ──────────────────
    const storePathA = join(STORE_ROOT, `restore-resume-a-${randomUUID()}`);
    createdStorePaths.push(storePathA);
    const clientA = await createSyncClient({
      registry: projectsSyncRegistry,
      electricUrl: env.electricUrl,
      batchWriteUrl: DEAD_WRITE,
      storePath: storePathA,
    });
    let backup!: Blob;
    try {
      await clientA.ready;
      await waitFor(async () => {
        const rows = await clientA.drizzle.select().from(projectsTable);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.name).toBe("before export");
      });
      // The backup carries a CLEAN journal (no client writes were made) — the ADR-0046 online-restore case.
      backup = (await clientA.exportStore()).file;
    } finally {
      // `stop()` (not `destroy()`) preserves A's datadir; afterAll removes it.
      await clientA.stop();
    }

    // ── The post-export server change the restored client must catch up — the exact production failure ────
    await serverDb.db.update(projectsTable).set({ name: "after export" }).where(eq(projectsTable.id, goalId));

    // ── Client B: restore A's backup into a FRESH store; a clean recovered journal boots ONLINE (ADR-0046) ─
    const storePathB = join(STORE_ROOT, `restore-resume-b-${randomUUID()}`);
    createdStorePaths.push(storePathB);
    const clientB = await createSyncClient({
      registry: projectsSyncRegistry,
      electricUrl: env.electricUrl,
      batchWriteUrl: DEAD_WRITE,
      storePath: storePathB,
      restoreFrom: backup,
    });
    try {
      await clientB.ready;
      // Convergence (the required assertion): the restored client RESUMED sync and pulled the post-export
      // UPDATE. On the pre-ADR-0046 always-offline restore this poll times out — the local row stays
      // "before export" forever because no shape stream ever starts.
      await waitFor(async () => {
        const rows = await clientB.drizzle.select().from(projectsTable);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.name).toBe("after export");
      });
      // The recovered journal was clean → nothing quarantined, the very condition that gated coming online.
      expect((await clientB.diagnostics()).mutation.quarantinedCount).toBe(0);
    } finally {
      await clientB.stop();
    }
  }, 60_000);
});

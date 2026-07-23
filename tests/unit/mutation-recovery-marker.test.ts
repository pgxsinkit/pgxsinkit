import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable, type SyncTableRegistry } from "@pgxsinkit/contracts";

import { createSyncClient, type SyncClient } from "../../packages/client/src/index";
import { createMutationRuntime, type MutationBatchItem, type MutationDb } from "../../packages/client/src/mutation";
import { memoryStoreForTests } from "../../packages/client/src/testing";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// The DURABLE recovery-required marker. These tests exercise the
// crash matrix by constructing store states directly — boot a REAL filesystem-backed PGlite client, write
// journal rows / craft the `pgxsinkit_local_meta` marker via the raw handle, close (the fs store persists),
// then re-boot on the SAME path and assert the boot's `warmBoot` BootReport outcome. The invariant under
// test: the marker is never `false` while a committed `sending` row exists, so a warm boot only skips
// per-table recovery when the prior session PROVED the journals clear.

const MARKER_KEY = "mutation_recovery_required";

const todos = defineSyncTable({
  tableName: "todos",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    done: boolean("done").notNull(),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
  }),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
  },
});

const notes = defineSyncTable({
  tableName: "notes",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    body: varchar("body", { length: 200 }).notNull(),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
  }),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
  },
});

const todosRegistry = defineSyncRegistry({ todos });
const multiRegistry = defineSyncRegistry({ todos, notes });

// The harness bookkeeping is registry-agnostic; boots are typed as a bare `SyncClient<SyncTableRegistry>` so
// one `openClients` array and one set of raw-handle helpers serve both the single- and multi-table registries.
type LooseClient = SyncClient<SyncTableRegistry>;

// Dead network URLs — boot runs with sync OFF, so nothing is dialled; a stray write POST fails fast
// (connection refused) rather than hanging, which is exactly the "in-flight then interrupted" shape.
const DEAD_ELECTRIC = "http://127.0.0.1:1/v1/electric-proxy";
const DEAD_WRITE = "http://127.0.0.1:1/api/mutations";

const TMP_ROOT = path.resolve(process.cwd(), "tmp/agents/marker");

const openClients: LooseClient[] = [];
const storeDirs: string[] = [];

beforeAll(async () => {
  await mkdir(TMP_ROOT, { recursive: true });
});

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.stop().catch(() => undefined);
  for (const dir of storeDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function freshStorePath(label: string): Promise<string> {
  const dir = path.join(TMP_ROOT, `${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  storeDirs.push(dir);
  // PGlite's NodeFS mkdirs only the leaf store dir, not its parent — create the parent up front.
  await mkdir(dir, { recursive: true });
  return path.join(dir, "store");
}

async function bootFsClient(registry: SyncTableRegistry, storePath: string): Promise<LooseClient> {
  const client = (await createSyncClient({
    registry,
    electricUrl: DEAD_ELECTRIC,
    batchWriteUrl: DEAD_WRITE,
    syncEnabled: false,
    storePath,
  })) as LooseClient;
  openClients.push(client);
  await client.ready;
  return client;
}

async function readMarker(client: LooseClient): Promise<string | null> {
  const result = await client.rawQuery("SELECT value FROM pgxsinkit_local_meta WHERE key = $1", [MARKER_KEY]);
  return (result.rows[0] as { value: string } | undefined)?.value ?? null;
}

async function setMarker(client: LooseClient, value: "true" | "false"): Promise<void> {
  await client.rawExec(
    `INSERT INTO pgxsinkit_local_meta (key, value) VALUES ('${MARKER_KEY}', '${value}') ` +
      `ON CONFLICT (key) DO UPDATE SET value = '${value}';`,
  );
}

async function deleteMarker(client: LooseClient): Promise<void> {
  await client.rawExec(`DELETE FROM pgxsinkit_local_meta WHERE key = '${MARKER_KEY}';`);
}

/** Craft an interrupted-send: enqueue a pending write, then force its journal row to `sending`. */
async function craftSendingRow(client: LooseClient, id: string): Promise<void> {
  await client.mutate.create("todos", { id, title: "in-flight", done: false });
  await client.rawExec(`UPDATE todos_mutations SET status = 'sending' WHERE status = 'pending';`);
}

async function stopClient(client: LooseClient): Promise<void> {
  const index = openClients.indexOf(client);
  if (index >= 0) openClients.splice(index, 1);
  await client.stop();
}

const ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("durable recovery-required marker (slice 2)", () => {
  it("1. clean warm boot (no writes ever): boot-A initializes the marker false, the next boot skips recovery", async () => {
    const storePath = await freshStorePath("clean");

    // Boot A — fresh store: the marker is absent, so one initialization recovery pass runs (finds nothing) and the
    // marker is initialized to `false`.
    const bootA = await bootFsClient(todosRegistry, storePath);
    expect(await readMarker(bootA)).toBe("false");
    const reportA = (await bootA.bootReport())!;
    expect(reportA.warmBoot.journalRecoverySkipped).toBe(false);
    expect(reportA.warmBoot.journalRecoveryRequired).toBe(true);
    await stopClient(bootA);

    // Boot B — warm store, marker `false`: recovery is skipped entirely.
    const bootB = await bootFsClient(todosRegistry, storePath);
    const reportB = (await bootB.bootReport())!;
    expect(reportB.warmBoot.journalRecoverySkipped).toBe(true);
    expect(reportB.warmBoot.journalRecoveryRequired).toBe(false);
    expect(reportB.warmBoot.journalTablesVisited).toBe(0);
    expect(reportB.warmBoot.journalRowsRecovered).toBe(0);
  });

  it("2. boot after a session with SETTLED writes: the post-ack clear left the marker false, so recovery is skipped", async () => {
    const storePath = await freshStorePath("settled");

    const bootA = await bootFsClient(todosRegistry, storePath);
    await bootA.mutate.create("todos", { id: ID_A, title: "will-settle", done: false });
    // Flush drives the row through `sending` (marker → true) then, on the failed dispatch to the dead write
    // endpoint, into `failed`; the post-ack seam runs the self-verifying clear, and with no `sending` row
    // left the marker settles back to `false`.
    await bootA.flush("todos");
    expect((await bootA.diagnostics()).mutation.sendingCount).toBe(0);
    expect(await readMarker(bootA)).toBe("false");
    await stopClient(bootA);

    const bootB = await bootFsClient(todosRegistry, storePath);
    const reportB = (await bootB.bootReport())!;
    expect(reportB.warmBoot.journalRecoverySkipped).toBe(true);
    expect(reportB.warmBoot.journalRecoveryRequired).toBe(false);
  });

  it("3. simulated crash mid-flight (sending row + marker true): boot recovers the row to pending and clears the marker", async () => {
    const storePath = await freshStorePath("crash");

    const bootA = await bootFsClient(todosRegistry, storePath);
    await craftSendingRow(bootA, ID_A);
    await setMarker(bootA, "true");
    await stopClient(bootA);

    const bootB = await bootFsClient(todosRegistry, storePath);
    const reportB = (await bootB.bootReport())!;
    expect(reportB.warmBoot.journalRecoverySkipped).toBe(false);
    expect(reportB.warmBoot.journalRecoveryRequired).toBe(true);
    expect(reportB.warmBoot.journalTablesVisited).toBe(1);
    expect(reportB.warmBoot.journalRowsRecovered).toBeGreaterThanOrEqual(1);

    // The row was lifted back to `pending` and the marker cleared atomically with the recovery updates.
    const diag = (await bootB.diagnostics()).mutation;
    expect(diag.sendingCount).toBe(0);
    expect(diag.pendingCount).toBe(1);
    expect(await readMarker(bootB)).toBe("false");
  });

  it("4. marker true with NO sending rows: recovery runs, finds nothing, and clears the marker", async () => {
    const storePath = await freshStorePath("true-empty");

    const bootA = await bootFsClient(todosRegistry, storePath);
    await setMarker(bootA, "true");
    await stopClient(bootA);

    const bootB = await bootFsClient(todosRegistry, storePath);
    const reportB = (await bootB.bootReport())!;
    expect(reportB.warmBoot.journalRecoverySkipped).toBe(false);
    expect(reportB.warmBoot.journalRecoveryRequired).toBe(true);
    expect(reportB.warmBoot.journalRowsRecovered).toBe(0);
    expect(await readMarker(bootB)).toBe("false");
  });

  it("5. marker ABSENT with a sending row: the initialization pass recovers it and initializes the marker", async () => {
    const storePath = await freshStorePath("unstamped");

    const bootA = await bootFsClient(todosRegistry, storePath);
    await craftSendingRow(bootA, ID_A);
    // Simulate a store whose marker initialization did not complete: no marker row at all.
    await deleteMarker(bootA);
    expect(await readMarker(bootA)).toBeNull();
    await stopClient(bootA);

    const bootB = await bootFsClient(todosRegistry, storePath);
    const reportB = (await bootB.bootReport())!;
    expect(reportB.warmBoot.journalRecoverySkipped).toBe(false);
    expect(reportB.warmBoot.journalRecoveryRequired).toBe(true);
    // The initialization pass is uncounted (rowsRecovered stays null), but it must have run.
    expect(reportB.warmBoot.journalRowsRecovered).toBeNull();

    const diag = (await bootB.diagnostics()).mutation;
    expect(diag.sendingCount).toBe(0);
    expect(diag.pendingCount).toBe(1);
    // The marker is now initialized so the NEXT boot skips.
    expect(await readMarker(bootB)).toBe("false");
  });

  it("6. multiple writable tables with sending rows in several: all recovered under ONE marker", async () => {
    const storePath = await freshStorePath("multi");

    const bootA = await bootFsClient(multiRegistry, storePath);
    await bootA.mutate.create("todos", { id: ID_A, title: "t", done: false });
    await bootA.mutate.create("notes", { id: ID_B, body: "n" });
    await bootA.rawExec(`UPDATE todos_mutations SET status = 'sending' WHERE status = 'pending';`);
    await bootA.rawExec(`UPDATE notes_mutations SET status = 'sending' WHERE status = 'pending';`);
    await setMarker(bootA, "true");
    await stopClient(bootA);

    const bootB = await bootFsClient(multiRegistry, storePath);
    const reportB = (await bootB.bootReport())!;
    expect(reportB.warmBoot.journalRecoverySkipped).toBe(false);
    expect(reportB.warmBoot.journalTablesVisited).toBe(2);
    expect(reportB.warmBoot.journalRowsRecovered).toBe(2);

    const todosSending = await bootB.rawQuery(
      "SELECT count(*)::int AS n FROM todos_mutations WHERE status = 'sending'",
    );
    const notesSending = await bootB.rawQuery(
      "SELECT count(*)::int AS n FROM notes_mutations WHERE status = 'sending'",
    );
    expect((todosSending.rows[0] as { n: number }).n).toBe(0);
    expect((notesSending.rows[0] as { n: number }).n).toBe(0);
    expect(await readMarker(bootB)).toBe("false");
  });

  it("7. restore boot with a clean (false) marker in the backup still quarantines recovered rows", async () => {
    // Build a backup whose journal carries an interrupted (`sending`) write AND a clean `false` marker.
    const source = await bootFsClient(todosRegistry, await freshStorePath("restore-src"));
    await craftSendingRow(source, ID_A);
    await setMarker(source, "false");
    const { file } = await source.exportStore();
    await stopClient(source);

    // Restore into a FRESH memory store: the marker is ignored, so quarantine still runs — the recovered
    // `sending` row ends `quarantined`, not auto-flushable.
    const restored = (await createSyncClient({
      registry: todosRegistry,
      electricUrl: DEAD_ELECTRIC,
      batchWriteUrl: DEAD_WRITE,
      syncEnabled: false,
      restoreFrom: file,
      ...memoryStoreForTests("marker-restore-dst"),
    })) as LooseClient;
    openClients.push(restored);
    await restored.ready;

    const report = (await restored.bootReport())!;
    expect(report.storeKind).toBe("restored");

    const diag = (await restored.diagnostics()).mutation;
    expect(diag.quarantinedCount).toBeGreaterThanOrEqual(1);
    expect(diag.sendingCount).toBe(0);
    expect(diag.pendingCount).toBe(0);
    expect(diag.failedCount).toBe(0);
  });

  it("8. recovery FAILURE leaves the marker true (mid-transaction throw → rollback, no clear)", async () => {
    // A fake `MutationDb` seam: the marker read reports `true`, but the first per-table recovery UPDATE
    // throws inside the recovery transaction. The transaction rolls back and `runBootRecovery` rejects, so
    // the self-verifying clear never runs — the durable marker is left `true` for the next boot to retry.
    const issued: string[] = [];
    const fakeDb: MutationDb = {
      exec: async (sql: string) => {
        issued.push(sql);
        return undefined;
      },
      query: async <TRow extends Record<string, unknown>>(sql: string) => {
        issued.push(sql);
        const lower = sql.toLowerCase();
        if (lower.includes("pgxsinkit_local_meta") && lower.startsWith("select")) {
          return { rows: [{ value: "true" }] as unknown as TRow[] } as { rows: TRow[] };
        }
        if (lower.includes("todos_mutations") && lower.includes("update")) {
          throw new Error("injected recovery failure");
        }
        return { rows: [] as TRow[] };
      },
    };

    const runtime = createMutationRuntime({
      db: fakeDb,
      registry: todosRegistry,
      batchWriteUrl: DEAD_WRITE,
    });

    // oxlint-disable-next-line typescript/await-thenable -- .rejects returns a real promise typed as void
    await expect(runtime.runBootRecovery({ ownsMetaTable: true, restore: false })).rejects.toThrow(
      /injected recovery failure/,
    );

    // The transaction rolled back and the marker was never written `false` (no clear/update against the
    // marker key) — it stays `true`.
    expect(issued).toContain("ROLLBACK");
    const clearedMarker = issued.some(
      (sql) => sql.toLowerCase().includes("pgxsinkit_local_meta") && sql.toLowerCase().includes("update"),
    );
    expect(clearedMarker).toBe(false);
  });

  // FIX 1 — the concurrent-`flushUnit` marker race. Two pessimistic units run on ONE runtime: unit B enters
  // its mark-sending span (bumping the in-flight counter) and pauses BEFORE its `sending` UPDATE commits;
  // unit A then settles and MUST skip the guarded clear (B's span is open), so the durable marker stays
  // `"true"`. A crash after B commits `sending` is then recovered on the next boot. A wrapping `MutationDb`
  // pauses exactly B's `sending` UPDATE (deterministic — no sleeps); a fetch stub acks A and hangs B.
  it("14. two concurrent flushUnits: A's settle does NOT clear the marker while B's sending commit is in flight", async () => {
    const storePath = await freshStorePath("race");
    // Provision the fs store (schema + a clean `false` marker), then drive the race over its raw PGlite.
    const provisioner = await bootFsClient(todosRegistry, storePath);
    const rawPglite = provisioner.pglite;

    const unitA = "11111111-1111-1111-1111-111111111111";
    const unitB = "22222222-2222-2222-2222-222222222222";

    // Wrapping db: forward everything to the real store, but pause the FIRST `sending`-marking UPDATE (unit B
    // is kicked first, so its UPDATE hits the wrapper first) until released — with B's span already open.
    let sendingUpdateCount = 0;
    const bReachedSending = deferred();
    const bSendingGate = deferred();
    const bSendingCommitted = deferred();
    const wrappingDb: MutationDb = {
      exec: (sql) => rawPglite.exec(sql),
      query: async <TRow extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => {
        const marksSending =
          /update/i.test(sql) &&
          /_mutations/i.test(sql) &&
          Array.isArray(params) &&
          params.some((param) => param === "sending");
        if (marksSending) {
          sendingUpdateCount += 1;
          if (sendingUpdateCount === 1) {
            bReachedSending.resolve();
            await bSendingGate.promise;
            const result = await rawPglite.query<TRow>(sql, params);
            bSendingCommitted.resolve();
            return result;
          }
        }
        return rawPglite.query<TRow>(sql, params);
      },
    };

    const runtime = createMutationRuntime({
      db: wrappingDb,
      registry: todosRegistry,
      batchWriteUrl: DEAD_WRITE,
      ownsMetaTable: true,
    });

    // Enqueue two independent pessimistic units.
    const item = (id: string): MutationBatchItem<typeof todosRegistry> =>
      ({ table: "todos", kind: "create", input: { id, title: "race", done: false } }) as MutationBatchItem<
        typeof todosRegistry
      >;
    await runtime.batch([item(ID_A)], { id: unitA, mode: "pessimistic" });
    await runtime.batch([item(ID_B)], { id: unitB, mode: "pessimistic" });

    const originalFetch = globalThis.fetch;
    // A acks; B hangs (its request never returns → it is interrupted after committing `sending` = the crash).
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        writeUnit: string;
        mutations: { mutationId: string }[];
      };
      if (body.writeUnit === unitB) return new Promise<Response>(() => {});
      const acks = body.mutations.map((m) => ({ mutationId: m.mutationId, status: "acked", serverUpdatedAtUs: "1" }));
      return new Response(JSON.stringify({ acks }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      // Kick B → it writes the marker `true`, opens its mark-sending span (counter++), and pauses at its
      // `sending` UPDATE. It will hang on its fetch, so never await it.
      const pB = runtime.flushUnit(unitB);
      void pB.catch(() => undefined);
      await bReachedSending.promise;

      // A runs to completion: marks `sending` (marker already `true` → no re-write), acks, then attempts the
      // guarded clear — which MUST be SKIPPED because B's span is still open.
      await runtime.flushUnit(unitA);

      const markerAfterA = await rawPglite.query<{ value: string }>(
        "SELECT value FROM pgxsinkit_local_meta WHERE key = $1",
        [MARKER_KEY],
      );
      expect(markerAfterA.rows[0]?.value).toBe("true");

      // Release B's `sending` UPDATE → it commits. Its fetch then hangs (the interruption point).
      bSendingGate.resolve();
      await bSendingCommitted.promise;

      // A committed `sending` row now coexists with the marker `true` — the invariant held.
      const sendingRows = await rawPglite.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM todos_mutations WHERE status = 'sending'",
      );
      expect(sendingRows.rows[0]?.n).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Crash: close the store with B's row durably `sending` and the marker `true`.
    await stopClient(provisioner);

    // Reboot → recovery is NOT skipped (marker `true`), and B's stranded `sending` row is lifted to `pending`.
    const reboot = await bootFsClient(todosRegistry, storePath);
    const report = (await reboot.bootReport())!;
    expect(report.warmBoot.journalRecoverySkipped).toBe(false);
    expect(report.warmBoot.journalRecoveryRequired).toBe(true);
    const diag = (await reboot.diagnostics()).mutation;
    expect(diag.sendingCount).toBe(0);
    expect(diag.pendingCount).toBeGreaterThanOrEqual(1);
  });

  it("15. companion: once BOTH concurrent flushUnits settle, the last clear leaves the marker false", async () => {
    const storePath = await freshStorePath("race-settled");
    const provisioner = await bootFsClient(todosRegistry, storePath);
    const runtime = createMutationRuntime({
      db: {
        exec: (sql) => provisioner.pglite.exec(sql),
        query: (sql, params) => provisioner.pglite.query(sql, params),
      },
      registry: todosRegistry,
      batchWriteUrl: DEAD_WRITE,
      ownsMetaTable: true,
    });

    const unitA = "33333333-3333-3333-3333-333333333333";
    const unitB = "44444444-4444-4444-4444-444444444444";
    const item = (id: string): MutationBatchItem<typeof todosRegistry> =>
      ({ table: "todos", kind: "create", input: { id, title: "settle", done: false } }) as MutationBatchItem<
        typeof todosRegistry
      >;
    await runtime.batch([item(ID_A)], { id: unitA, mode: "pessimistic" });
    await runtime.batch([item(ID_B)], { id: unitB, mode: "pessimistic" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { mutations: { mutationId: string }[] };
      const acks = body.mutations.map((m) => ({ mutationId: m.mutationId, status: "acked", serverUpdatedAtUs: "1" }));
      return new Response(JSON.stringify({ acks }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      // Both settle (concurrently); the last unit to close its span sees the counter at 0 and clears.
      await Promise.all([runtime.flushUnit(unitA), runtime.flushUnit(unitB)]);
      const marker = await provisioner.pglite.query<{ value: string }>(
        "SELECT value FROM pgxsinkit_local_meta WHERE key = $1",
        [MARKER_KEY],
      );
      expect(marker.rows[0]?.value).toBe("false");
      const sending = await provisioner.pglite.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM todos_mutations WHERE status = 'sending'",
      );
      expect(sending.rows[0]?.n).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // FIX 4 — an unexpected durable marker value must fail CLOSED (recovery runs), not be decoded as clean.
  it("16. a malformed marker value fails closed: recovery runs and rewrites a well-formed marker", async () => {
    const storePath = await freshStorePath("malformed-marker");
    const bootA = await bootFsClient(todosRegistry, storePath);
    // Corrupt the durable marker directly (a partial edit / future encoding / stray value).
    await bootA.rawExec(
      `INSERT INTO pgxsinkit_local_meta (key, value) VALUES ('${MARKER_KEY}', 'garbage') ` +
        `ON CONFLICT (key) DO UPDATE SET value = 'garbage';`,
    );
    expect(await readMarker(bootA)).toBe("garbage");
    await stopClient(bootA);

    // Reboot: `false` is the ONLY value that skips recovery, so anything else must run recovery (fail closed).
    const bootB = await bootFsClient(todosRegistry, storePath);
    const report = (await bootB.bootReport())!;
    expect(report.warmBoot.journalRecoverySkipped).toBe(false);
    // The marker is well-formed after the pass (no `sending` row remained → the clear settled it to `false`).
    const markerAfter = await readMarker(bootB);
    expect(markerAfter === "true" || markerAfter === "false").toBe(true);
    expect(markerAfter).toBe("false");
  });

  // FIX 1b — a sender racing an IN-FLIGHT clear. The clear resets the epoch-dirty flag SYNCHRONOUSLY before
  // issuing its UPDATE, so a sender that enters mid-clear reads `dirty === false` and REWRITES the marker
  // `true` (rather than skipping on a stale flag and committing `sending` under a `false` marker). Deterministic
  // via the wrapping-db seam: pause the clear's `UPDATE ... pgxsinkit_local_meta` statement mid-flight.
  it("17. a sender that enters while the clear is in flight rewrites the marker true (no stale-flag skip)", async () => {
    const storePath = await freshStorePath("clear-race");
    const provisioner = await bootFsClient(todosRegistry, storePath);
    const rawPglite = provisioner.pglite;

    const unitA = "55555555-5555-5555-5555-555555555555";
    const unitB = "66666666-6666-6666-6666-666666666666";

    const clearReached = deferred();
    const clearGate = deferred();
    const bSendingCommitted = deferred();
    // A's own `sending` UPDATE fires before the clear; only watch for B's (armed after the clear is reached).
    let watchBSending = false;
    let markerTrueUpserts = 0;
    const wrappingDb: MutationDb = {
      exec: (sql) => rawPglite.exec(sql),
      query: async <TRow extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => {
        const lower = sql.toLowerCase();
        const onMeta = lower.includes("pgxsinkit_local_meta");
        const p = Array.isArray(params) ? params : [];
        // The guarded CLEAR: `UPDATE pgxsinkit_local_meta SET value='false' WHERE key=… AND NOT EXISTS…`.
        if (onMeta && /\bupdate\b/.test(lower) && p.some((x) => x === "false")) {
          clearReached.resolve();
          await clearGate.promise;
          return rawPglite.query<TRow>(sql, params);
        }
        // A marker upsert to `true` (a sender's `ensureRecoveryMarker`) — the thing a stale-flag skip suppresses.
        if (onMeta && lower.includes("insert") && p.some((x) => x === "true")) {
          markerTrueUpserts += 1;
          return rawPglite.query<TRow>(sql, params);
        }
        // Unit B's `sending` UPDATE committing (the durable row that must survive under the marker `true`).
        if (
          watchBSending &&
          /\bupdate\b/.test(lower) &&
          lower.includes("_mutations") &&
          p.some((x) => x === "sending")
        ) {
          const result = await rawPglite.query<TRow>(sql, params);
          bSendingCommitted.resolve();
          return result;
        }
        return rawPglite.query<TRow>(sql, params);
      },
    };

    const runtime = createMutationRuntime({
      db: wrappingDb,
      registry: todosRegistry,
      batchWriteUrl: DEAD_WRITE,
      ownsMetaTable: true,
    });
    const item = (id: string): MutationBatchItem<typeof todosRegistry> =>
      ({ table: "todos", kind: "create", input: { id, title: "clear-race", done: false } }) as MutationBatchItem<
        typeof todosRegistry
      >;
    await runtime.batch([item(ID_A)], { id: unitA, mode: "pessimistic" });
    await runtime.batch([item(ID_B)], { id: unitB, mode: "pessimistic" });

    const originalFetch = globalThis.fetch;
    // A acks (so it reaches its settle → the paused clear); B hangs after committing `sending` (the crash).
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        writeUnit: string;
        mutations: { mutationId: string }[];
      };
      if (body.writeUnit === unitB) return new Promise<Response>(() => {});
      const acks = body.mutations.map((m) => ({ mutationId: m.mutationId, status: "acked", serverUpdatedAtUs: "1" }));
      return new Response(JSON.stringify({ acks }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      // A runs to completion → its settle resets the dirty flag (sync) and issues the clear, which the wrapper
      // pauses IN FLIGHT.
      const pA = runtime.flushUnit(unitA);
      void pA.catch(() => undefined);
      await clearReached.promise;
      const upsertsBeforeB = markerTrueUpserts;
      watchBSending = true;

      // A new sender B enters while the clear is paused: it reads `dirty === false` and REWRITES the marker
      // `true` (the fix — the old code left the flag stale-true and B would SKIP this upsert), then commits its
      // `sending` row and hangs on its fetch.
      const pB = runtime.flushUnit(unitB);
      void pB.catch(() => undefined);
      await bSendingCommitted.promise;
      expect(markerTrueUpserts).toBeGreaterThan(upsertsBeforeB);

      // Release the clear: its guard now sees B's committed `sending` row, so it is a no-op — the marker stays
      // durably `true`.
      clearGate.resolve();
      await pA;

      const marker = await rawPglite.query<{ value: string }>("SELECT value FROM pgxsinkit_local_meta WHERE key = $1", [
        MARKER_KEY,
      ]);
      expect(marker.rows[0]?.value).toBe("true");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Crash with B's row durably `sending` and the marker `true` → reboot recovers it.
    await stopClient(provisioner);
    const reboot = await bootFsClient(todosRegistry, storePath);
    const report = (await reboot.bootReport())!;
    expect(report.warmBoot.journalRecoverySkipped).toBe(false);
    const diag = (await reboot.diagnostics()).mutation;
    expect(diag.sendingCount).toBe(0);
    expect(diag.pendingCount).toBeGreaterThanOrEqual(1);
  });

  // FIX 1b companion — a guard-BLOCKED clear (a committed `sending` row from a still-in-HTTP unit) leaves the
  // flag pessimistically `false`, so the next sender writes a redundant `true`. The marker never goes `false`.
  it("18. a guard-blocked clear keeps the marker true and leaves the flag false (next sender re-writes true)", async () => {
    const storePath = await freshStorePath("guard-blocked");
    const provisioner = await bootFsClient(todosRegistry, storePath);
    const rawPglite = provisioner.pglite;

    const unitA = "77777777-7777-7777-7777-777777777777";
    const unitB = "88888888-8888-8888-8888-888888888888";
    const unitC = "99999999-9999-9999-9999-999999999999";

    let markerTrueUpserts = 0;
    let onNextMarkerTrueUpsert: (() => void) | null = null;
    const aSendingCommitted = deferred();
    const wrappingDb: MutationDb = {
      exec: (sql) => rawPglite.exec(sql),
      query: async <TRow extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => {
        const lower = sql.toLowerCase();
        const p = Array.isArray(params) ? params : [];
        if (lower.includes("pgxsinkit_local_meta") && lower.includes("insert") && p.some((x) => x === "true")) {
          markerTrueUpserts += 1;
          const notify = onNextMarkerTrueUpsert;
          onNextMarkerTrueUpsert = null;
          notify?.();
        }
        if (/\bupdate\b/.test(lower) && lower.includes("todos_mutations") && p.some((x) => x === "sending")) {
          const result = await rawPglite.query<TRow>(sql, params);
          aSendingCommitted.resolve();
          return result;
        }
        return rawPglite.query<TRow>(sql, params);
      },
    };
    const runtime = createMutationRuntime({
      db: wrappingDb,
      registry: todosRegistry,
      batchWriteUrl: DEAD_WRITE,
      ownsMetaTable: true,
    });
    const item = (id: string): MutationBatchItem<typeof todosRegistry> =>
      ({ table: "todos", kind: "create", input: { id, title: "blocked", done: false } }) as MutationBatchItem<
        typeof todosRegistry
      >;
    await runtime.batch([item(ID_A)], { id: unitA, mode: "pessimistic" });
    await runtime.batch([item(ID_B)], { id: unitB, mode: "pessimistic" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        writeUnit: string;
        mutations: { mutationId: string }[];
      };
      if (body.writeUnit === unitA) return new Promise<Response>(() => {}); // A hangs mid-HTTP with `sending` committed
      const acks = body.mutations.map((m) => ({ mutationId: m.mutationId, status: "acked", serverUpdatedAtUs: "1" }));
      return new Response(JSON.stringify({ acks }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      // A commits `sending` then hangs on its fetch — a durable `sending` row with no settle.
      const pA = runtime.flushUnit(unitA);
      void pA.catch(() => undefined);
      await aSendingCommitted.promise;

      // B flushes to completion → its settle issues the clear, whose guard is BLOCKED by A's `sending` row, so
      // the marker stays `true` and the flag is left `false` (not reset back to `true`).
      await runtime.flushUnit(unitB);
      const markerAfterB = await rawPglite.query<{ value: string }>(
        "SELECT value FROM pgxsinkit_local_meta WHERE key = $1",
        [MARKER_KEY],
      );
      expect(markerAfterB.rows[0]?.value).toBe("true");

      // The flag being `false` is observable: the NEXT sender writes a redundant `true` (it does not skip).
      const upsertsBeforeC = markerTrueUpserts;
      await runtime.batch([item("cccccccc-cccc-cccc-cccc-cccccccccccc")], { id: unitC, mode: "pessimistic" });
      const cUpsertObserved = deferred();
      onNextMarkerTrueUpsert = cUpsertObserved.resolve;
      const pC = runtime.flushUnit(unitC);
      void pC.catch(() => undefined);
      await cUpsertObserved.promise;
      expect(markerTrueUpserts).toBeGreaterThan(upsertsBeforeC);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

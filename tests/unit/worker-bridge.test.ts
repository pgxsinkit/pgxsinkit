import { afterEach, describe, expect, it } from "bun:test";
// Protocol-tier bridge test (ADR-0032 S2, decision 8): a REAL in-process engine over an in-memory PGlite
// behind `defineSyncWorker`, driven by `attachSyncClient` across a bun `MessageChannel` — NO actual Worker.
// Covers the attach handshake, write RPC round trip (row lands in the worker's PGlite), the live-query DIFF
// bridge (initial snapshot → diff-only updates, tab-side identity preservation, unsubscribe), and event
// fanout to two ports.

import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";
import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import {
  attachSyncRegistryStorage,
  defineSyncRegistry,
  defineSyncTable,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  type BridgeEnvelope,
  type BridgePort,
  type ClientPGlite,
  defineSyncWorker,
  ExecutionLimitMismatchError,
  getReadModelView,
  getSyncedLocalTable,
  identityCodec,
  isBridgeEnvelope,
  provisionSyncWorker,
  type SyncWorkerHost,
} from "../../packages/client/src/index";
import { memoryStoreForTests, testStoreAcknowledgment } from "../../packages/client/src/testing";
import { PLACEMENT_RESULT_KEY } from "../../packages/client/src/worker/define-sync-worker";
import { drizzleOver } from "../support/drizzle";

const todosRegistry = defineSyncRegistry({
  todos: defineSyncTable({
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
  }),
  // A `lazy` relation so the bridge tests can assert the worker's guard reports the activated keys back
  // on `live-initial` (`lazyTables`, observability). The tab's `hydrating` source is `hydratingTables` —
  // the pending consistency groups — exercised against a not-ready group in `worker-live-hydration.test.ts`.
  archive: defineSyncTable({
    tableName: "archive",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      label: varchar("label", { length: 200 }).notNull(),
    }),
    mode: "readonly",
    subscription: "lazy",
  }),
});
type TodosRegistry = typeof todosRegistry;

// A registry that DECLARES `backend: "idbfs"` (ADR-0049 D1) — the one opt-out that forces the in-SharedWorker
// engine home with NO placement probe. Used where a test needs a deterministic `shared-worker` home (e.g. the
// executionLimit-on-SW-direct rejection) without a real OPFS probe deciding the home.
const idbfsTodosRegistry = attachSyncRegistryStorage(todosRegistry, { backend: "idbfs" });

// `SyncTableRegistry` is referenced for the cross-check that the concretely-typed registry is assignable.
const _registryTypeCheck: SyncTableRegistry = todosRegistry as unknown as SyncTableRegistry;
void _registryTypeCheck;
const readModel = getReadModelView(todosRegistry, "todos");

let hosts: SyncWorkerHost<TodosRegistry>[] = [];
let channels: MessageChannel[] = [];

// Boot the worker over a PREPOPULATED memory PGlite (skips the ~2s initdb) handed in as `precreatedPglite`
// — the client still applies schema + reconcile, exactly the `storePath` path a browser worker would take.
async function makeHost(executionLimit?: { maxDispatchMs?: number }): Promise<SyncWorkerHost<TodosRegistry>> {
  const pg = await PGlite.create({ loadDataDir: await prepopulatedDataDir(), extensions: { live } });
  const host = defineSyncWorker({
    registry: todosRegistry,
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    // The precreated store is a prepopulated MEMORY PGlite (test only) — acknowledge it past the BYO
    // refusal the worker's `createSyncClient` boot would otherwise raise (ADR-0036).
    ...testStoreAcknowledgment(),
    precreatedPglite: Promise.resolve(pg as unknown as ClientPGlite),
    syncEnabled: false,
    installGlobal: false,
    convergenceIntervalMs: 10_000_000, // never fire the interval during a test
    ...(executionLimit ? { executionLimit } : {}),
  });
  hosts.push(host);
  return host;
}

/** Attach a tab client to `host` over a fresh channel, plus a raw envelope spy on the tab port. */
async function attach(
  host: SyncWorkerHost<TodosRegistry>,
  token = { accessToken: "t", expiresAt: Date.now() + 3_600_000 },
  executionLimit?: { maxDispatchMs?: number },
) {
  const channel = new MessageChannel();
  channels.push(channel);
  host.connect(channel.port1 as unknown as never);
  const seen: BridgeEnvelope[] = [];
  channel.port2.addEventListener("message", (event) => {
    if (isBridgeEnvelope((event as MessageEvent).data)) seen.push((event as MessageEvent).data as BridgeEnvelope);
  });
  channel.port2.start?.();
  const client = await attachSyncClient({
    registry: todosRegistry,
    port: channel.port2 as unknown as never,
    getToken: async () => token,
    ...(executionLimit ? { executionLimit } : {}),
  });
  return { client, seen };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(async () => {
  for (const host of hosts) await host.close().catch(() => undefined);
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  hosts = [];
  channels = [];
});

describe("memory-override store over the bridge (ADR-0036)", () => {
  it("provision + attach with a memory-override store boots the DEFAULT createPglite path end-to-end", async () => {
    // No injected `precreatedPglite`/`createPglite`: the worker uses its DEFAULT `createClientPGlite`, so the
    // memory backend is selected only because the testing marker travels as the explicit `testStoreBackend`
    // wire field (a symbol does not survive structured clone) → `createClientPGlite(storePath, "memory")`.
    const host = defineSyncWorker({
      registry: todosRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
    });
    hosts.push(host);

    const channel = new MessageChannel();
    channels.push(channel);
    host.connect(channel.port1 as unknown as never);
    channel.port2.start?.();

    // Provision (mints the memory store off-thread) then attach (adopts it) — both carry the memory override.
    await provisionSyncWorker({ port: channel.port2 as unknown as never, ...memoryStoreForTests("bridge-memory") });
    const client = await attachSyncClient({
      registry: todosRegistry,
      port: channel.port2 as unknown as never,
      ...memoryStoreForTests("bridge-memory"),
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    await client.ready;

    // A write lands in the worker's real (memory) store — the whole default path booted on the override.
    await client.tables.todos.create({ id: "f1000000-0000-0000-0000-000000000000", title: "mem", done: false });
    const workerClient = await host.whenBooted();
    const rows = await drizzleOver(workerClient.pglite as unknown as PGlite)
      .select({ id: readModel.id, title: readModel.title })
      .from(readModel);
    expect(rows).toEqual([{ id: "f1000000-0000-0000-0000-000000000000", title: "mem" }]);
  });
});

describe("app-schema prepare hooks run IN THE WORKER (consumer app-level schema)", () => {
  it("forwards both hooks around the registry schema exec, and app DDL is queryable afterwards", async () => {
    // The hooks are worker-ENTRY options (functions cannot cross the bridge), so a consumer bakes them into
    // the worker file — proven here by asserting they run against the WORKER engine's own store, ordered
    // around the registry schema exec exactly as the in-process client. The `precreatedPglite` path runs
    // schema/prepare/reconcile (unlike `pgliteInstance`), so the hooks fire.
    const calls: string[] = [];
    let syncedTableBeforeSchema: string | null = "unset";
    let syncedTableAfterSchema: string | null = "unset";

    const pg = await PGlite.create({ loadDataDir: await prepopulatedDataDir(), extensions: { live } });
    const host = defineSyncWorker({
      registry: todosRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      ...testStoreAcknowledgment(),
      precreatedPglite: Promise.resolve(pg as unknown as ClientPGlite),
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
      prepareLocalDbBeforeSchema: async (pglite) => {
        calls.push("before");
        // Registry-derived local table `todos` does NOT exist yet at this point.
        const probe = await pglite.query<{ reg: string | null }>("select to_regclass('public.todos')::text as reg");
        syncedTableBeforeSchema = probe.rows[0]?.reg ?? null;
        // App-level DDL that must precede the registry tables — assert it survives to the attached client.
        await pglite.exec("create table app_notes (id int primary key, note text not null)");
        await pglite.exec("insert into app_notes (id, note) values (1, 'boot note')");
      },
      prepareLocalDbAfterSchema: async (pglite) => {
        calls.push("after");
        // By now the registry schema exec has run, so the synced local table `todos` exists.
        const probe = await pglite.query<{ reg: string | null }>("select to_regclass('public.todos')::text as reg");
        syncedTableAfterSchema = probe.rows[0]?.reg ?? null;
      },
    });
    hosts.push(host);

    const { client } = await attach(host);
    await client.ready;

    // (a) both hooks invoked, in the before → after order.
    expect(calls).toEqual(["before", "after"]);
    // (b) ordering — registry local tables absent in the before hook, present in the after hook.
    expect(syncedTableBeforeSchema).toBeNull();
    expect(syncedTableAfterSchema).toContain("todos");
    // (c) app DDL created in the before hook is queryable through the attached client afterwards.
    const notes = await client.rawQuery("select note from app_notes where id = $1", [1]);
    expect((notes.rows[0] as { note?: string })?.note).toBe("boot note");
  });
});

describe("attach handshake (ADR-0032 decision 4)", () => {
  it("rejects executionLimit on SharedWorker-direct placement before boot", async () => {
    const savedScope = Object.getOwnPropertyDescriptor(globalThis, "SharedWorkerGlobalScope");
    const savedOnConnect = Object.getOwnPropertyDescriptor(globalThis, "onconnect");
    Object.defineProperty(globalThis, "SharedWorkerGlobalScope", { configurable: true, value: class {} });
    let createCalled = false;
    try {
      const host = defineSyncWorker({
        // Declared `backend: "idbfs"` → no probe, deterministic `shared-worker` engine home (ADR-0049 D1), which is
        // exactly where executionLimit is unsupported and must be rejected before boot.
        registry: idbfsTodosRegistry,
        electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
        batchWriteUrl: "http://127.0.0.1:1/api/mutations",
        executionLimit: { maxDispatchMs: 1_000 },
        createPglite: async () => {
          createCalled = true;
          throw new Error("must not boot");
        },
      });
      hosts.push(host);
      await Promise.resolve();

      const channel = new MessageChannel();
      channels.push(channel);
      const onconnect = (globalThis as { onconnect?: (event: { ports: BridgePort[] }) => void }).onconnect;
      onconnect?.({ ports: [channel.port1 as unknown as BridgePort] });
      let placementReplies = 0;
      channel.port2.addEventListener("message", (event) => {
        const data = event.data as Record<string, unknown> | null;
        if (data?.[PLACEMENT_RESULT_KEY] !== undefined) placementReplies += 1;
      });
      channel.port2.start();

      // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a promise typed as void
      await expect(
        attachSyncClient({
          registry: todosRegistry,
          port: channel.port2 as unknown as never,
          executionLimit: { maxDispatchMs: 1_000 },
        }),
      ).rejects.toThrow("unsupported for SharedWorker-direct placement");
      // One authority owns placement on a bootstrapped SW-direct port. A second host-level reply carries a
      // different identity and can make retirement send a stale teardown that the bootstrap correctly ignores.
      expect(placementReplies).toBe(1);
      expect(createCalled).toBe(false);
    } finally {
      if (savedScope === undefined)
        delete (globalThis as { SharedWorkerGlobalScope?: unknown }).SharedWorkerGlobalScope;
      else Object.defineProperty(globalThis, "SharedWorkerGlobalScope", savedScope);
      if (savedOnConnect === undefined) delete (globalThis as { onconnect?: unknown }).onconnect;
      else Object.defineProperty(globalThis, "onconnect", savedOnConnect);
    }
  });

  it("requires every tab to carry the engine's execution-limit construction value", async () => {
    const host = await makeHost({ maxDispatchMs: 1_000 });
    const first = await attach(host, undefined, { maxDispatchMs: 1_000 });
    await first.client.localReadReady;
    const matching = await attach(host, undefined, { maxDispatchMs: 1_000 });
    await matching.client.localReadReady;

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a promise typed as void
    await expect(attach(host, undefined, { maxDispatchMs: 2_000 })).rejects.toBeInstanceOf(ExecutionLimitMismatchError);
  });

  it("boots on the first attach and reports alreadyBooted on the second", async () => {
    const host = await makeHost();
    const { seen: seenA, client: clientA } = await attach(host);
    await clientA.ready;
    const ackA = seenA.find((e) => e.type === "attach-ack");
    expect(identityCodec.decode(ackA!.payload)).toEqual({ alreadyBooted: false });

    const { seen: seenB, client: clientB } = await attach(host);
    await clientB.ready;
    const ackB = seenB.find((e) => e.type === "attach-ack");
    // The engine's monotonic `ready` had already fired (clientA awaited it) before the second attach, so the
    // late ack also carries `engineReady: true` — the seam that resolves a late tab's `ready` from the ack
    // even if the engine's phase later degrades (ADR-0032 FIX 3). It ALSO folds the background boot milestones
    // (ADR-0041 stage 2): the engine already crossed `writeReady`/`bootSettled` before this late attach, so the
    // ack settles those stages straight away rather than waiting for a broadcast this tab missed.
    expect(identityCodec.decode(ackB!.payload)).toEqual({
      alreadyBooted: true,
      engineReady: true,
      writeReady: true,
      bootSettled: true,
    });
  });
});

describe("boot failure rejects the attach (ADR-0032 FIX 1)", () => {
  it("rejects attachSyncClient with the boot error, and a second attach retries the boot", async () => {
    // A poisoned `pgliteInstance` whose every access throws forces `createSyncClient` (hence the worker's
    // boot) to reject deterministically. Each real boot attempt touches the store, so the hit counter grows
    // once per boot — the seam that distinguishes a genuine RETRY from a replayed cached rejection.
    let poisonHits = 0;
    const poison = new Proxy(
      {},
      {
        get: () => {
          poisonHits++;
          throw new Error("boot poison: pglite unavailable");
        },
        set: () => {
          poisonHits++;
          throw new Error("boot poison: pglite unavailable");
        },
      },
    ) as unknown as ClientPGlite;

    const host = defineSyncWorker({
      registry: todosRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      pgliteInstance: poison,
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
    });
    hosts.push(host);

    // try/catch rather than `expect().rejects` — a `MessageChannel`-driven rejection (the boot-failure ack)
    // does not settle a bun `expect(...).rejects` matcher here, but a plain await/catch observes it.
    const attemptAttach = async (channel: MessageChannel): Promise<string> => {
      host.connect(channel.port1 as unknown as never);
      try {
        await attachSyncClient({
          registry: todosRegistry,
          port: channel.port2 as unknown as never,
          getToken: async () => null,
        });
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    };

    const channel1 = new MessageChannel();
    channels.push(channel1);
    expect(await attemptAttach(channel1)).toContain("boot poison");
    const afterFirst = poisonHits;
    expect(afterFirst).toBeGreaterThan(0);

    // The worker cleared `bootPromise` on the failure, so a SECOND attach re-attempts the boot (touching the
    // poisoned store again) rather than replaying the cached first rejection.
    const channel2 = new MessageChannel();
    channels.push(channel2);
    expect(await attemptAttach(channel2)).toContain("boot poison");
    expect(poisonHits).toBeGreaterThan(afterFirst);
  });

  it("preserves the boot error's name across the bridge (typed-refusal detection, e.g. RestoreTargetExistsError)", async () => {
    // A consumer distinguishes a benign restore refusal (RestoreTargetExistsError → fall back to a plain
    // attach) from a genuine restore failure (fail the boot) by the error's NAME. The bridge's serialized
    // error must therefore carry `name`, not just `message` — otherwise every worker-mode boot failure
    // rebuilds as a bare `Error` and the consumer is forced into message matching.
    const refusal = new Error("store already exists at the restore target");
    refusal.name = "RestoreTargetExistsError";
    const poison = new Proxy(
      {},
      {
        get: () => {
          throw refusal;
        },
        set: () => {
          throw refusal;
        },
      },
    ) as unknown as ClientPGlite;

    const host = defineSyncWorker({
      registry: todosRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      pgliteInstance: poison,
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
    });
    hosts.push(host);

    const channel = new MessageChannel();
    channels.push(channel);
    host.connect(channel.port1 as unknown as never);
    // try/catch rather than `expect().rejects` — a MessageChannel-driven rejection does not settle a bun
    // `expect(...).rejects` matcher here, but a plain await/catch observes it.
    let caught: Error | undefined;
    try {
      await attachSyncClient({
        registry: todosRegistry,
        port: channel.port2 as unknown as never,
        getToken: async () => null,
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toContain("store already exists");
    expect(caught?.name).toBe("RestoreTargetExistsError");
  });
});

describe("write RPC round trip (ADR-0032 decision 4)", () => {
  it("a create via the attach client lands in the worker's PGlite and resolves", async () => {
    const host = await makeHost();
    const { client } = await attach(host);
    await client.ready;

    await client.tables.todos.create({ id: "11111111-1111-1111-1111-111111111111", title: "buy milk", done: false });

    // Read the WORKER-side store directly through its booted in-process client.
    const workerClient = await host.whenBooted();
    const rows = await drizzleOver(workerClient.pglite as unknown as PGlite)
      .select({ id: readModel.id, title: readModel.title })
      .from(readModel);
    expect(rows).toEqual([{ id: "11111111-1111-1111-1111-111111111111", title: "buy milk" }]);
  });
});

describe("blind pessimistic update across the bridge (ADR-0022 addendum)", () => {
  it("a transaction updateBlind crosses the transaction RPC, acks, and retires the journal", async () => {
    const host = await makeHost();
    const { client } = await attach(host);
    await client.ready;

    // The authoritative /api/mutations/unit endpoint acks every member — the worker's in-process flushUnit runs
    // in THIS process, so the global fetch stub applies to it across the MessageChannel bridge.
    const original = globalThis.fetch;
    const fetchMock = (async (_input: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        mutations: Array<{
          mutationId: string;
          tableName: string;
          mutationSeq: number;
          entityKey: Record<string, string>;
        }>;
      };
      const acks = body.mutations.map((m) => ({
        tableName: m.tableName,
        entityKey: m.entityKey,
        mutationId: m.mutationId,
        mutationSeq: m.mutationSeq,
        status: "acked" as const,
        serverUpdatedAtUs: "5000",
      }));
      return new Response(JSON.stringify({ acks }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;
    try {
      // The todo is NOT present in the read model (blind target). The pessimistic block resolves with acks.
      const result = await client.transaction({ mode: "pessimistic" }, (tx) => {
        tx.tables.todos.updateBlind({ id: "f0000000-0000-0000-0000-000000000000" }, { title: "moderated" });
      });
      expect(result.acks[0]?.status).toBe("acked");

      // The worker's journal is empty — the acked blind row retired with no synced echo.
      const workerClient = await host.whenBooted();
      const journal = await workerClient.rawQuery("select count(*)::int as c from todos_mutations");
      expect((journal.rows[0] as { c: number }).c).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("pglite misuse trap is reflection-safe (attach client)", () => {
  it("enumeration/spread never trip the trap; a direct read still throws the misuse error", async () => {
    const host = await makeHost();
    const { client } = await attach(host);

    // Host tooling reflects over the client wherever the app hands it around (React dev-build render
    // logging serializes prop diffs property-by-property; console inspection and object spreads do the
    // same). The trap must be invisible to every enumeration path — an enumerable throw-on-get turned
    // passive reflection into a crash (observed under React 19.2 dev with <SyncClientProvider client>).
    expect(Object.keys(client)).not.toContain("pglite");
    expect(() => ({ ...client })).not.toThrow();
    expect(() => {
      for (const key in client) {
        void (client as unknown as Record<string, unknown>)[key];
      }
    }).not.toThrow();

    // The misuse trap itself survives: touching `.pglite` directly still throws, and `in` still reports it.
    expect("pglite" in client).toBe(true);
    expect(() => client.pglite).toThrow(/client\.pglite is not available on a worker-attached client/);
  });
});

describe("raw inspection RPC round trip (ADR-0032 S2)", () => {
  it("rawQuery/rawExec run in the worker and resolve tab-side; a bad statement rejects", async () => {
    const host = await makeHost();
    const { client } = await attach(host);
    await client.ready;

    await client.tables.todos.create({ id: "d0000000-0000-0000-0000-000000000000", title: "inspect me", done: false });

    // A parameterised read of the worker's store, resolved back over the RPC round trip (not `client.pglite`,
    // which is blocked on the attach client). Reads the synced read-model view the write landed in.
    const queried = await client.rawQuery("select title from todos_read_model where id = $1", [
      "d0000000-0000-0000-0000-000000000000",
    ]);
    expect((queried.rows[0] as { title?: string })?.title).toBe("inspect me");

    // Multi-statement exec returns one Results per statement.
    const execed = await client.rawExec("select 1 as a; select 2 as b;");
    expect(execed.length).toBe(2);

    // `rowMode: "array"` crosses the bridge intact — this is exactly what `@electric-sql/pglite-repl`
    // sends on every exec, and its renderer calls `row.map`, so object rows here break every REPL
    // statement. Assert the rows really are arrays on both raw entry points.
    const arrayQueried = await client.rawQuery(
      "select title, done from todos_read_model where id = $1",
      ["d0000000-0000-0000-0000-000000000000"],
      { rowMode: "array" },
    );
    expect(Array.isArray(arrayQueried.rows[0])).toBe(true);
    expect((arrayQueried.rows[0] as unknown[])[0]).toBe("inspect me");
    const arrayExeced = await client.rawExec("select 1 as a, 2 as b;", { rowMode: "array" });
    expect(arrayExeced[0]?.rows[0]).toEqual([1, 2]);

    // A rejection propagates across the bridge. try/catch, not `expect().rejects` — a MessageChannel-driven
    // rejection does not settle the bun matcher here (see the boot-failure test above).
    let rejected = "";
    try {
      await client.rawQuery("select * from a_table_that_does_not_exist");
    } catch (error) {
      rejected = (error as Error).message;
    }
    expect(rejected.length).toBeGreaterThan(0);
  });

  it("discardQuarantined dispatches across the bridge and resolves tab-side", async () => {
    const host = await makeHost();
    const { client } = await attach(host);
    await client.ready;

    // No quarantined row for this entity, so the discard is a no-op — but it must dispatch the RPC to the
    // worker and resolve back tab-side (proving the RpcOp is wired end to end, mirroring the rawQuery path).
    // Awaited directly, NOT via `expect(...).resolves` — a MessageChannel-driven resolution does not settle
    // the bun matcher here (same quirk the rawQuery/boot tests above call out).
    const result = await client.discardQuarantined("todos", { id: "e0000000-0000-0000-0000-000000000000" });
    expect(result).toBeUndefined();
  });
});

describe("desync / discardEphemeral RPC round trip (ADR-0021 + ADR-0032 S2)", () => {
  it("desync dispatches across the bridge and the worker's REAL client answers (not notSupported)", async () => {
    const host = await makeHost();
    const { client } = await attach(host);
    await client.ready;

    // `todos` is eager, so the worker-side desync REFUSES — but that refusal round-trips from the worker's
    // REAL client, proving the RpcOp is wired end to end (before this, the attach method threw notSupported
    // synchronously tab-side). try/catch, not `expect().rejects` — a MessageChannel-driven rejection does not
    // settle the bun matcher here (same quirk the rawQuery/boot tests call out).
    let message = "";
    try {
      await client.desync("todos");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("only a lazy relation");
  });

  it("discardEphemeral dispatches across the bridge and the worker's REAL client answers (not notSupported)", async () => {
    const host = await makeHost();
    const { client } = await attach(host);
    await client.ready;

    // `todos` is eager, so the worker-side discardEphemeral REFUSES — the refusal names discardEphemeral,
    // proving the new RpcOp reached the worker's real client rather than throwing notSupported tab-side.
    let message = "";
    try {
      await client.discardEphemeral("todos");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("discardEphemeral");
  });
});

describe("live-query bridge (ADR-0032 S2 §4)", () => {
  it("sends an initial snapshot then DIFF-only updates, and preserves row identity tab-side", async () => {
    const host = await makeHost();
    const { client, seen } = await attach(host);
    await client.ready;

    // Seed two rows BEFORE subscribing so the initial snapshot carries both (stable order by id).
    await client.tables.todos.create({ id: "a0000000-0000-0000-0000-000000000000", title: "A", done: false });
    await client.tables.todos.create({ id: "b0000000-0000-0000-0000-000000000000", title: "B", done: false });

    const builder = client.drizzle
      .select({ id: readModel.id, title: readModel.title, done: readModel.done })
      .from(readModel)
      .orderBy(readModel.id);
    const { sql, params } = builder.toSQL();

    const emissions: Array<Array<{ id: string; title: string; done: boolean }>> = [];
    const sub = await client.subscribeLiveRows<{ id: string; title: string; done: boolean }>(
      { sql, params, pkColumns: ["id"] },
      (rows) => emissions.push(rows),
    );
    expect(sub.initialRows.map((r) => r.title)).toEqual(["A", "B"]);
    const initialRows = sub.initialRows;

    // Update B → expect a live-diff (not a re-sent snapshot) carrying only the changed row.
    await client.tables.todos.update({ id: "b0000000-0000-0000-0000-000000000000" }, { title: "B2" });
    await tick();

    const diffEnvelopes = seen.filter((e) => e.type === "live-diff");
    const initialEnvelopes = seen.filter((e) => e.type === "live-initial");
    expect(initialEnvelopes).toHaveLength(1); // exactly one snapshot, ever
    expect(diffEnvelopes.length).toBeGreaterThanOrEqual(1);
    const lastDiff = identityCodec.decode(diffEnvelopes.at(-1)!.payload) as {
      added: unknown[];
      changed: { key: string }[];
      removed: unknown[];
    };
    // A DIFF, not a full resend: the single changed row is present; the unchanged row is NOT in added/changed.
    expect(lastDiff.added).toHaveLength(0);
    expect(lastDiff.removed).toHaveLength(0);
    expect(lastDiff.changed.map((c) => c.key)).toEqual(["b0000000-0000-0000-0000-000000000000"]);

    // Tab-side materializer: the last emission keeps A's object identity, B is a fresh object.
    const latest = emissions.at(-1)!;
    expect(latest.map((r) => r.title)).toEqual(["A", "B2"]);
    expect(latest[0]).toBe(initialRows[0]); // A unchanged → same object (===)
    expect(latest[1]).not.toBe(initialRows[1]); // B changed → new object

    // Unsubscribe stops updates.
    const before = emissions.length;
    sub.unsubscribe();
    await tick();
    await client.tables.todos.update({ id: "a0000000-0000-0000-0000-000000000000" }, { title: "A2" });
    await tick();
    expect(emissions.length).toBe(before);
  });

  it("surfaces the worker-activated lazy relations on the subscription (tab-side `lazyTables`)", async () => {
    const host = await makeHost();
    const { client } = await attach(host);
    await client.ready;

    // Readonly relation → no read-model view; read the synced local table directly (as apps do).
    const archiveModel = getSyncedLocalTable(todosRegistry, "archive");
    const lazyBuilder = client.drizzle
      .select({ id: archiveModel.id, label: archiveModel.label })
      .from(archiveModel)
      .orderBy(archiveModel.id);
    const { sql, params } = lazyBuilder.toSQL();

    // The worker's guard scans the SQL, activates `archive`, and reports the key back on `live-initial`;
    // the tab surfaces it as `lazyTables` (observability). Sync is DISABLED in this harness, so there is no
    // consistency group to catch up — `hydratingTables` is empty and NO `hydrated` promise is built (the
    // sync-disabled semantics: no gating at all). Hydration gating is exercised against a not-ready group in
    // `worker-live-hydration.test.ts`.
    const sub = await client.subscribeLiveRows<{ id: string; label: string }>(
      { sql, params, pkColumns: ["id"] },
      () => {
        /* no live updates in this test */
      },
    );
    expect(sub.lazyTables).toEqual(["archive"]);
    expect(sub.hydrated).toBeUndefined();
    // No tick around unsubscribe: the host now awaits every live-query teardown before closing PGlite
    // (ADR-0040 decision 1), so unsubscribing the same macrotask it registered no longer wedges the
    // runner on the afterEach `host.close()`.
    sub.unsubscribe();

    // An eager-only query carries no lazyTables and no hydrated promise (nothing to await).
    const eagerBuilder = client.drizzle.select({ id: readModel.id }).from(readModel);
    const eagerSql = eagerBuilder.toSQL();
    const eagerSub = await client.subscribeLiveRows<{ id: string }>(
      { sql: eagerSql.sql, params: eagerSql.params, pkColumns: ["id"] },
      () => undefined,
    );
    expect(eagerSub.lazyTables).toBeUndefined();
    expect(eagerSub.hydrated).toBeUndefined();
    eagerSub.unsubscribe();
  });
});

describe("boot observability (ADR-0034)", () => {
  it("bootReport RPC round-trips the worker's finalized report", async () => {
    const host = await makeHost();
    const { client } = await attach(host);
    await client.ready;

    // Pull the worker engine's stored report over the bridge (a plain object, structured-cloned). The RpcOp
    // is wired end to end — before this it was absent (the attach method would have thrown). Awaited
    // directly, NOT via `expect(...).resolves` — a MessageChannel-driven resolution does not settle the bun
    // matcher here (same quirk the rawQuery/desync tests call out).
    const report = await client.bootReport();
    expect(report).not.toBeNull();
    expect(report!.reportVersion).toBe(1);
    // The worker labels its report `worker` (ADR-0034); syncEnabled:false → boot finalizes at ready with no
    // eager groups, and the store was adopted (precreated) so the create cost is not this boot's.
    expect(report!.mode).toBe("worker");
    expect(report!.groups).toHaveLength(0);
  });

  it("replays the pre-attach debug rail buffer to the first attaching tab", async () => {
    // A host that MINTS its own store, so a `provision` rail line is emitted BEFORE any attach — the front
    // half of boot that used to vanish (ADR-0034).
    const host = defineSyncWorker({
      registry: todosRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      // The worker mints a MEMORY store here (test only) — acknowledge it past the BYO refusal (ADR-0036).
      ...testStoreAcknowledgment(),
      createPglite: async () =>
        (await PGlite.create({
          loadDataDir: await prepopulatedDataDir(),
          extensions: { live },
        })) as unknown as ClientPGlite,
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
    });
    hosts.push(host);

    // Provision on its OWN port first (emits `worker store provisioned` into the rail buffer, pre-attach).
    const provChannel = new MessageChannel();
    channels.push(provChannel);
    host.connect(provChannel.port1 as unknown as never);
    await provisionSyncWorker({ port: provChannel.port2 as unknown as never });

    // Then attach on a second port — the FIRST attach receives the buffered rail lines, `[replay]`-marked.
    const { client, seen } = await attach(host);
    await client.ready;

    const replayLines = seen
      .filter((e) => e.type === "event")
      .map((e) => identityCodec.decode(e.payload) as { kind: string; line?: string })
      .filter((ev) => ev.kind === "debug" && typeof ev.line === "string" && ev.line.startsWith("[replay]"));
    // A summary line plus the buffered `worker store provisioned` line, all replay-marked.
    expect(replayLines.length).toBeGreaterThanOrEqual(1);
    expect(replayLines.some((ev) => ev.line!.includes("buffered rail line"))).toBe(true);
    expect(replayLines.some((ev) => ev.line!.includes("worker store provisioned"))).toBe(true);
  });
});

describe("event fanout (ADR-0032 decision 7)", () => {
  it("delivers status to every attached port and a worker-stamped debug line to both", async () => {
    const host = await makeHost();
    const { seen: seenA, client: clientA } = await attach(host);
    await clientA.ready;
    const { seen: seenB, client: clientB } = await attach(host);
    await clientB.ready;
    // A late tab's `ready` now resolves from the ack's `engineReady` (ADR-0032 FIX 3), which can win the
    // race against the status event that follows the ack; tick once so that broadcast status lands in `seen`.
    await tick();

    // Each port received a status event on its own attach.
    expect(
      seenA.some((e) => e.type === "event" && (identityCodec.decode(e.payload) as { kind: string }).kind === "status"),
    ).toBe(true);
    expect(
      seenB.some((e) => e.type === "event" && (identityCodec.decode(e.payload) as { kind: string }).kind === "status"),
    ).toBe(true);

    // A write triggers a convergence-pass debug line in the worker, which broadcasts to BOTH ports with the
    // worker's monotonic stamp.
    await clientA.tables.todos.create({ id: "c0000000-0000-0000-0000-000000000000", title: "C", done: false });
    await tick();

    const debugOf = (seen: BridgeEnvelope[]) =>
      seen
        .filter((e) => e.type === "event")
        .map((e) => identityCodec.decode(e.payload) as { kind: string; stamp?: number })
        .filter((ev) => ev.kind === "debug");
    const debugA = debugOf(seenA);
    const debugB = debugOf(seenB);
    expect(debugA.length).toBeGreaterThanOrEqual(1);
    expect(debugB.length).toBeGreaterThanOrEqual(1);
    expect(typeof debugA.at(-1)!.stamp).toBe("number");
  });
});

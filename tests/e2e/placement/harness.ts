// The placement-lane HARNESS page (ADR-0049 step 12). It exposes `window.__placement` — precise, low-level
// hooks the Playwright multi-tab lanes drive. Unlike the board app, this page gives the test EXACT control over
// each placement primitive: query the SharedWorker's placement decision directly, attach with/without the
// worker-construction factories, run a read + a local mutation, read the `BootReport` diagnostics, observe the
// leader Web Lock, read the store meta record, seed a bare idb store, and destroy. Every long-running hook is
// BOUNDED so a lane can never hang the suite: it returns a diagnostic object instead.

import { fkSyncRegistry } from "@pgxsinkit/schema";

import {
  attachSyncClient,
  type AttachedSyncClient,
  type AttachSyncClientOptions,
  createClientPGlite,
  createSyncClient,
  destroyStoreArtifacts,
  EngineRelocatedError,
  generateLocalSchemaSql,
  provisionSyncWorker,
  quiesceStoreWorker,
  type StoreWorkerQuiesceOutcome,
  wrapEngineWorker,
} from "../../../packages/client/src/index";
import { idbStoreExists, readStoreMetaRecord } from "../../../packages/client/src/store-meta";
import { storeIdentityComponent } from "../../../packages/client/src/store-path";
import {
  DESTROY_QUERY_KEY,
  DESTROY_VERDICT_KEY,
  PLACEMENT_QUERY_KEY,
  PLACEMENT_RESULT_KEY,
  type PlacementQueryResult,
} from "../../../packages/client/src/worker/define-sync-worker";
import { LEADER_LOCK_PREFIX } from "../../../packages/client/src/worker/election-coordinator";
import { PLACEMENT_ELECTRIC_URL, PLACEMENT_WRITE_URL, type PlacementRegistry, placementRegistry } from "./registry";

type Client = AttachedSyncClient<PlacementRegistry>;
/** The worker INPUT shape `attachSyncClient` accepts (ADR-0049 D5): a FACTORY `() => SharedWorker` or a bare instance. */
type WorkerLikeOpt = NonNullable<AttachSyncClientOptions<PlacementRegistry>["worker"]>;
/** The `WorkerLike` instance shape {@link wrapEngineWorker} takes (a real dedicated `Worker` is cast to it). */
type EngineWorkerLike = Parameters<typeof wrapEngineWorker>[0];

// Vite statically detects `new SharedWorker(new URL("./x", import.meta.url))` / `new Worker(new URL(...))` and
// bundles the chunk — the `new URL(...)` MUST be inline in the constructor (an indirection defeats detection).
// The SAME chunk serves the SharedWorker (attach point / router) and the elected dedicated engine `Worker`.

/** A SharedWorker constructor that tolerates the `extendedLifetime` member (plan step 14; ignored where unknown). */
interface ExtendedSharedWorkerOptions {
  type?: "module" | "classic";
  name?: string;
  extendedLifetime?: boolean;
}
const newSharedWorker = (name: string): SharedWorker =>
  new SharedWorker(new URL("./sync.worker.ts", import.meta.url), {
    type: "module",
    name,
    extendedLifetime: true,
  } as ExtendedSharedWorkerOptions as WorkerOptions);

const newEngineWorker = (): Worker => new Worker(new URL("./sync.worker.ts", import.meta.url), { type: "module" });

const newExecutionLimitSharedWorker = (name: string): SharedWorker =>
  new SharedWorker(new URL("./execution-limit.sync.worker.ts", import.meta.url), {
    type: "module",
    name,
    extendedLifetime: true,
  } as ExtendedSharedWorkerOptions as WorkerOptions);
const newExecutionLimitEngineWorker = (): Worker =>
  new Worker(new URL("./execution-limit.sync.worker.ts", import.meta.url), { type: "module" });

// ── Server-lane workers (real sync against the fixture server) — the SAME chunk serves router + elected engine. ──
const newServerSharedWorker = (name: string): SharedWorker =>
  new SharedWorker(new URL("./server.sync.worker.ts", import.meta.url), {
    type: "module",
    name,
    extendedLifetime: true,
  } as ExtendedSharedWorkerOptions as WorkerOptions);
const newServerEngineWorker = (): Worker =>
  new Worker(new URL("./server.sync.worker.ts", import.meta.url), { type: "module" });

type ServerClient = AttachedSyncClient<typeof fkSyncRegistry>;
const serverClients = new Map<string, ServerClient>();
// In-flight server-lane `flush()` handles (issued but NOT awaited — the relocation-outcome mutation half).
const serverFlushes = new Map<string, Promise<unknown>>();

const clients = new Map<string, Client>();
// Provision SharedWorker connections retained per store — the elected provision's shared coordinator posts its
// keepalive/announce on this connection, so it MUST outlive `provisionSyncWorker` for a later attach to adopt.
const provisionWorkers = new Map<string, SharedWorker>();
// In-flight op handles for the relocation-outcome lane (issued but deliberately NOT awaited).
const inFlight = new Map<string, { read: Promise<unknown>; mutation: Promise<unknown> }>();
// Hung op handles for the execution-limit lane (a long engine-blocking rawExec, issued but NOT awaited).
const hangs = new Map<string, Promise<unknown>>();

const withTimeout = async <T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<{ value: T; timedOut: boolean }> => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    handle = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  const race = await Promise.race([work.then((value) => ({ value, timedOut: false as const })), timeout]);
  if (handle) clearTimeout(handle);
  if ("timedOut" in race && race.timedOut) return { value: onTimeout(), timedOut: true };
  return { value: (race as { value: T }).value, timedOut: false };
};

const describeError = (error: unknown): { name: string; message: string; code?: string; outcome?: string } => {
  if (error instanceof EngineRelocatedError) {
    return { name: error.name, message: error.message, code: error.code, outcome: error.outcome };
  }
  if (error instanceof Error) {
    const withPeers = error as Error & { peers?: number };
    return {
      name: error.name,
      message: error.message,
      ...(typeof withPeers.peers === "number" ? { code: `peers:${withPeers.peers}` } : {}),
    };
  }
  return { name: "Error", message: String(error) };
};

export interface AttachResult {
  ok: boolean;
  timedOut: boolean;
  error?: ReturnType<typeof describeError>;
}

export interface PlacementHarness {
  /** Query the SharedWorker's placement decision directly (no attach) — the raw `electionRequired` reply. */
  probePlacement(
    name: string,
    timeoutMs?: number,
  ): Promise<{ ok: true; result: PlacementQueryResult } | { ok: false; timedOut: boolean; error?: string }>;
  /**
   * Attach a client to a per-store SharedWorker. `factories` wires the `createEngineWorker` override;
   * `executionLimitMs` sets this tab's ADR-0049 D5 execution limit (the overdue-dispatch report timing).
   */
  attach(input: {
    storePath: string;
    factories: boolean;
    executionLimitMs?: number;
    keepaliveIntervalMs?: number;
    keepaliveMissThreshold?: number;
    /** Disable the non-leader bridge-silence reconnect (so the execution-limit path — not silence — handles a hang). */
    disableBridgeSilence?: boolean;
    /** Pass a BARE `worker` INSTANCE instead of a factory — reconstruction is then structurally unavailable (ADR-0049 D5). */
    omitCreateWorker?: boolean;
    /** Send the ADR-0050 `storage: { backend: "idbfs" }` wire declaration — the SW-direct idbfs engine, no probe. */
    forceIdbfs?: boolean;
    timeoutMs?: number;
  }): Promise<AttachResult>;
  /** Dispatch a long engine-blocking `rawExec` (a CPU-bound cross join) and DO NOT await it — the hang injector. */
  startHang(storePath: string): { started: boolean };
  /** Await the hung op, capturing its settlement (EngineRelocatedError code+outcome) after termination + respawn. */
  settleHang(
    storePath: string,
    timeoutMs?: number,
  ): Promise<{ settled: "resolved" | "rejected" | "pending"; error?: ReturnType<typeof describeError> }>;
  /**
   * Pre-spawn (initdb-only) a store WITHOUT attaching — the elected-mode `provisionSyncWorker` (drives the
   * PROVISION CLAIM, provisions over the elected engine's pipe). Retains the SharedWorker so a later `attach` on
   * the same store ADOPTS the grant (no second engine, no double initdb).
   */
  provision(input: { storePath: string; timeoutMs?: number }): Promise<AttachResult>;
  /**
   * SERVER-LANE attach: boots the REAL sync engine (`server.sync.worker.ts`, `fkSyncRegistry`) against the fixture
   * server — Electric shape catch-up + the write API. Only the SERVER lanes call this (they skip when the fixture
   * env is absent).
   */
  attachServer(input: { storePath: string; timeoutMs?: number }): Promise<AttachResult>;
  /** Create an `fk_parents` row through the server-lane client (a synced write). */
  serverCreate(
    storePath: string,
    id: string,
    name: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; timedOut: boolean; error?: ReturnType<typeof describeError> }>;
  /** The store meta phase of a server-lane store (proves the offline-first commit: `opfs-committed`/`idb-authoritative`). */
  serverMetaPhase(storePath: string): Promise<string>;
  /** The LOCAL `fk_parents` row count (via the client's read path) — proves a write is locally durable. */
  serverLocalCount(storePath: string, timeoutMs?: number): Promise<number>;
  /** Wait until the server-lane engine has flushed its journal (mutation diagnostics show zero owed). */
  serverOwedCount(storePath: string, timeoutMs?: number): Promise<number>;
  /** Issue a `flush()` on the server-lane client and DO NOT await it — with a slow/refusing server it rides the
   *  delayed write path, so it is a genuine in-flight MUTATION-class RPC when the engine relocates. */
  serverStartFlush(storePath: string): { started: boolean };
  /** Await the in-flight `flush()`, capturing its settlement (EngineRelocatedError code+outcome on relocation). */
  serverSettleFlush(
    storePath: string,
    timeoutMs?: number,
  ): Promise<{ settled: "resolved" | "rejected" | "pending"; error?: ReturnType<typeof describeError> }>;
  /** Detach a server-lane client (explicit stop). */
  serverStop(storePath: string): Promise<void>;
  /**
   * Open `connections` SharedWorker connections to one per-store router, then post the DESTROY peer-count query
   * on the first — the router's real `tabCount()` verdict the destroy peer-refusal is built on (D8). Exercises
   * the real router wire in a browser WITHOUT a full engine boot.
   */
  peerVerdict(
    name: string,
    connections: number,
    timeoutMs?: number,
  ): Promise<{ ok: true; peers: number } | { ok: false; timedOut: boolean; error?: string }>;
  /** Read the engine's finalized BootReport (diagnostics: storageBackend / engineHome). */
  bootReport(
    storePath: string,
    timeoutMs?: number,
  ): Promise<{ ok: true; report: unknown } | { ok: false; timedOut: boolean; error?: string }>;
  /** A proxied read RPC — `SELECT 1`. */
  read(storePath: string, timeoutMs?: number): Promise<{ ok: boolean; timedOut: boolean; rows?: unknown }>;
  /** A local mutation — `notes.create`. */
  mutate(storePath: string, timeoutMs?: number): Promise<{ ok: boolean; timedOut: boolean; error?: unknown }>;
  /** Issue a read + a mutation and DO NOT await them (the relocation-outcome lane). */
  startInFlight(storePath: string): { started: boolean };
  /** Await the in-flight read + mutation, capturing each settlement (EngineRelocatedError code+outcome). */
  settleInFlight(
    storePath: string,
    timeoutMs?: number,
  ): Promise<{
    read: { settled: "resolved" | "rejected" | "pending"; error?: ReturnType<typeof describeError> };
    mutation: { settled: "resolved" | "rejected" | "pending"; error?: ReturnType<typeof describeError> };
  }>;
  /** Destroy through the attached facade (peer-refusal + owed-mutation gates). */
  destroy(
    storePath: string,
    options?: { force?: boolean },
    timeoutMs?: number,
  ): Promise<{
    ok: boolean;
    timedOut: boolean;
    error?: ReturnType<typeof describeError>;
  }>;
  /** Detach this tab (explicit stop). */
  stop(storePath: string): Promise<void>;
  /** ADR-0050: tear down the store's SharedWorker host BY NAME (a fresh connection), reporting the outcome. */
  quiesceByName(
    name: string,
    timeoutMs?: number,
  ): Promise<{ ok: true; outcome: StoreWorkerQuiesceOutcome } | { ok: false; timedOut: boolean; error?: string }>;
  /** ADR-0050: destroy a store's artifacts BY PATH (no attached client) — the path-addressed delete. */
  destroyArtifacts(storePath: string, timeoutMs?: number): Promise<{ ok: boolean; timedOut: boolean; error?: string }>;
  /** The currently HELD leader Web Locks (`pgx-leader-*`), via `navigator.locks.query()`. */
  leaderLocks(): Promise<{ held: string[]; pending: string[] }>;
  /** The store meta record's phase, or `"absent"` / `"unavailable"`. */
  metaPhase(storePath: string): Promise<string>;
  /** Seed a bare PGlite idb store directly (a recordless idb store), then close it. */
  seedIdbStore(storePath: string): Promise<{ ok: boolean; error?: string }>;
  /** Seed a recordless idb store with the server registry's real local schema, then close it. */
  seedServerIdbStore(storePath: string): Promise<{ ok: boolean; error?: string }>;
  /** Open an idb-authoritative in-process store and destroy it through the real lifecycle. */
  destroyIdbStore(storePath: string): Promise<{ ok: boolean; error?: string }>;
  /** The non-creating idb existence check (invariant 14). */
  idbExists(storePath: string): Promise<boolean>;
  /** Best-effort isolation reset: stop the client and delete idb + opfs + meta for this store. */
  cleanup(storePath: string): Promise<void>;
}

const harness: PlacementHarness = {
  async probePlacement(name, timeoutMs = 6_000) {
    const sw = newSharedWorker(name);
    const port = sw.port;
    port.start();
    const reply = new Promise<PlacementQueryResult>((resolve) => {
      const listener = (event: MessageEvent) => {
        const data = event.data as { [PLACEMENT_RESULT_KEY]?: PlacementQueryResult } | null;
        const result = data && typeof data === "object" ? data[PLACEMENT_RESULT_KEY] : undefined;
        if (result !== undefined) {
          port.removeEventListener("message", listener);
          resolve(result);
        }
      };
      port.addEventListener("message", listener);
      port.postMessage({ [PLACEMENT_QUERY_KEY]: true });
    });
    const { value, timedOut } = await withTimeout(reply, timeoutMs, () => undefined as unknown as PlacementQueryResult);
    if (timedOut || value === undefined)
      return { ok: false, timedOut, error: timedOut ? "placement query timed out" : "no reply" };
    return { ok: true, result: value };
  },

  async attach({
    storePath,
    factories,
    executionLimitMs,
    keepaliveIntervalMs,
    keepaliveMissThreshold,
    disableBridgeSilence,
    omitCreateWorker,
    forceIdbfs,
    timeoutMs = 12_000,
  }) {
    const makeSharedWorker = executionLimitMs == null ? newSharedWorker : newExecutionLimitSharedWorker;
    const makeEngineWorker = executionLimitMs == null ? newEngineWorker : newExecutionLimitEngineWorker;
    // Factory-first (ADR-0049 D5): the primary `worker` is a FACTORY `() => SharedWorker` — the ONE input that both
    // the bridge-silence reconnect AND the coordinator's keepalive SW-reconstruction re-invoke. The
    // `omitCreateWorker` arm passes a BARE INSTANCE instead, exercising the structural "no reconstruction" case.
    const useFactory = !omitCreateWorker;
    const swInput: WorkerLikeOpt = useFactory
      ? ((() => makeSharedWorker(storePath)) as unknown as WorkerLikeOpt)
      : (makeSharedWorker(storePath) as unknown as WorkerLikeOpt);
    const attachWork = attachSyncClient<PlacementRegistry>({
      registry: placementRegistry,
      worker: swInput,
      storePath,
      syncEnabled: false,
      ...(forceIdbfs ? { storage: { backend: "idbfs" } } : {}),
      ...(executionLimitMs != null ? { executionLimit: { maxDispatchMs: executionLimitMs } } : {}),
      ...(keepaliveIntervalMs != null ? { keepaliveIntervalMs } : {}),
      ...(keepaliveMissThreshold != null ? { keepaliveMissThreshold } : {}),
      ...(factories
        ? {
            // Explicit override of the URL-derived default (the dual-scope entry would auto-derive, but the harness
            // wires its own engine builder). Auto-derivation is exercised by the browser lanes with no override.
            createEngineWorker: () => wrapEngineWorker(makeEngineWorker() as unknown as EngineWorkerLike),
            ...(useFactory && !disableBridgeSilence ? { bridgeSilenceMs: 4_000 } : {}),
          }
        : {}),
    });
    try {
      const { value, timedOut } = await withTimeout(attachWork, timeoutMs, () => undefined as unknown as Client);
      if (timedOut) return { ok: false, timedOut: true, error: { name: "Timeout", message: "attach timed out" } };
      clients.set(storePath, value);
      return { ok: true, timedOut: false };
    } catch (error) {
      return { ok: false, timedOut: false, error: describeError(error) };
    }
  },

  async provision({ storePath, timeoutMs = 12_000 }) {
    // Retain the SharedWorker: the elected provision's shared coordinator lives on THIS connection, and a later
    // `attach` on the same store adopts it — so the connection must outlive `provisionSyncWorker`.
    const sw = newSharedWorker(storePath);
    provisionWorkers.set(storePath, sw);
    const work = provisionSyncWorker<PlacementRegistry>({
      // Bare instance: the provision connection is retained (see above) so a later attach adopts its coordinator;
      // provision itself needs no reconstruction factory.
      worker: sw as unknown as WorkerLikeOpt,
      storePath,
      createEngineWorker: () => wrapEngineWorker(newEngineWorker() as unknown as EngineWorkerLike),
    });
    try {
      const { timedOut } = await withTimeout(work, timeoutMs, () => undefined);
      if (timedOut) return { ok: false, timedOut: true, error: { name: "Timeout", message: "provision timed out" } };
      return { ok: true, timedOut: false };
    } catch (error) {
      return { ok: false, timedOut: false, error: describeError(error) };
    }
  },

  async attachServer({ storePath, timeoutMs = 20_000 }) {
    const attachWork = attachSyncClient<typeof fkSyncRegistry>({
      registry: fkSyncRegistry,
      // Factory-first (ADR-0049 D5): the SharedWorker factory drives both the initial construct and SW-death recovery.
      worker: (() => newServerSharedWorker(storePath)) as unknown as NonNullable<
        AttachSyncClientOptions<typeof fkSyncRegistry>["worker"]
      >,
      storePath,
      syncEnabled: true,
      createEngineWorker: () => wrapEngineWorker(newServerEngineWorker() as unknown as EngineWorkerLike),
    });
    try {
      const { value, timedOut } = await withTimeout(attachWork, timeoutMs, () => undefined as unknown as ServerClient);
      if (timedOut)
        return { ok: false, timedOut: true, error: { name: "Timeout", message: "server attach timed out" } };
      serverClients.set(storePath, value);
      return { ok: true, timedOut: false };
    } catch (error) {
      return { ok: false, timedOut: false, error: describeError(error) };
    }
  },

  async serverCreate(storePath, id, name, timeoutMs = 8_000) {
    const client = serverClients.get(storePath);
    if (!client) return { ok: false, timedOut: false, error: { name: "Error", message: "no server client" } };
    try {
      const { timedOut } = await withTimeout(
        client.mutate.create("fk_parents", { id, name } as never),
        timeoutMs,
        () => undefined,
      );
      if (timedOut) return { ok: false, timedOut: true };
      return { ok: true, timedOut: false };
    } catch (error) {
      return { ok: false, timedOut: false, error: describeError(error) };
    }
  },

  async serverMetaPhase(storePath) {
    try {
      const record = await readStoreMetaRecord(storePath);
      if (record === undefined) return "absent";
      if (typeof record === "symbol") return "unavailable";
      return record.phase;
    } catch (error) {
      return `error:${describeError(error).name}`;
    }
  },

  async serverLocalCount(storePath, timeoutMs = 8_000) {
    const client = serverClients.get(storePath);
    if (!client) return -1;
    try {
      const { value, timedOut } = await withTimeout(
        client.rawQuery("SELECT count(*)::int AS n FROM fk_parents"),
        timeoutMs,
        () => undefined,
      );
      if (timedOut) return -1;
      const rows = (value as unknown as { rows?: Array<{ n: number }> })?.rows;
      return rows?.[0]?.n ?? 0;
    } catch {
      return -1;
    }
  },

  async serverOwedCount(storePath, timeoutMs = 8_000) {
    const client = serverClients.get(storePath);
    if (!client) return -1;
    try {
      const { value, timedOut } = await withTimeout(client.diagnostics(), timeoutMs, () => undefined);
      if (timedOut) return -1;
      const m = (value as { mutation?: { pendingCount: number; sendingCount: number; failedCount: number } })?.mutation;
      return m ? m.pendingCount + m.sendingCount + m.failedCount : -1;
    } catch {
      return -1;
    }
  },

  serverStartFlush(storePath) {
    const client = serverClients.get(storePath);
    if (!client) return { started: false };
    const work = client.flush();
    void work.catch(() => undefined);
    serverFlushes.set(storePath, work as Promise<unknown>);
    return { started: true };
  },

  async serverSettleFlush(storePath, timeoutMs = 20_000) {
    const work = serverFlushes.get(storePath);
    if (!work) return { settled: "pending" };
    type Out = { settled: "resolved" | "rejected" | "pending"; error?: ReturnType<typeof describeError> };
    const mapped: Promise<Out> = work.then(
      () => ({ settled: "resolved" as const }),
      (error: unknown) => ({ settled: "rejected" as const, error: describeError(error) }),
    );
    const { value, timedOut } = await withTimeout<Out>(mapped, timeoutMs, () => ({ settled: "pending" as const }));
    return timedOut ? { settled: "pending" } : value;
  },

  async serverStop(storePath) {
    const client = serverClients.get(storePath);
    if (!client) return;
    try {
      await client.stop();
    } catch {
      // ignore
    }
    serverClients.delete(storePath);
    serverFlushes.delete(storePath);
  },

  async peerVerdict(name, connections, timeoutMs = 6_000) {
    const ports: MessagePort[] = [];
    for (let i = 0; i < connections; i += 1) {
      const sw = newSharedWorker(name);
      sw.port.start();
      ports.push(sw.port);
    }
    const port = ports[0]!;
    let observedPeers = -1;
    const listener = (event: MessageEvent) => {
      const data = event.data as { [DESTROY_VERDICT_KEY]?: { peers?: number } } | null;
      const peers = data && typeof data === "object" ? data[DESTROY_VERDICT_KEY]?.peers : undefined;
      if (typeof peers === "number") observedPeers = peers;
    };
    port.addEventListener("message", listener);
    const deadline = Date.now() + timeoutMs;
    while (observedPeers < connections && Date.now() < deadline) {
      port.postMessage({ [DESTROY_QUERY_KEY]: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    port.removeEventListener("message", listener);
    for (const p of ports) p.close();
    if (observedPeers < connections) return { ok: false, timedOut: true, error: "verdict timed out" };
    return { ok: true, peers: observedPeers };
  },

  async bootReport(storePath, timeoutMs = 8_000) {
    const client = clients.get(storePath) ?? serverClients.get(storePath);
    if (!client) return { ok: false, timedOut: false, error: "no attached client" };
    try {
      const { value, timedOut } = await withTimeout(client.bootReport(), timeoutMs, () => null);
      if (timedOut) return { ok: false, timedOut: true, error: "bootReport timed out" };
      return { ok: true, report: value };
    } catch (error) {
      return { ok: false, timedOut: false, error: describeError(error).message };
    }
  },

  async read(storePath, timeoutMs = 8_000) {
    const client = clients.get(storePath);
    if (!client) return { ok: false, timedOut: false };
    try {
      const { value, timedOut } = await withTimeout(
        client.rawQuery("SELECT 1 AS n"),
        timeoutMs,
        () => undefined as unknown,
      );
      if (timedOut) return { ok: false, timedOut: true };
      return { ok: true, timedOut: false, rows: (value as { rows?: unknown })?.rows };
    } catch {
      return { ok: false, timedOut: false };
    }
  },

  async mutate(storePath, timeoutMs = 8_000) {
    const client = clients.get(storePath);
    if (!client) return { ok: false, timedOut: false, error: "no attached client" };
    try {
      const work = client.mutate.create("notes", {
        id: crypto.randomUUID(),
        body: `placement ${crypto.randomUUID()}`,
      } as never);
      const { timedOut } = await withTimeout(work, timeoutMs, () => undefined);
      if (timedOut) return { ok: false, timedOut: true };
      return { ok: true, timedOut: false };
    } catch (error) {
      return { ok: false, timedOut: false, error: describeError(error) };
    }
  },

  startHang(storePath) {
    const client = clients.get(storePath);
    if (!client) return { started: false };
    // A CPU-bound cross join genuinely holds the single-threaded WASM engine busy for many seconds — real work
    // (never `pg_sleep`, which PGlite lacks), so the engine's control plane cannot answer the router's probe pings
    // (the execution-limit liveness signal). `rawExec` is a WRITE-CAPABLE op → its lost response settles `unknown`.
    const work = client.rawExec(
      "SELECT count(*) FROM generate_series(1, 60000) a CROSS JOIN generate_series(1, 60000) b",
    );
    void work.catch(() => undefined);
    hangs.set(storePath, work as Promise<unknown>);
    return { started: true };
  },

  async settleHang(storePath, timeoutMs = 20_000) {
    const work = hangs.get(storePath);
    if (!work) return { settled: "pending" };
    type Out = { settled: "resolved" | "rejected" | "pending"; error?: ReturnType<typeof describeError> };
    const mapped: Promise<Out> = work.then(
      () => ({ settled: "resolved" as const }),
      (error: unknown) => ({ settled: "rejected" as const, error: describeError(error) }),
    );
    const { value, timedOut } = await withTimeout<Out>(mapped, timeoutMs, () => ({ settled: "pending" as const }));
    return timedOut ? { settled: "pending" } : value;
  },

  startInFlight(storePath) {
    const client = clients.get(storePath);
    if (!client) return { started: false };
    const read = client.rawQuery("SELECT 1 AS n");
    const mutation = client.mutate.create("notes", {
      id: crypto.randomUUID(),
      body: `inflight ${crypto.randomUUID()}`,
    } as never);
    // Never let an unhandled rejection escape before `settleInFlight` runs.
    void read.catch(() => undefined);
    void mutation.catch(() => undefined);
    inFlight.set(storePath, { read, mutation });
    return { started: true };
  },

  async settleInFlight(storePath, timeoutMs = 8_000) {
    const handles = inFlight.get(storePath);
    if (!handles) {
      return { read: { settled: "pending" }, mutation: { settled: "pending" } };
    }
    type OpOutcome = { settled: "resolved" | "rejected" | "pending"; error?: ReturnType<typeof describeError> };
    const settle = async (work: Promise<unknown>): Promise<OpOutcome> => {
      const mapped: Promise<OpOutcome> = work.then(
        () => ({ settled: "resolved" as const }),
        (error: unknown) => ({ settled: "rejected" as const, error: describeError(error) }),
      );
      const { value, timedOut } = await withTimeout<OpOutcome>(mapped, timeoutMs, () => ({
        settled: "pending" as const,
      }));
      return timedOut ? { settled: "pending" } : value;
    };
    const [read, mutation] = await Promise.all([settle(handles.read), settle(handles.mutation)]);
    return { read, mutation };
  },

  async destroy(storePath, options, timeoutMs = 12_000) {
    const client = clients.get(storePath);
    if (!client) return { ok: false, timedOut: false, error: { name: "Error", message: "no attached client" } };
    try {
      const { timedOut } = await withTimeout(client.destroy(options), timeoutMs, () => undefined);
      if (timedOut) return { ok: false, timedOut: true };
      clients.delete(storePath);
      return { ok: true, timedOut: false };
    } catch (error) {
      return { ok: false, timedOut: false, error: describeError(error) };
    }
  },

  async stop(storePath) {
    const client = clients.get(storePath);
    if (!client) return;
    await client.stop();
    clients.delete(storePath);
  },

  async quiesceByName(name, timeoutMs = 8_000) {
    try {
      const factory = (() => newSharedWorker(name)) as unknown as Parameters<typeof quiesceStoreWorker>[0];
      const outcome = await quiesceStoreWorker(factory, { timeoutMs });
      return { ok: true as const, outcome };
    } catch (error) {
      const message = describeError(error).message;
      return { ok: false as const, timedOut: message.includes("timed out"), error: message };
    }
  },

  async destroyArtifacts(storePath, timeoutMs = 10_000) {
    try {
      const { timedOut } = await withTimeout(destroyStoreArtifacts(storePath), timeoutMs, () => undefined);
      return { ok: !timedOut, timedOut };
    } catch (error) {
      return { ok: false, timedOut: false, error: describeError(error).message };
    }
  },

  async leaderLocks() {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks?.query) return { held: [], pending: [] };
    const snapshot = await locks.query();
    const leader = (entries: readonly { name?: string }[] | undefined): string[] =>
      (entries ?? []).map((e) => e.name ?? "").filter((name) => name.startsWith(LEADER_LOCK_PREFIX));
    return { held: leader(snapshot.held), pending: leader(snapshot.pending) };
  },

  async metaPhase(storePath) {
    try {
      const record = await readStoreMetaRecord(storePath);
      if (record === undefined) return "absent";
      if (typeof record === "symbol") return "unavailable";
      return record.phase;
    } catch (error) {
      return `error:${describeError(error).name}`;
    }
  },

  async seedIdbStore(storePath) {
    try {
      // Default `createClientPGlite` (no OPFS grant) mints an idbfs store — a recordless idb store.
      const pg = await createClientPGlite(storePath);
      await pg.exec("CREATE TABLE IF NOT EXISTS recordless_marker (v integer)");
      await pg.exec("INSERT INTO recordless_marker VALUES (1)");
      await pg.close();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeError(error).message };
    }
  },

  async seedServerIdbStore(storePath) {
    try {
      // Adoption's drain gate reads the predecessor journal before constructing its successor. A realistic
      // recordless idb store therefore needs the package-generated local schema for the server registry, while
      // remaining recordless so the boot classifier still exercises invariant 14.
      const pg = await createClientPGlite(storePath);
      await pg.exec(generateLocalSchemaSql(fkSyncRegistry));
      await pg.close();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeError(error).message };
    }
  },

  async destroyIdbStore(storePath) {
    try {
      const client = await createSyncClient({
        registry: placementRegistry,
        electricUrl: PLACEMENT_ELECTRIC_URL,
        batchWriteUrl: PLACEMENT_WRITE_URL,
        storePath,
        syncEnabled: false,
      });
      await client.destroy({ force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeError(error).message };
    }
  },

  idbExists(storePath) {
    return idbStoreExists(storePath);
  },

  async cleanup(storePath) {
    const client = clients.get(storePath);
    if (client) {
      try {
        await client.stop();
      } catch {
        // ignore
      }
      clients.delete(storePath);
    }
    inFlight.delete(storePath);
    provisionWorkers.delete(storePath);
    const identity = (() => {
      try {
        return storeIdentityComponent(storePath);
      } catch {
        return storePath;
      }
    })();
    // Delete the PGlite idb database, the meta record, and the OPFS store directory — best effort.
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    const deleteDb = (name: string): Promise<void> =>
      new Promise((resolve) => {
        try {
          const req = idb?.deleteDatabase(name);
          if (!req) return resolve();
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        } catch {
          resolve();
        }
      });
    await deleteDb(`/pglite/${storePath}`);
    try {
      const root = await navigator.storage?.getDirectory?.();
      const container = await root?.getDirectoryHandle("pgxsinkit").catch(() => undefined);
      const stores = await container?.getDirectoryHandle("stores").catch(() => undefined);
      await stores?.removeEntry(identity, { recursive: true }).catch(() => undefined);
      const commitments = await container?.getDirectoryHandle("commitments").catch(() => undefined);
      await commitments?.removeEntry(identity).catch(() => undefined);
    } catch {
      // OPFS unavailable — nothing to clean.
    }
  },
};

declare global {
  interface Window {
    __placement: PlacementHarness;
  }
}

window.__placement = harness;

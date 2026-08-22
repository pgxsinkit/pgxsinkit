import { afterEach, describe, expect, it } from "bun:test";
// The SPARE-STORE ADOPTION BUDGET. The engine's boot waits for an in-flight `provision` attempt before it
// decides whether to adopt the warmed store — and that wait used to be UNBOUNDED, so a spare whose create
// never settled (observed once on Chromium: the rail stopped at `boot pglite.create start`, no error, no
// `done`) left every attach parked on "Starting local database…" forever. The spare is documented everywhere
// as a pure ACCELERATOR, never a boot dependency, so the wait is now bounded by the engine-construction
// `provisionAdoptionBudgetMs` (default 20000, measured from the ATTEMPT's start) and a stalled spare refuses
// the attach with a typed `ProvisionStalledError` the host can rebind from.
//
// This is NOT timing-based engine-death detection (ADR-0049 D5's refusal stands): nothing is inferred about
// the engine's liveness, the stalled attempt is left running, and abandoning a schemaless spare costs one
// extra initdb and no data.
//
// Three lanes, over a bun `MessageChannel` against the REAL `defineSyncWorker` (no Worker), modelled on the
// REAL-ENGINE tier of `worker-milestones.test.ts` and the stuck-create harness of `provision-expiry.test.ts`:
//   1. a provision that settles INSIDE the budget is adopted exactly as before (no regression);
//   2. a create that never settles → the page-side `attachSyncClient` rejects with the typed error carrying
//      its fields (proving it crossed the bridge as the CLASS), and the engine's `bootPromise` is cleared —
//      once the stalled create finally completes, a later attach boots on the adopted spare;
//   3. the clone-safe wire form round-trips to the class, and never claims an unrelated detail.

import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";
import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  type BridgeEnvelope,
  type ClientPGlite,
  defineSyncWorker,
  identityCodec,
  isBridgeEnvelope,
  provisionSyncWorker,
  type SyncWorkerHost,
} from "../../packages/client/src/index";
import { memoryStoreForTests } from "../../packages/client/src/testing";
import {
  ENGINE_RELOCATED_CODE,
  ProvisionStalledError,
  provisionStalledFromWire,
  provisionStalledToWire,
} from "../../packages/client/src/worker/engine-control";

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
});
type TodosRegistry = typeof todosRegistry;

let hosts: SyncWorkerHost<TodosRegistry>[] = [];
let channels: MessageChannel[] = [];

afterEach(async () => {
  for (const host of hosts) await host.close().catch(() => undefined);
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  hosts = [];
  channels = [];
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};

async function makePglite(): Promise<ClientPGlite> {
  const pg = await PGlite.create({ loadDataDir: await prepopulatedDataDir(), extensions: { live } });
  return pg as unknown as ClientPGlite;
}

/** Connect a raw port to the host and record every bridge envelope the worker posts back. */
function connectRaw(host: SyncWorkerHost<TodosRegistry>): { port2: MessagePort; seen: BridgeEnvelope[] } {
  const channel = new MessageChannel();
  channels.push(channel);
  host.connect(channel.port1 as unknown as never);
  const seen: BridgeEnvelope[] = [];
  channel.port2.addEventListener("message", (event) => {
    if (isBridgeEnvelope((event as MessageEvent).data)) seen.push((event as MessageEvent).data as BridgeEnvelope);
  });
  channel.port2.start?.();
  return { port2: channel.port2, seen };
}

/** The worker's forwarded debug-rail lines (the `[replay]` prefix a first attach adds is stripped). */
function railLines(seen: BridgeEnvelope[]): string[] {
  return seen
    .filter((envelope) => envelope.type === "event")
    .map((envelope) => identityCodec.decode(envelope.payload) as { kind: string; line?: string })
    .filter((event) => event.kind === "debug" && typeof event.line === "string")
    .map((event) => event.line!.replace(/^\[replay] /, ""));
}

describe("the adoption budget leaves a provision that settles inside it untouched", () => {
  it("a spare minted well inside the budget is adopted by the attach, with no second create", async () => {
    const created: string[] = [];
    let instance: ClientPGlite | null = null;
    const host = defineSyncWorker({
      registry: todosRegistry,
      controlPlaneUrl: "http://127.0.0.1:1",
      streamBaseUrl: "http://127.0.0.1:1/v1/stream",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
      // Generous, but FINITE: the bounded path is the one under test, not the `Infinity` escape hatch.
      provisionAdoptionBudgetMs: 60_000,
      createPglite: async (storePath) => {
        created.push(storePath);
        instance = await makePglite();
        return instance;
      },
    });
    hosts.push(host);

    const { port2, seen } = connectRaw(host);
    await provisionSyncWorker({ port: port2 as unknown as never, ...memoryStoreForTests("budget-adopted") });
    expect(created).toEqual(["budget-adopted"]);

    const client = await attachSyncClient({
      registry: todosRegistry,
      port: port2 as unknown as never,
      ...memoryStoreForTests("budget-adopted"),
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    await client.ready;

    // Adopted, not re-created — and the rail says so; no refusal was emitted.
    expect(railLines(seen)).toContain("worker adopting provisioned store");
    expect(railLines(seen).filter((line) => line.startsWith("worker provision adoption stalled"))).toEqual([]);
    expect(created).toEqual(["budget-adopted"]);
    expect((await host.whenBooted()).pglite).toBe(instance!);
  });
});

describe("a spare whose create never settles refuses the attach typed instead of hanging it", () => {
  it("the attach rejects with ProvisionStalledError, and a later attach still boots once the create lands", async () => {
    const storePath = "budget-stalled";
    const opens = { count: 0 };
    // The genuinely stuck storage open: the provision's create settles ONLY when the test releases it.
    let releaseCreate!: () => void;
    const host = defineSyncWorker({
      registry: todosRegistry,
      controlPlaneUrl: "http://127.0.0.1:1",
      streamBaseUrl: "http://127.0.0.1:1/v1/stream",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
      // Small enough that the real (uninjectable — the worker has no clock seam) timer fires within the test.
      provisionAdoptionBudgetMs: 50,
      createPglite: () => {
        opens.count += 1;
        return new Promise<ClientPGlite>((resolve) => {
          releaseCreate = () => resolve(makePglite());
        });
      },
    });
    hosts.push(host);

    // The provision rides its OWN connection, exactly as a host mints it (the board: "provision minted on its
    // own connection; the attach adopts that store by storePath"). That matters here: a refused attach runs the
    // full detach, which CLOSES its port — on a shared port the provision's later `provision-ack` would have
    // nowhere to land. The provision does not ack while its create is stuck (that promise is bounded by its
    // OWN deadline, `ProvisionExpiredError`, which is not what this test is about); it is awaited below, AFTER
    // the create is released, as the settlement signal for the second attach.
    const { port2: provisionPort } = connectRaw(host);
    const provision = provisionSyncWorker({
      port: provisionPort as unknown as never,
      ...memoryStoreForTests(storePath),
    });
    void provision.catch(() => undefined);
    const { port2, seen } = connectRaw(host);
    await settle();
    expect(opens.count).toBe(1);

    const refused = await attachSyncClient({
      registry: todosRegistry,
      port: port2 as unknown as never,
      ...memoryStoreForTests(storePath),
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    }).then(
      () => null,
      (error: unknown) => error,
    );

    // It crossed the bridge as the CLASS (tagged detail → rebuilt), carrying the fields a host branches on.
    expect(refused).toBeInstanceOf(ProvisionStalledError);
    const stalled = refused as ProvisionStalledError;
    expect(stalled.storePath).toBe(storePath);
    expect(stalled.budgetMs).toBe(50);
    // The honest measured elapse, not the budget echoed back (a real timer can fire a hair early).
    expect(stalled.elapsedMs).toBeGreaterThan(40);
    expect(stalled.elapsedMs).toBeLessThan(10_000);
    expect(stalled.name).toBe("ProvisionStalledError");
    expect(railLines(seen)).toContain("worker provision adoption stalled — attach refused");
    // The attempt was LEFT RUNNING: no second open was started behind the refusal.
    expect(opens.count).toBe(1);

    // `bootPromise` was cleared by the refusal, so a later attach retries the boot — and the spare it waited
    // on is adopted the moment its create lands (nothing was thrown away). Wait for the provision's OWN
    // settlement (its `provision-ack` is posted after the worker's attempt settled and cleared
    // `provisionAttempt`), not a fixed delay: `makePglite()` is a real memory-PGlite boot, and under a loaded
    // machine a timed wait re-attaches while the create is still landing — refused again at once, because
    // the budget is already spent (the exact behaviour the runbook documents for a too-early retry).
    releaseCreate();
    await provision;
    const { port2: second } = connectRaw(host);
    const client = await attachSyncClient({
      registry: todosRegistry,
      port: second as unknown as never,
      ...memoryStoreForTests(storePath),
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    await client.ready;
    expect(opens.count).toBe(1);
    expect(await host.whenBooted()).toBeDefined();
  });

  it("refuses a non-positive budget at CONSTRUCTION, not at the first sign-in", () => {
    const construct = (provisionAdoptionBudgetMs: number) =>
      defineSyncWorker({
        registry: todosRegistry,
        controlPlaneUrl: "http://127.0.0.1:1",
        streamBaseUrl: "http://127.0.0.1:1/v1/stream",
        batchWriteUrl: "http://127.0.0.1:1/api/mutations",
        syncEnabled: false,
        installGlobal: false,
        provisionAdoptionBudgetMs,
      });
    expect(() => construct(0)).toThrow(/provisionAdoptionBudgetMs must be > 0/);
    expect(() => construct(-1)).toThrow(/provisionAdoptionBudgetMs must be > 0/);
    expect(() => construct(Number.NaN)).toThrow(/provisionAdoptionBudgetMs must be > 0/);
    // The documented escape hatch is accepted (an unbounded wait is a choice, not a mistake).
    const unbounded = construct(Number.POSITIVE_INFINITY);
    hosts.push(unbounded);
    expect(unbounded).toBeDefined();
  });
});

describe("the clone-safe wire form round-trips as the class", () => {
  it("toWire → structuredClone → fromWire rebuilds the typed error with its fields intact", () => {
    const wire = provisionStalledToWire(
      new ProvisionStalledError({ storePath: "wire-store", elapsedMs: 20_137, budgetMs: 20_000 }),
    );
    expect(wire).toEqual({
      code: "provision-stalled",
      storePath: "wire-store",
      elapsedMs: 20_137,
      budgetMs: 20_000,
    });

    const rebuilt = provisionStalledFromWire(structuredClone(wire));
    expect(rebuilt).toBeInstanceOf(ProvisionStalledError);
    expect(rebuilt?.storePath).toBe("wire-store");
    expect(rebuilt?.elapsedMs).toBe(20_137);
    expect(rebuilt?.budgetMs).toBe(20_000);
    expect(rebuilt?.message).toContain("20000ms");
  });

  it("never claims an unrelated, malformed, or absent detail", () => {
    expect(provisionStalledFromWire(undefined)).toBeUndefined();
    expect(provisionStalledFromWire(null)).toBeUndefined();
    expect(provisionStalledFromWire("provision-stalled")).toBeUndefined();
    expect(provisionStalledFromWire({ code: ENGINE_RELOCATED_CODE, outcome: "unknown" })).toBeUndefined();
    expect(provisionStalledFromWire({ code: "provision-stalled", storePath: "s", elapsedMs: 1 })).toBeUndefined();
    expect(
      provisionStalledFromWire({ code: "provision-stalled", storePath: 7, elapsedMs: 1, budgetMs: 2 }),
    ).toBeUndefined();
  });
});

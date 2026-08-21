/**
 * Boot observability (ADR-0034) — the in-process BootReport. Drives the REAL boot pipeline (real PGlite,
 * real engine, real ShapeInbox/commit queue) against a stubbed NETWORK rather than a stubbed engine: the
 * ambient `fetch` answers the real control-plane handlers and a gated durable-streams response, so the
 * report is built from a genuine boot and the test still decides WHEN catch-up completes.
 * Covers: the finalized report's shape + phase durations + per-group rows/requests/fetch/apply; that
 * `bootReport()` is null until initial sync completes; and that `onBootReport` fires exactly once with the
 * same object the method returns. Runs in its own process (ISOLATED) — the fetch stub is process-global.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";

import { integer, text } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable, type StreamEnvelope } from "@pgxsinkit/contracts";
import {
  barrierPath,
  createBarrierHandler,
  createSubscribeHandler,
  importStreamTokenKey,
  subscribePath,
  type CircuitsEngineClient,
} from "@pgxsinkit/server";

import { createBootReportBuilder } from "../../packages/client/src/boot-report";

const registry = defineSyncRegistry({
  widget: defineSyncTable({
    tableName: "widget",
    makeColumns: () => ({ id: integer("id").primaryKey(), name: text("name") }),
  }),
});

const key = await importStreamTokenKey("boot-report-test-secret");

const engine: CircuitsEngineClient = {
  createShape: async (request) => ({
    shapeId: "shape/s1",
    table: request.table,
    streamPath: "shape/s1",
    streamUrl: "http://ds/shape/s1",
  }),
  releaseShape: async () => {},
  replicationState: async () => ({ lsn: "0/0", sync: true, pendingFlips: 0 }),
} as CircuitsEngineClient;

const resolveAuthClaims = () => ({ sub: "boot-report-subject" });
const subscribe = createSubscribeHandler({ registry, engine, key, resolveAuthClaims });
const barrier = createBarrierHandler({ engine, resolveAuthClaims });

/**
 * The catch-up the boot is waiting on, held until a test releases it.
 *
 * The report's whole point is the boundary between "streams subscribed" and "initial sync done", so
 * the stub must be able to sit inside that gap rather than racing through it. Each boot installs a
 * fresh gate; `releaseCatchUp` is what `driveInitialSync` opens.
 */
let catchUpGate: { promise: Promise<void>; release: () => void };
function newCatchUpGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  catchUpGate = { promise, release };
}
newCatchUpGate();

const snapshotEnvelope: StreamEnvelope = {
  type: "widget",
  key: "1",
  value: { id: 1, name: "alpha" },
  headers: { operation: "upsert" },
};

/**
 * The control plane and the edge, served for real on a loopback port.
 *
 * A `globalThis.fetch` stub would be lighter but not sound: the durable-streams client is imported
 * before this file's first line runs, so a swap here is invisible to whatever reference it captured.
 * Two real routes cost a millisecond and cannot go stale that way.
 */
const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch: async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === subscribePath) return subscribe(request);
    if (pathname === barrierPath) return barrier(request);

    // Anything else is the edge. Hold the first delivery until the test opens the gate, then answer
    // with the one snapshot row and a tail offset — a complete catch-up in a single request, which is
    // what makes `requests: 1` / `rows: 1` deterministic.
    await catchUpGate.promise;
    return new Response(JSON.stringify([snapshotEnvelope]), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "Stream-Next-Offset": "0000000000000001",
        "Stream-Up-To-Date": "true",
      },
    });
  },
});
const origin = `http://127.0.0.1:${server.port}`;

const { createSyncClient } = await import("../../packages/client/src/index");
const { memoryStoreForTests } = await import("../../packages/client/src/testing");

let bootId = 0;
// Track booted clients so each is stopped (closing its PGlite) after the test — an un-closed PGlite heap
// leaks and bun force-exits the process rc=99 (see tests/support/setup.ts).
const openClients: Array<{ stop: () => Promise<void> }> = [];
async function bootClient(extra: Record<string, unknown> = {}) {
  newCatchUpGate();
  const client = await createSyncClient({
    registry: registry as never,
    controlPlaneUrl: origin,
    streamBaseUrl: `${origin}/v1/stream`,
    batchWriteUrl: `${origin}/api/mutations`,
    ...memoryStoreForTests(`boot-report-${++bootId}`),
    ...extra,
  } as Parameters<typeof createSyncClient>[0]);
  openClients.push(client);
  // Deliberately NOT awaiting `bootSettled`: it means "sync START done" (ADR-0041), and a start is not
  // done until the group's first catch-up response arrives — which is the very thing the gate is
  // holding. `createSyncClient` has already resolved at `localReadReady`, which is the boundary these
  // tests care about.
  return client;
}

/** Open the gate so the held catch-up lands, then wait for boot to finalize. */
async function driveInitialSync(client: { ready: Promise<void> }) {
  catchUpGate.release();
  await client.ready;
}

describe("BootReport — in-process boot (ADR-0034)", () => {
  afterEach(async () => {
    while (openClients.length > 0)
      await openClients
        .pop()!
        .stop()
        .catch(() => undefined);
  });

  it("finalizes a report with correct version/mode/flags, non-negative phases, and eager-group coverage", async () => {
    const client = await bootClient();
    await driveInitialSync(client);

    const report = await client.bootReport();
    expect(report).not.toBeNull();
    const r = report!;

    expect(r.reportVersion).toBe(1);
    expect(r.mode).toBe("in-process");
    expect(r.freshStore).toBe(false);
    expect(r.overlapPrefetch).toBe(false);

    // ADR-0049 decision 12 diagnostics (additive, `reportVersion` stays 1). This is an in-process boot on the
    // sanctioned memory test lane, so the engine home is `in-process`, the backend derives from the minted
    // `memory://` dataDir scheme, and no opfs→idb fallback occurred (a plain memory boot never sets a reason).
    expect(r.engineHome).toBe("in-process");
    expect(r.storageBackend).toBe("memory");
    expect(r.storageFallbackReason).toBeUndefined();
    expect(typeof r.registryFingerprint).toBe("string");
    expect(r.registryFingerprint.length).toBeGreaterThan(0);
    expect(typeof r.startedAt).toBe("number");

    // Phases: all non-negative, schema exec measurably positive, and the client created its own store so
    // pgliteCreateMs is a real number (no spare adoption → provision null).
    expect(r.provision).toBeNull();
    expect(r.phases.pgliteCreateMs).not.toBeNull();
    expect(r.phases.pgliteCreateMs!).toBeGreaterThanOrEqual(0);
    expect(r.phases.schemaExecMs).toBeGreaterThan(0);
    expect(r.phases.journalRecoveryMs).toBeGreaterThanOrEqual(0);
    expect(r.phases.storeVersionReconcileMs).toBeGreaterThanOrEqual(0);
    expect(r.phases.syncStartMs).toBeGreaterThanOrEqual(0);
    expect(r.phases.catchupMs).toBeGreaterThanOrEqual(0);

    // totalMs bounds each individually-timed phase (they run sequentially within the boot).
    expect(r.totalMs).toBeGreaterThanOrEqual(r.phases.schemaExecMs);
    expect(r.totalMs).toBeGreaterThanOrEqual(r.phases.journalRecoveryMs);
    expect(r.totalMs).toBeGreaterThanOrEqual(r.phases.storeVersionReconcileMs);
    expect(r.totalMs).toBeGreaterThanOrEqual(r.phases.pgliteCreateMs!);

    // One eager group, covering the single served shape.
    expect(r.groups).toHaveLength(1);
    const group = r.groups[0]!;
    expect(group.tables).toBe(1);
    expect(group.requests).toBe(1); // one delivered batch (snapshot + up-to-date)
    expect(group.rows).toBe(1); // one snapshot change row
    expect(group.fetchMs).toBeGreaterThanOrEqual(0);
    expect(group.applyMs).toBeGreaterThanOrEqual(0);
    expect(group.readyAtMs).toBeGreaterThanOrEqual(group.startedAtMs);
  });

  it("stamps storeKind='warm' and honest current-truth warmBoot flags on a default (existing-store) boot", async () => {
    const client = await bootClient();
    await driveInitialSync(client);

    const r = (await client.bootReport())!;
    // No restore, no fresh-store hint → the common warm (existing persisted store) case.
    expect(r.storeKind).toBe("warm");
    // freshStore stays a bare boolean, additive alongside storeKind (never removed).
    expect(r.freshStore).toBe(false);

    // This is a FIRST boot on a new store, so no `local_schema_fingerprint` is stamped yet: the durable
    // replay runs (the fingerprint fast path misses) and, with no recovery marker, the initialization recovery
    // pass runs too. Both skip flags are therefore false; the recovered-row count is unavailable on this path.
    expect(r.warmBoot.schemaSkipped).toBe(false);
    expect(r.warmBoot.schemaFingerprintMatch).toBe(false);
    expect(r.warmBoot.journalRecoverySkipped).toBe(false);
    expect(r.warmBoot.journalRecoveryRequired).toBe(true);
    // The `widget` registry has one READONLY table (default mode), so no writable journal is visited.
    expect(r.warmBoot.journalTablesVisited).toBe(0);
    expect(r.warmBoot.journalRowsRecovered).toBeNull();
  });

  it("stamps storeKind='fresh' when the caller proves the store a fresh spare", async () => {
    // The fresh-store hint marks a schemaless spare. Boot offline (syncEnabled:false) so the report finalizes
    // at `ready` without driving the stream — storeKind derivation does not depend on sync being online.
    const client = await bootClient({ freshStore: true, syncEnabled: false });
    await client.ready;

    const r = (await client.bootReport())!;
    expect(r.storeKind).toBe("fresh");
    expect(r.freshStore).toBe(true);
  });

  it("bootReport() is null before initial sync completes, and the report thereafter", async () => {
    const client = await bootClient();
    // The local-read core is up but no batch has been delivered — no initial sync, so no report yet.
    expect(await client.bootReport()).toBeNull();

    await driveInitialSync(client);
    expect(await client.bootReport()).not.toBeNull();
  });

  it("onBootReport fires exactly once with the same object the method returns", async () => {
    const seen: unknown[] = [];
    const client = await bootClient({ onBootReport: (report: unknown) => seen.push(report) });

    expect(seen).toHaveLength(0); // not before initial sync
    await driveInitialSync(client);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(await client.bootReport()); // same object identity (===)
  });
});

// ADR-0049 decision 12 — the additive engine-placement diagnostics stamped onto the BootReport. These drive the
// builder directly (no boot pipeline) so the field plumbing — init `engineHome`, the `setStorageBackend` /
// `setStorageFallbackReason` setters, and the "only present when stamped" additive contract — is proven in
// isolation, exactly where a Bun process cannot reach a real opfs→idb fallback (no OPFS/WASM off-browser).
describe("BootReport — engine-placement diagnostics (ADR-0049 decision 12)", () => {
  const baseInit = {
    mode: "in-process" as const,
    freshStore: false,
    storeKind: "warm" as const,
    overlapPrefetch: false,
    registryFingerprint: "fp",
  };

  it("omits every diagnostics field by default — additive, so an unstamped boot carries none of them", () => {
    const report = createBootReportBuilder(baseInit).finalize();
    expect(report.reportVersion).toBe(1); // additive fields keep the version
    expect(report.engineHome).toBeUndefined();
    expect(report.storageBackend).toBeUndefined();
    expect(report.storageFallbackReason).toBeUndefined();
  });

  it("stamps engineHome from init and storageBackend/storageFallbackReason from the setters", () => {
    const builder = createBootReportBuilder({ ...baseInit, mode: "worker", engineHome: "elected-worker" });
    builder.setStorageBackend("idbfs");
    builder.setStorageFallbackReason("recordless idb store opened in place (invariant 14)");
    const report = builder.finalize();

    expect(report.reportVersion).toBe(1);
    expect(report.engineHome).toBe("elected-worker");
    expect(report.storageBackend).toBe("idbfs");
    expect(report.storageFallbackReason).toBe("recordless idb store opened in place (invariant 14)");
  });

  it("carries a `shared-worker` engine home + `opfs-repacked` backend with no fallback (the SW-direct boot)", () => {
    const builder = createBootReportBuilder({ ...baseInit, mode: "worker", engineHome: "shared-worker" });
    builder.setStorageBackend("opfs-repacked");
    const report = builder.finalize();

    expect(report.engineHome).toBe("shared-worker");
    expect(report.storageBackend).toBe("opfs-repacked");
    // No fallback on the granted opfs home — the reason field stays absent (never set on a non-fallback boot).
    expect(report.storageFallbackReason).toBeUndefined();
  });
});

afterAll(async () => {
  await server.stop(true);
});

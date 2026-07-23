import { describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 11b: the ADOPTION BOOT WIRING. Step 11a's orchestrator is a
// pure, effect-injected sequence (adoption.ts, adoption.test.ts); THIS suite proves the boot-path decision that
// wires it — `runBootAdoption` (the automatic, declaration-gated boot decision) and `adoptStore` (the manual
// creation-path API) — over INJECTED seams, so the whole contract is exercised with NO real IndexedDB / OPFS /
// WASM. The seams (`idbStoreExists`, `resolveStoreBoot`, `buildEffects`, `isStoreLive`, `log`) are faked; a
// recording effects fake proves the exact transition order and the resolved boot backend (`bootHasOpfs`).
//
// Coverage: declared + drained journal → transition runs in order, boot lands on opfs; undeclared → no
// transition, idb boot; owed journal → idb boot (deferred); gate-failed (throw) → idb boot + teardown ran;
// not-eligible verdict → the classifier's backend is honoured; manual `adoptStore` happy path + refuses a store a
// live client holds (`StoreInUseError`).

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import type { AdoptionEffects } from "../../packages/client/src/adoption";
import {
  type AdoptStoreOptions,
  adoptStore,
  type AdoptionWiringSeams,
  runBootAdoption,
  StoreInUseError,
} from "../../packages/client/src/index";
import type { StoreBootResolution } from "../../packages/client/src/store-boot";
import type { JournalStatusCounts } from "../../packages/client/src/store-lifecycle";

// ── recording effects fake (mirrors adoption.test.ts) ───────────────────────────────────────────────────
function drained(overrides: Partial<JournalStatusCounts> = {}): JournalStatusCounts {
  return { pending: 0, sending: 0, acked: 0, failed: 0, quarantined: 0, conflicted: 0, rejected: 0, ...overrides };
}

const FULL_ORDER = [
  "bootIdbPreExpose",
  "strictSyncAndCloseIdb",
  "setPhase:adopting",
  "buildCandidateThroughGate",
  "commitCandidate",
  "deleteIdbPredecessor",
];

function fakeEffects(opts: { counts?: JournalStatusCounts; throwOn?: string } = {}): {
  effects: AdoptionEffects;
  calls: string[];
} {
  const calls: string[] = [];
  const record = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    if (opts.throwOn === name) return Promise.reject(new Error(`fake-${name}-failure`));
    return Promise.resolve(value);
  };
  const effects: AdoptionEffects = {
    bootIdbPreExpose: () => record("bootIdbPreExpose", opts.counts ?? drained()),
    strictSyncAndCloseIdb: () => record("strictSyncAndCloseIdb", undefined),
    setPhase: (phase) => record(`setPhase:${phase}`, undefined),
    buildCandidateThroughGate: () => record("buildCandidateThroughGate", undefined),
    commitCandidate: () => record("commitCandidate", undefined),
    deleteIdbPredecessor: () => record("deleteIdbPredecessor", undefined),
    teardownCandidate: () => record("teardownCandidate", undefined),
  };
  return { effects, calls };
}

const idbAuthoritative: StoreBootResolution = {
  dataDir: "idb://pgxsinkit-x",
  storageBackend: "idbfs",
  verdict: { action: "boot-idb-authoritative" },
};
const committed: StoreBootResolution = {
  dataDir: "opfs://pgxsinkit-x",
  storageBackend: "opfs-repacked",
  verdict: { action: "open-committed" },
};

const registry = {} as unknown as SyncTableRegistry;

function seams(over: Partial<AdoptionWiringSeams> & { effects?: AdoptionEffects } = {}): {
  seams: AdoptionWiringSeams;
  logs: { message: string; data?: Record<string, unknown> }[];
} {
  const logs: { message: string; data?: Record<string, unknown> }[] = [];
  return {
    seams: {
      idbStoreExists: over.idbStoreExists ?? (() => Promise.resolve(true)),
      resolveStoreBoot: over.resolveStoreBoot ?? (() => Promise.resolve(idbAuthoritative)),
      ...(over.effects ? { buildEffects: () => over.effects! } : {}),
      ...(over.buildEffects ? { buildEffects: over.buildEffects } : {}),
      log: (message, data) => logs.push({ message, ...(data ? { data } : {}) }),
    },
    logs,
  };
}

const ctx = { registry, electricUrl: "e", batchWriteUrl: "/api/mutations", syncEnabled: true };

// ─── runBootAdoption — the automatic, declaration-gated boot decision ───────────────────────────────────

describe("runBootAdoption — declaration-gated automatic adoption (ADR-0049 step 11b)", () => {
  it("declared + drained journal → the full transition runs IN ORDER and the boot lands on opfs", async () => {
    const { effects, calls } = fakeEffects({ counts: drained() });
    const { seams: s } = seams({ effects });
    const result = await runBootAdoption("store-x", "server-reconstructible", ctx, s);

    expect(result.bootHasOpfs).toBe(true);
    expect(result.outcome).toEqual({ adopted: true });
    expect(calls).toEqual(FULL_ORDER);
  });

  it("undeclared (declaration undefined) → NO transition runs and the boot stays idb", async () => {
    const { effects, calls } = fakeEffects();
    const { seams: s } = seams({ effects });
    const result = await runBootAdoption("store-x", undefined, ctx, s);

    // Not eligible (no declaration) → the classifier's idb backend is honoured; the transition never ran.
    expect(result.bootHasOpfs).toBe(false);
    expect(result.outcome).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("owed journal (drain predicate fails) → adoption DEFERS; boot stays idb (only the drain probe ran)", async () => {
    const { effects, calls } = fakeEffects({ counts: drained({ pending: 2 }) });
    const { seams: s } = seams({ effects });
    const result = await runBootAdoption("store-x", "server-reconstructible", ctx, s);

    expect(result.bootHasOpfs).toBe(false);
    expect(result.outcome).toEqual({ adopted: false, reason: "journal-owed" });
    expect(calls).toEqual(["bootIdbPreExpose"]);
  });

  it("gate-failed (buildCandidateThroughGate throws) → boot stays idb; the candidate was torn down", async () => {
    const { effects, calls } = fakeEffects({ counts: drained(), throwOn: "buildCandidateThroughGate" });
    const { seams: s } = seams({ effects });
    const result = await runBootAdoption("store-x", "server-reconstructible", ctx, s);

    expect(result.bootHasOpfs).toBe(false);
    expect(result.outcome?.adopted).toBe(false);
    expect(result.outcome).toMatchObject({ reason: "gate-failed" });
    // The transition tore the candidate down and reset the phase to idb-authoritative (plan gate-unmet row).
    expect(calls).toContain("teardownCandidate");
    expect(calls).toContain("setPhase:idb-authoritative");
    expect(calls).not.toContain("commitCandidate");
  });

  it("no idb predecessor → adoption never runs; boot stays on the opfs grant", async () => {
    const { effects, calls } = fakeEffects();
    const { seams: s } = seams({ effects, idbStoreExists: () => Promise.resolve(false) });
    const result = await runBootAdoption("store-x", "server-reconstructible", ctx, s);

    expect(result.bootHasOpfs).toBe(true);
    expect(calls).toEqual([]);
  });

  it("idb present but the verdict is committed-opfs (not eligible) → boot opens the committed opfs store", async () => {
    const { effects, calls } = fakeEffects();
    const { seams: s } = seams({ effects, resolveStoreBoot: () => Promise.resolve(committed) });
    const result = await runBootAdoption("store-x", "server-reconstructible", ctx, s);

    expect(result.bootHasOpfs).toBe(true);
    expect(calls).toEqual([]); // no transition — the classifier already resolved the backend
  });
});

// ─── adoptStore — the manual creation-path API ──────────────────────────────────────────────────────────

function manualOptions(over: Partial<AdoptStoreOptions<SyncTableRegistry>> = {}): AdoptStoreOptions<SyncTableRegistry> {
  return { registry, electricUrl: "e", batchWriteUrl: "/api/mutations", storePath: "store-x", ...over };
}

describe("adoptStore — the manual, creation-path adoption API (ADR-0049 step 11b)", () => {
  it("happy path: runs the full transition and reports adopted", async () => {
    const { effects, calls } = fakeEffects({ counts: drained() });
    const outcome = await adoptStore(
      manualOptions({ seams: { buildEffects: () => effects, isStoreLive: () => false } }),
    );

    expect(outcome).toEqual({ adopted: true });
    expect(calls).toEqual(FULL_ORDER);
  });

  it("owed journal defers even the manual API (a store that owes the server is not adoptable)", async () => {
    const { effects, calls } = fakeEffects({ counts: drained({ conflicted: 1 }) });
    const outcome = await adoptStore(
      manualOptions({ seams: { buildEffects: () => effects, isStoreLive: () => false } }),
    );

    expect(outcome).toEqual({ adopted: false, reason: "journal-owed" });
    expect(calls).toEqual(["bootIdbPreExpose"]);
  });

  it("REFUSES while a live client holds the store (StoreInUseError)", async () => {
    const { effects, calls } = fakeEffects({ counts: drained() });
    let refusal: unknown;
    await adoptStore(manualOptions({ seams: { buildEffects: () => effects, isStoreLive: () => true } })).catch(
      (error: unknown) => {
        refusal = error;
      },
    );
    expect(refusal).toBeInstanceOf(StoreInUseError);
    // Refused BEFORE any effect ran — nothing touched the store.
    expect(calls).toEqual([]);
  });
});

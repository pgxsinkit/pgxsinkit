import { describe, expect, it } from "bun:test";
// Unit coverage for the worker-owned live-query manager (ADR-0040 Slices 2 & 3) driven by a FAKE `live`
// namespace — no WASM PGlite. Slice 2 pins the extracted lifecycle (registration/listener/unsubscribe
// sequencing, `dispose()` awaiting every teardown, `refresh()` coalescing, dispose racing an in-flight setup).
// Slice 3 pins DEDUPLICATION: identical fingerprints share ONE registration fanned to many subscribers,
// distinct fingerprints get distinct registrations, single-flight setup/teardown, failed-setup rejection, and
// the join-atomically path (a mid-stream joiner gets the current rows then subsequent diffs, none missed).

import { setSyncDebugSink } from "../../packages/client/src/debug";
import {
  createLiveQueryManager,
  type LiveDiffWire,
  type LiveQueryManagerDeps,
  type LiveSubscriber,
} from "../../packages/client/src/worker/live-query-manager";

type Row = Record<string, unknown>;

/** A controllable stand-in for a PGlite `LiveQuery`: manual change emission, refresh, and unsubscribe gating. */
class FakeLiveQuery {
  readonly initialResults: { rows: Row[] };
  private readonly listeners = new Set<(r: { rows: Row[] }) => void>();
  unsubscribeCount = 0;
  refreshCount = 0;
  holdUnsubscribe = false;
  failUnsubscribe = false;
  private readonly unsubscribeResolvers: Array<() => void> = [];
  private readonly refreshResolvers: Array<() => void> = [];

  constructor(rows: Row[]) {
    this.initialResults = { rows };
  }

  subscribe = (cb: (r: { rows: Row[] }) => void): void => {
    this.listeners.add(cb);
  };

  unsubscribe = (cb?: (r: { rows: Row[] }) => void): Promise<void> => {
    this.unsubscribeCount++;
    if (cb) this.listeners.delete(cb);
    else this.listeners.clear();
    if (this.failUnsubscribe) return Promise.reject(new Error("unsubscribe failed"));
    if (this.holdUnsubscribe) return new Promise<void>((resolve) => this.unsubscribeResolvers.push(resolve));
    return Promise.resolve();
  };

  refresh = (): Promise<void> => {
    this.refreshCount++;
    return new Promise<void>((resolve) => this.refreshResolvers.push(resolve));
  };

  /** Fire a change to every subscribed listener (the "real change" path — never the initial). */
  emit(rows: Row[]): void {
    for (const listener of this.listeners) listener({ rows });
  }

  resolveRefresh(): void {
    this.refreshResolvers.shift()?.();
  }

  resolveUnsubscribe(): void {
    this.unsubscribeResolvers.shift()?.();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** A fake `live` namespace: records registrations and can hold them pending (for the setup-race test). */
class FakeLive {
  readonly queries: FakeLiveQuery[] = [];
  initialRows: Row[] = [];
  manualRegistration = false;
  queryCalls = 0;
  incrementalCalls = 0;
  private readonly pending: Array<{
    resolve: (query: FakeLiveQuery) => void;
    reject: (error: unknown) => void;
    query: FakeLiveQuery;
  }> = [];

  query = (_sql: string, _params?: unknown[] | null): Promise<FakeLiveQuery> => {
    this.queryCalls++;
    return this.register();
  };

  incrementalQuery = (_sql: string, _params: unknown[] | null | undefined, _key: string): Promise<FakeLiveQuery> => {
    this.incrementalCalls++;
    return this.register();
  };

  private register(): Promise<FakeLiveQuery> {
    const query = new FakeLiveQuery([...this.initialRows]);
    this.queries.push(query);
    if (this.manualRegistration) {
      return new Promise<FakeLiveQuery>((resolve, reject) => this.pending.push({ resolve, reject, query }));
    }
    return Promise.resolve(query);
  }

  completeRegistration(): void {
    const next = this.pending.shift();
    next?.resolve(next.query);
  }

  failRegistration(error: unknown = new Error("registration failed")): void {
    this.pending.shift()?.reject(error);
  }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** A deterministic clock + timer wheel injected into the manager so keep-alive is testable with NO real sleeps. */
class FakeTimers {
  private t = 0;
  private seq = 0;
  private readonly timers = new Map<number, { fireAt: number; callback: () => void }>();

  now = (): number => this.t;

  setTimer = (callback: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.set(id, { fireAt: this.t + ms, callback });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Advance the clock by `ms` and fire every timer now due, earliest first. */
  advance(ms: number): void {
    this.t += ms;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.fireAt <= this.t)
      .sort((a, b) => a[1].fireAt - b[1].fireAt);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.callback();
    }
  }

  get pending(): number {
    return this.timers.size;
  }
}

function makeManager(fake: FakeLive) {
  return createLiveQueryManager({ live: fake as unknown as LiveQueryManagerDeps["live"] });
}

function makeKeepAliveManager(fake: FakeLive, policy: NonNullable<LiveQueryManagerDeps["policy"]>) {
  const timers = new FakeTimers();
  const manager = createLiveQueryManager({
    live: fake as unknown as LiveQueryManagerDeps["live"],
    policy,
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { manager, timers };
}

function collector(): { subscriber: LiveSubscriber; initials: Row[][]; diffs: LiveDiffWire[] } {
  const initials: Row[][] = [];
  const diffs: LiveDiffWire[] = [];
  return {
    initials,
    diffs,
    subscriber: {
      deliverInitial: (rows) => initials.push([...rows]),
      deliverDiff: (diff) => diffs.push(diff),
    },
  };
}

/** Capture a promise's rejection message (or a sentinel if it resolved) — avoids the `expect().rejects` lint. */
async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "<resolved, expected rejection>";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("live-query manager (ADR-0040 Slice 2)", () => {
  it("registers, delivers the initial snapshot then diffs, and stops delivering after unsubscribe", async () => {
    const fake = new FakeLive();
    fake.initialRows = [{ id: "1", v: "a" }];
    const manager = makeManager(fake);
    const { subscriber, initials, diffs } = collector();

    const sub = await manager.subscribe({ materialSql: "select * from t", params: [], pkColumns: ["id"] }, subscriber);

    // Single-column PK routes to `incrementalQuery`; the initial snapshot is delivered verbatim, no diff yet.
    expect(fake.incrementalCalls).toBe(1);
    expect(fake.queryCalls).toBe(0);
    expect(fake.queries).toHaveLength(1);
    expect(initials).toEqual([[{ id: "1", v: "a" }]]);
    expect(diffs).toHaveLength(0);
    expect(fake.queries[0]!.listenerCount).toBe(1);

    // A real change fires exactly one diff, keyed by the PK.
    fake.queries[0]!.emit([{ id: "1", v: "b" }]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.changed.map((c) => c.key)).toEqual(["1"]);

    // Unsubscribe removes the listener and tears down the registration.
    await sub.unsubscribe();
    expect(fake.queries[0]!.unsubscribeCount).toBe(1);
    expect(fake.queries[0]!.listenerCount).toBe(0);

    // No further deliveries after unsubscribe.
    fake.queries[0]!.emit([{ id: "1", v: "c" }]);
    expect(diffs).toHaveLength(1);
  });

  it("routes a keyless (no pkColumns) subscription to live.query", async () => {
    const fake = new FakeLive();
    const manager = makeManager(fake);
    const { subscriber } = collector();

    await manager.subscribe({ materialSql: "select * from t", params: [] }, subscriber);
    expect(fake.queryCalls).toBe(1);
    expect(fake.incrementalCalls).toBe(0);
  });

  it("dispose() tears down every registration and awaits all teardowns before resolving", async () => {
    const fake = new FakeLive();
    const manager = makeManager(fake);
    const { subscriber } = collector();

    await manager.subscribe({ materialSql: "select 1", params: [] }, subscriber);
    await manager.subscribe({ materialSql: "select 2", params: [] }, subscriber);
    expect(fake.queries).toHaveLength(2);

    // Both teardowns are held open — dispose() must NOT resolve until they settle (the close-vs-unsubscribe
    // hang guard: a still-pending unsubscribe when the engine closes wedges the process forever).
    for (const query of fake.queries) query.holdUnsubscribe = true;

    let disposed = false;
    const disposePromise = manager.dispose().then(() => {
      disposed = true;
    });

    // A macrotask passes; dispose is still pending because both teardowns are outstanding.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(disposed).toBe(false);
    expect(fake.queries.every((q) => q.unsubscribeCount === 1)).toBe(true);

    // Settle the teardowns → dispose resolves.
    for (const query of fake.queries) query.resolveUnsubscribe();
    await disposePromise;
    expect(disposed).toBe(true);
  });

  it("coalesces concurrent refresh() calls into one underlying live.refresh()", async () => {
    const fake = new FakeLive();
    const manager = makeManager(fake);
    const { subscriber } = collector();

    const sub = await manager.subscribe({ materialSql: "select 1", params: [] }, subscriber);
    const query = fake.queries[0]!;

    // Two refreshes while the first is in flight share ONE underlying refresh (no N-stacking of full reruns).
    const first = sub.refresh();
    const second = sub.refresh();
    expect(query.refreshCount).toBe(1);

    query.resolveRefresh();
    await Promise.all([first, second]);

    // Once settled, a later refresh starts a fresh underlying refresh.
    const third = sub.refresh();
    expect(query.refreshCount).toBe(2);
    query.resolveRefresh();
    await third;
  });

  it("handles dispose() racing an in-flight setup: the late registration self-tears-down, no leak", async () => {
    const fake = new FakeLive();
    fake.manualRegistration = true;
    const manager = makeManager(fake);
    const { subscriber, initials } = collector();

    // Start a subscribe whose registration has NOT resolved yet.
    const subPromise = manager.subscribe({ materialSql: "select 1", params: [] }, subscriber);

    // Dispose now — it must wait out the in-flight setup rather than miss it.
    let disposed = false;
    const disposePromise = manager.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(disposed).toBe(false);

    // Complete the registration: the subscribe finishes, sees the manager disposed, and tears itself down.
    fake.completeRegistration();
    const sub = await subPromise;
    await disposePromise;

    expect(disposed).toBe(true);
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]!.unsubscribeCount).toBe(1); // the late registration did not leak
    expect(initials).toHaveLength(1); // it still delivered its snapshot deterministically

    // The returned subscription is inert: unsubscribe is idempotent, refresh is a no-op on a torn entry.
    await sub.unsubscribe();
    expect(fake.queries[0]!.unsubscribeCount).toBe(1);
    await sub.refresh();
    expect(fake.queries[0]!.refreshCount).toBe(0);
  });
});

describe("live-query manager deduplication (ADR-0040 Slice 3)", () => {
  const pkSpec = { materialSql: "select * from t", params: [] as unknown[], pkColumns: ["id"] as const };

  it("dedups identical subscriptions to ONE registration, fans diffs to all, tears down on the last out", async () => {
    const fake = new FakeLive();
    fake.initialRows = [{ id: "1", v: "a" }];
    const manager = makeManager(fake);
    const a = collector();
    const b = collector();

    const subA = await manager.subscribe({ ...pkSpec }, a.subscriber);
    const subB = await manager.subscribe({ ...pkSpec }, b.subscriber);

    // ONE PGlite registration, ONE listener — shared by both subscribers (decision 2).
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]!.listenerCount).toBe(1);
    expect(a.initials).toEqual([[{ id: "1", v: "a" }]]);
    expect(b.initials).toEqual([[{ id: "1", v: "a" }]]);

    // A change is computed once and fans out to BOTH.
    fake.queries[0]!.emit([{ id: "1", v: "b" }]);
    expect(a.diffs).toHaveLength(1);
    expect(b.diffs).toHaveLength(1);

    // Unsubscribing one leaves the other live; the registration is NOT torn down.
    await subA.unsubscribe();
    expect(fake.queries[0]!.unsubscribeCount).toBe(0);
    fake.queries[0]!.emit([{ id: "1", v: "c" }]);
    expect(a.diffs).toHaveLength(1); // A no longer receives
    expect(b.diffs).toHaveLength(2); // B still live

    // Final unsubscribe tears the shared registration down (awaited).
    await subB.unsubscribe();
    expect(fake.queries[0]!.unsubscribeCount).toBe(1);
  });

  it("gives distinct SQL / params / pkColumns / Date-vs-ISO their own registrations", async () => {
    const fake = new FakeLive();
    const manager = makeManager(fake);
    const c = collector();
    const date = new Date("2026-01-01T00:00:00.000Z");

    // Param-bearing specs use a matching `$1` placeholder so they satisfy the #1055 param guard (a param
    // with no placeholder would now be rejected at the boundary); the distinctness under test is unchanged.
    await manager.subscribe({ materialSql: "select 1", params: [] }, c.subscriber);
    await manager.subscribe({ materialSql: "select 2", params: [] }, c.subscriber);
    await manager.subscribe({ materialSql: "select $1", params: ["x"] }, c.subscriber);
    await manager.subscribe({ materialSql: "select 1", params: [], pkColumns: ["id"] }, c.subscriber);
    await manager.subscribe({ materialSql: "select $1 as d", params: [date] }, c.subscriber);
    await manager.subscribe({ materialSql: "select $1 as d", params: [date.toISOString()] }, c.subscriber);
    expect(fake.queries).toHaveLength(6);

    // An identical repeat dedups onto the first — no new registration.
    await manager.subscribe({ materialSql: "select 1", params: [] }, c.subscriber);
    expect(fake.queries).toHaveLength(6);
  });

  it("shares ONE registration across concurrent subscribes during setup (single-flight)", async () => {
    const fake = new FakeLive();
    fake.manualRegistration = true;
    fake.initialRows = [{ id: "1", v: "a" }];
    const manager = makeManager(fake);
    const a = collector();
    const b = collector();

    const pa = manager.subscribe({ ...pkSpec }, a.subscriber);
    const pb = manager.subscribe({ ...pkSpec }, b.subscriber); // joins A's in-flight setup
    await tick();
    expect(fake.queries).toHaveLength(1); // one registration attempt, shared

    fake.completeRegistration();
    await Promise.all([pa, pb]);
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]!.listenerCount).toBe(1);
    expect(a.initials).toHaveLength(1);
    expect(b.initials).toHaveLength(1);

    // Both share the registration; a diff reaches both.
    fake.queries[0]!.emit([{ id: "1", v: "b" }]);
    expect(a.diffs).toHaveLength(1);
    expect(b.diffs).toHaveLength(1);
  });

  it("resubscribe during teardown waits it out, then builds a fresh entry (no overlap)", async () => {
    const fake = new FakeLive();
    fake.initialRows = [{ id: "1", v: "a" }];
    const manager = makeManager(fake);

    const subA = await manager.subscribe({ ...pkSpec }, collector().subscriber);
    expect(fake.queries).toHaveLength(1);
    fake.queries[0]!.holdUnsubscribe = true;

    const teardownPromise = subA.unsubscribe(); // last out → teardown starts, held open
    const b = collector();
    const subBPromise = manager.subscribe({ ...pkSpec }, b.subscriber);

    // B is blocked on the in-flight teardown — no fresh registration yet.
    await tick();
    expect(fake.queries).toHaveLength(1);

    // Release the teardown → B proceeds onto a fresh registration.
    fake.queries[0]!.resolveUnsubscribe();
    await teardownPromise;
    const subB = await subBPromise;
    expect(fake.queries).toHaveLength(2);
    expect(b.initials).toHaveLength(1);
    await subB.unsubscribe();
  });

  it("failed setup rejects every joined waiter, removes the entry, and a later subscribe builds fresh", async () => {
    const fake = new FakeLive();
    fake.manualRegistration = true;
    const manager = makeManager(fake);
    const a = collector();
    const b = collector();

    const pa = manager.subscribe({ materialSql: "select 1", params: [] }, a.subscriber);
    const pb = manager.subscribe({ materialSql: "select 1", params: [] }, b.subscriber);
    await tick();
    expect(fake.queries).toHaveLength(1);

    fake.failRegistration(new Error("boom"));
    let aRejected = "";
    let bRejected = "";
    await pa.catch((error) => (aRejected = (error as Error).message));
    await pb.catch((error) => (bRejected = (error as Error).message));
    expect(aRejected).toBe("boom");
    expect(bRejected).toBe("boom");

    // The failed entry was removed: a later subscribe builds a fresh registration and succeeds.
    fake.manualRegistration = false;
    const c = collector();
    const subC = await manager.subscribe({ materialSql: "select 1", params: [] }, c.subscriber);
    expect(c.initials).toHaveLength(1);
    await subC.unsubscribe();
  });

  it("a subscriber joining mid-stream gets the CURRENT rows, then only subsequent diffs (join-atomically)", async () => {
    const fake = new FakeLive();
    fake.initialRows = [{ id: "1", v: "a" }];
    const manager = makeManager(fake);
    const a = collector();
    const subA = await manager.subscribe({ ...pkSpec }, a.subscriber);

    // Advance the SHARED state before B joins (only A is subscribed here).
    fake.queries[0]!.emit([
      { id: "1", v: "b" },
      { id: "2", v: "z" },
    ]);
    expect(a.diffs).toHaveLength(1);

    // B joins: its initial snapshot must be the CURRENT rows, not the original — served from the diff state.
    const b = collector();
    const subB = await manager.subscribe({ ...pkSpec }, b.subscriber);
    expect(b.initials).toEqual([
      [
        { id: "1", v: "b" },
        { id: "2", v: "z" },
      ],
    ]);

    // A further change reaches BOTH; B's first diff transforms exactly its just-delivered initial (no miss,
    // no duplicate) — only id=1 changed since B joined.
    fake.queries[0]!.emit([
      { id: "1", v: "c" },
      { id: "2", v: "z" },
    ]);
    expect(a.diffs).toHaveLength(2);
    expect(b.diffs).toHaveLength(1);
    expect(b.diffs[0]!.changed.map((change) => change.key)).toEqual(["1"]);

    await subA.unsubscribe();
    await subB.unsubscribe();
  });
});

describe("live-query manager bounded keep-alive (ADR-0040 Slice 4)", () => {
  const spec = (materialSql: string) => ({ materialSql, params: [] as unknown[], pkColumns: ["id"] as const });
  const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, v: id }));

  it("retains a zero-subscriber entry within grace and reuses it on resubscribe (no second registration)", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const { manager, timers } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 1000 });
    const a = collector();

    const subA = await manager.subscribe(spec("select 1"), a.subscriber);
    await subA.unsubscribe();
    // Last-out with a nonzero keep-alive → retained, NOT torn: registration stays, an eviction timer is armed.
    expect(fake.queries[0]!.unsubscribeCount).toBe(0);
    expect(timers.pending).toBe(1);

    // Resubscribe the SAME fingerprint within the grace window → reuse the retained registration verbatim.
    const b = collector();
    const subB = await manager.subscribe(spec("select 1"), b.subscriber);
    expect(fake.queries).toHaveLength(1); // NO second registration
    expect(b.initials).toEqual([rows("1")]); // snapshot served from the still-current diff state
    expect(timers.pending).toBe(0); // eviction cancelled — entry is active again

    // Still live: a change reaches the rejoined subscriber.
    fake.queries[0]!.emit(rows("1", "2"));
    expect(b.diffs).toHaveLength(1);
    await subB.unsubscribe();
  });

  it("evicts on timer expiry, then a later resubscribe builds a fresh registration", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const { manager, timers } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 1000 });

    const subA = await manager.subscribe(spec("select 1"), collector().subscriber);
    await subA.unsubscribe();
    expect(fake.queries[0]!.unsubscribeCount).toBe(0);

    // Grace elapses → the timer fires and tears the entry down.
    timers.advance(1000);
    await tick();
    expect(fake.queries[0]!.unsubscribeCount).toBe(1);

    // A later resubscribe re-registers from scratch.
    const b = collector();
    const subB = await manager.subscribe(spec("select 1"), b.subscriber);
    expect(fake.queries).toHaveLength(2);
    expect(b.initials).toHaveLength(1);
    await subB.unsubscribe();
  });

  it("evicts the LRU retained entry under the COUNT budget; the most-recently-used survives", async () => {
    const fake = new FakeLive();
    const { manager, timers } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 10_000, maxRetainedQueries: 1 });

    fake.initialRows = rows("a");
    const subA = await manager.subscribe(spec("select A"), collector().subscriber);
    await subA.unsubscribe(); // A retained (lastUsedAt = t0)
    timers.advance(1); // t advances; A's 10s timer not due

    fake.initialRows = rows("b");
    const subB = await manager.subscribe(spec("select B"), collector().subscriber);
    await subB.unsubscribe(); // B retained (lastUsedAt = t1) → count 2 > 1 → evict LRU (A)
    await tick();

    // A (older) was evicted; B (newer) survives.
    expect(fake.queries[0]!.unsubscribeCount).toBe(1); // A torn down
    expect(fake.queries[1]!.unsubscribeCount).toBe(0); // B retained
    // Resubscribing A re-registers (fresh); resubscribing B reuses.
    const reB = await manager.subscribe(spec("select B"), collector().subscriber);
    expect(fake.queries).toHaveLength(2); // B reused — no new registration
    await reB.unsubscribe();
  });

  it("evicts the LRU retained entry under the ROW budget", async () => {
    const fake = new FakeLive();
    const { manager, timers } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 10_000, maxRetainedRows: 5 });

    fake.initialRows = rows("a1", "a2", "a3"); // 3 rows
    const subA = await manager.subscribe(spec("select A"), collector().subscriber);
    await subA.unsubscribe(); // retained, total rows 3 ≤ 5
    timers.advance(1);
    expect(fake.queries[0]!.unsubscribeCount).toBe(0);

    fake.initialRows = rows("b1", "b2", "b3"); // 3 rows → total would be 6 > 5
    const subB = await manager.subscribe(spec("select B"), collector().subscriber);
    await subB.unsubscribe();
    await tick();

    // Total 6 > 5 → evict LRU (A); B (3 rows) is within budget and survives.
    expect(fake.queries[0]!.unsubscribeCount).toBe(1);
    expect(fake.queries[1]!.unsubscribeCount).toBe(0);
  });

  it("never evicts an ACTIVE entry even when the budget is exceeded by a retained one", async () => {
    const fake = new FakeLive();
    const { manager } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 10_000, maxRetainedQueries: 0 });

    fake.initialRows = rows("a");
    const active = await manager.subscribe(spec("select A"), collector().subscriber); // stays subscribed

    fake.initialRows = rows("b");
    const subB = await manager.subscribe(spec("select B"), collector().subscriber);
    await subB.unsubscribe(); // retained → budget 0 exceeded → B evicted immediately
    await tick();

    expect(fake.queries[0]!.unsubscribeCount).toBe(0); // active A untouched despite the budget
    expect(fake.queries[1]!.unsubscribeCount).toBe(1); // retained B evicted
    // A is genuinely live.
    const a2 = collector();
    const reA = await manager.subscribe(spec("select A"), a2.subscriber);
    expect(fake.queries).toHaveLength(2); // A shared (no re-registration)
    await active.unsubscribe();
    await reA.unsubscribe();
    await tick();
  });

  it("retains for a single subscriber's hint even when the policy default is 0", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const { manager, timers } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 0 });

    const subA = await manager.subscribe(spec("select 1"), collector().subscriber, { keepAliveMs: 60_000 });
    await subA.unsubscribe();
    expect(fake.queries[0]!.unsubscribeCount).toBe(0); // retained on the hint alone
    expect(timers.pending).toBe(1);
  });

  it("effective keep-alive is the generation's max hint — ORDER-INDEPENDENT (both departure orders retain)", async () => {
    // Generation rule (ADR-0040 decision 4): the max hint of the CURRENT active generation survives until the
    // entry reaches zero subscribers, regardless of the order subscribers leave. Both orderings of {60000, 0}
    // therefore retain — equivalent subscriber sets behave identically.
    for (const hiFirst of [true, false]) {
      const fake = new FakeLive();
      fake.initialRows = rows("1");
      const { manager, timers } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 0 });
      const subHi = await manager.subscribe(spec("select 1"), collector().subscriber, { keepAliveMs: 60_000 });
      const subLo = await manager.subscribe(spec("select 1"), collector().subscriber, { keepAliveMs: 0 });
      const [firstOut, lastOut] = hiFirst ? [subHi, subLo] : [subLo, subHi];
      await firstOut.unsubscribe();
      expect(fake.queries[0]!.unsubscribeCount).toBe(0); // still one subscriber → active
      await lastOut.unsubscribe(); // last out → effective = max(0, 60000) → retained either way
      expect(fake.queries[0]!.unsubscribeCount).toBe(0);
      expect(timers.pending).toBe(1);
    }
  });

  it("resets the keep-alive generation on a 0→1 rejoin (a departed generation's hint does not persist)", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const { manager, timers } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 0 });
    // Generation 1: a lone hint-60000 subscriber → retained on last-out.
    const gen1 = await manager.subscribe(spec("select 1"), collector().subscriber, { keepAliveMs: 60_000 });
    await gen1.unsubscribe();
    expect(timers.pending).toBe(1);
    // Rejoin with NO hint (0→1) → new generation, generation hint reset to 0. Its last-out must NOT inherit
    // generation 1's 60000 → immediate teardown.
    const gen2 = await manager.subscribe(spec("select 1"), collector().subscriber, { keepAliveMs: 0 });
    expect(timers.pending).toBe(0); // rejoin cancelled generation 1's timer
    await gen2.unsubscribe();
    expect(fake.queries[0]!.unsubscribeCount).toBe(1); // torn down — generation 2 had no hint
  });

  it("keepAliveMs: 0 explicit hint is byte-identical to Slice-3 immediate teardown", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const { manager, timers } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 0 });
    const subA = await manager.subscribe(spec("select 1"), collector().subscriber, { keepAliveMs: 0 });
    await subA.unsubscribe();
    expect(fake.queries[0]!.unsubscribeCount).toBe(1); // torn immediately, no retention
    expect(timers.pending).toBe(0);
  });

  it("keeps entry + registration counts at 1 across repeated mount/unmount cycles", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const { manager, timers } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 1000 });

    for (let cycle = 0; cycle < 5; cycle++) {
      const c = collector();
      const sub = await manager.subscribe(spec("select 1"), c.subscriber);
      expect(fake.queries).toHaveLength(1); // always reused
      expect(c.initials).toHaveLength(1);
      await sub.unsubscribe();
      expect(timers.pending).toBe(1); // retained again, one armed timer
    }
    expect(fake.queries).toHaveLength(1);
    // Finally let it expire cleanly.
    timers.advance(1000);
    await tick();
    expect(fake.queries[0]!.unsubscribeCount).toBe(1);
  });

  it("dispose() cancels pending eviction timers and tears retained entries down without leak", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const { manager, timers } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 10_000 });
    const subA = await manager.subscribe(spec("select 1"), collector().subscriber);
    await subA.unsubscribe();
    expect(timers.pending).toBe(1);

    await manager.dispose();
    expect(timers.pending).toBe(0); // timer cancelled
    expect(fake.queries[0]!.unsubscribeCount).toBe(1); // retained entry torn down by dispose
  });

  it("never re-retains under dispose: a keep-alive subscribe racing dispose() leaves no stale timer", async () => {
    // The disposed-race self-removal lands in removeSubscriber's last-out branch AFTER dispose cancelled all
    // timers and cleared the retained set — retaining there would re-arm a timer the engine close can no
    // longer cancel (a post-close stale timeout, the exact hang class ADR-0040 decision 1 removed).
    const fake = new FakeLive();
    fake.manualRegistration = true;
    const { manager, timers } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 60_000 });
    const { subscriber } = collector();

    const subPromise = manager.subscribe({ materialSql: "select 1", params: [] }, subscriber, {
      keepAliveMs: 60_000,
    });
    const disposePromise = manager.dispose();
    fake.completeRegistration();
    await subPromise;
    await disposePromise;

    expect(timers.pending).toBe(0); // no stale eviction timer survived dispose
    expect(fake.queries[0]!.unsubscribeCount).toBe(1); // the late registration tore down, not retained
  });
});

describe("live-query manager diagnostics (ADR-0040 Slice 5)", () => {
  const spec = (materialSql: string, params: unknown[] = []) => ({ materialSql, params, pkColumns: ["id"] as const });
  const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, v: id }));

  it("snapshot reports per-entry counts/timings and NEVER leaks SQL, params, or row values", async () => {
    const fake = new FakeLive();
    fake.initialRows = [{ id: "1", secret: "ROW_SECRET_VALUE" }];
    const manager = makeManager(fake); // default deps → real performance.now
    const sub = await manager.subscribe(
      // A matching `$1` placeholder keeps this within the #1055 param guard; the SQL/param still carry the
      // secret markers the snapshot must never leak.
      spec("select * from SUPER_SECRET_TABLE where c = $1", ["p4ssw0rd_value"]),
      collector().subscriber,
    );

    const snap = manager.snapshot();
    expect(snap).toHaveLength(1);
    const entry = snap[0]!;
    expect(entry.digest).toMatch(/^[0-9a-f]{8}$/);
    expect(entry.subscriberCount).toBe(1);
    expect(entry.rowCount).toBe(1);
    expect(entry.retained).toBe(false);
    expect(entry.setupMs).not.toBeNull();
    expect(entry.setupMs).toBeGreaterThanOrEqual(0);
    expect(entry.createdAt).toBeGreaterThanOrEqual(0);
    expect(entry.refresh).toEqual({ count: 0, lastMs: null, totalMs: 0, maxMs: 0 });
    expect(entry.lastUsedAt).toBeNull();
    expect(entry.retainedSinceMs).toBeNull();
    expect(entry.teardownPending).toBe(false);

    // HARD RULE (ADR-0040 decision 5): no SQL text, no bound param value, no row value anywhere in the snapshot.
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain("SUPER_SECRET_TABLE");
    expect(serialized).not.toContain("p4ssw0rd_value");
    expect(serialized).not.toContain("ROW_SECRET_VALUE");

    await sub.unsubscribe();
  });

  it("moves subscriber count, row count, and refresh timings as subscribers and diffs arrive", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const manager = makeManager(fake);
    const subA = await manager.subscribe(spec("select A"), collector().subscriber);
    const subB = await manager.subscribe(spec("select A"), collector().subscriber); // dedup → subscriberCount 2
    expect(manager.snapshot()[0]!.subscriberCount).toBe(2);

    fake.queries[0]!.emit(rows("1", "2", "3")); // a change grows the shared state
    expect(manager.snapshot()[0]!.rowCount).toBe(3);

    const refreshing = subA.refresh();
    fake.queries[0]!.resolveRefresh();
    await refreshing;
    const snap = manager.snapshot()[0]!;
    expect(snap.refresh.count).toBe(1);
    expect(snap.refresh.lastMs).not.toBeNull();
    expect(snap.refresh.maxMs).toBeGreaterThanOrEqual(0);

    await subA.unsubscribe();
    await subB.unsubscribe();
  });

  it("marks an entry retained with a retainedSinceMs while kept alive", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const { manager } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 1000 });
    const sub = await manager.subscribe(spec("select 1"), collector().subscriber);
    await sub.unsubscribe(); // retained

    const snap = manager.snapshot()[0]!;
    expect(snap.retained).toBe(true);
    expect(snap.subscriberCount).toBe(0);
    expect(snap.lastUsedAt).not.toBeNull();
    expect(snap.retainedSinceMs).not.toBeNull();
  });

  it("emits register / dedup-hit / retained / evicted / teardown-complete debug events (digests only)", async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    setSyncDebugSink((event, _stamp, data) => {
      if (event.startsWith("live-query")) events.push({ event, ...(data ? { data } : {}) });
    });
    try {
      const fake = new FakeLive();
      fake.initialRows = rows("1");
      const { manager, timers } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 1000 });
      const subA = await manager.subscribe(spec("select 1"), collector().subscriber);
      const subB = await manager.subscribe(spec("select 1"), collector().subscriber); // dedup-hit
      await subA.unsubscribe(); // one subscriber remains → active
      await subB.unsubscribe(); // last out → retained
      timers.advance(1000); // grace elapses → eviction
      await tick();

      const names = events.map((entry) => entry.event);
      expect(names).toContain("live-query register");
      expect(names).toContain("live-query dedup-hit");
      expect(names).toContain("live-query retained");
      expect(names).toContain("live-query evicted");
      expect(names).toContain("live-query teardown-complete");
      // Every event carries the opaque digest — and the register event carries setupMs.
      for (const entry of events) expect(typeof entry.data?.["digest"]).toBe("string");
      expect(events.find((e) => e.event === "live-query register")?.data).toHaveProperty("setupMs");
      expect(events.find((e) => e.event === "live-query evicted")?.data?.["reason"]).toBe("expiry");
    } finally {
      setSyncDebugSink(undefined);
    }
  });

  it("attributes eviction to the count budget vs the row budget on the debug rail", async () => {
    const events: Array<{ event: string; reason?: unknown }> = [];
    setSyncDebugSink((event, _stamp, data) => {
      if (event === "live-query evicted") events.push({ event, reason: data?.["reason"] });
    });
    try {
      // Count budget: two retained entries, max 1 → the LRU is evicted with reason "count-budget".
      const fakeCount = new FakeLive();
      const { manager: mCount, timers: tCount } = makeKeepAliveManager(fakeCount, {
        defaultKeepAliveMs: 10_000,
        maxRetainedQueries: 1,
      });
      fakeCount.initialRows = rows("a");
      const a = await mCount.subscribe(spec("select A"), collector().subscriber);
      await a.unsubscribe();
      tCount.advance(1);
      fakeCount.initialRows = rows("b");
      const b = await mCount.subscribe(spec("select B"), collector().subscriber);
      await b.unsubscribe();
      await tick();
      expect(events.some((e) => e.reason === "count-budget")).toBe(true);

      // Row budget: two 3-row entries, max 5 rows → the LRU is evicted with reason "row-budget".
      events.length = 0;
      const fakeRow = new FakeLive();
      const { manager: mRow, timers: tRow } = makeKeepAliveManager(fakeRow, {
        defaultKeepAliveMs: 10_000,
        maxRetainedRows: 5,
      });
      fakeRow.initialRows = rows("a1", "a2", "a3");
      const ra = await mRow.subscribe(spec("select A"), collector().subscriber);
      await ra.unsubscribe();
      tRow.advance(1);
      fakeRow.initialRows = rows("b1", "b2", "b3");
      const rb = await mRow.subscribe(spec("select B"), collector().subscriber);
      await rb.unsubscribe();
      await tick();
      expect(events.some((e) => e.reason === "row-budget")).toBe(true);
    } finally {
      setSyncDebugSink(undefined);
    }
  });
});

describe("live-query manager review fixes (ADR-0040 fix round)", () => {
  const spec = (materialSql: string) => ({ materialSql, params: [] as unknown[], pkColumns: ["id"] as const });
  const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, v: id }));

  it("rejects subscribe() synchronously once dispose has begun", async () => {
    const fake = new FakeLive();
    const manager = makeManager(fake);
    await manager.dispose();
    expect(await rejectionOf(manager.subscribe(spec("select 1"), collector().subscriber))).toMatch(
      /subscribe after dispose/,
    );
  });

  it("drains a subscribe racing dispose — all teardowns settle before dispose resolves", async () => {
    const fake = new FakeLive();
    fake.manualRegistration = true;
    fake.initialRows = rows("1");
    const manager = makeManager(fake);

    // Start a subscribe whose registration has not resolved, then dispose. The drain must wait it out.
    const subPromise = manager.subscribe(spec("select 1"), collector().subscriber);
    let disposed = false;
    const disposePromise = manager.dispose().then(() => {
      disposed = true;
    });
    await tick();
    expect(disposed).toBe(false);

    fake.completeRegistration();
    await subPromise;
    await disposePromise;
    expect(disposed).toBe(true);
    expect(fake.queries[0]!.unsubscribeCount).toBe(1); // the late registration did not leak
  });

  it("re-enforces the ROW budget after a retained entry's rows grow via a listener fire", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1"); // 1 row
    const { manager } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 10_000, maxRetainedRows: 2 });
    const sub = await manager.subscribe(spec("select 1"), collector().subscriber);
    await sub.unsubscribe(); // retained, 1 row ≤ 2
    expect(fake.queries[0]!.unsubscribeCount).toBe(0);

    // A dependent write grows the retained result past the row budget → re-enforcement evicts it.
    fake.queries[0]!.emit(rows("1", "2", "3", "4")); // 4 rows > 2
    await tick();
    expect(fake.queries[0]!.unsubscribeCount).toBe(1);
  });

  it("isolates a throwing deliverDiff — a sibling still receives the same diff", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const manager = makeManager(fake);
    const good = collector();
    await manager.subscribe(spec("select 1"), {
      deliverInitial: () => undefined,
      deliverDiff: () => {
        throw new Error("boom");
      },
    });
    const subGood = await manager.subscribe(spec("select 1"), good.subscriber);

    fake.queries[0]!.emit(rows("1", "2"));
    expect(good.diffs).toHaveLength(1); // sibling unaffected by the throwing subscriber
    await subGood.unsubscribe();
  });

  it("rolls back membership when deliverInitial throws (sole subscriber → entry torn; a later subscribe works)", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const manager = makeManager(fake);
    expect(
      await rejectionOf(
        manager.subscribe(spec("select 1"), {
          deliverInitial: () => {
            throw new Error("initial boom");
          },
          deliverDiff: () => undefined,
        }),
      ),
    ).toBe("initial boom");
    // The sole subscriber's failed join tore the entry down (never retention).
    expect(fake.queries[0]!.unsubscribeCount).toBe(1);

    // A subsequent good subscribe builds a fresh registration and works.
    const good = collector();
    const sub = await manager.subscribe(spec("select 1"), good.subscriber);
    expect(good.initials).toHaveLength(1);
    await sub.unsubscribe();
  });

  it("a failed deliverInitial on a joiner leaves the existing subscriber unaffected", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const manager = makeManager(fake);
    const good = collector();
    const subGood = await manager.subscribe(spec("select 1"), good.subscriber);
    expect(
      await rejectionOf(
        manager.subscribe(spec("select 1"), {
          deliverInitial: () => {
            throw new Error("joiner boom");
          },
          deliverDiff: () => undefined,
        }),
      ),
    ).toBe("joiner boom");
    expect(fake.queries[0]!.unsubscribeCount).toBe(0); // entry NOT torn — the good subscriber remains
    fake.queries[0]!.emit(rows("1", "2"));
    expect(good.diffs).toHaveLength(1);
    await subGood.unsubscribe();
  });

  it("snapshot reports scopeCount (distinct scopes) and per-entry dedupHits", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const manager = makeManager(fake);
    const a = await manager.subscribe(spec("select 1"), collector().subscriber, { scope: "tab-A" });
    const b = await manager.subscribe(spec("select 1"), collector().subscriber, { scope: "tab-B" });
    let snap = manager.snapshot()[0]!;
    expect(snap.subscriberCount).toBe(2);
    expect(snap.scopeCount).toBe(2); // two distinct scopes (tabs)
    expect(snap.dedupHits).toBe(1); // b joined an existing entry

    // A third subscriber reusing tab-A's scope does not raise scopeCount, but raises dedupHits.
    const c = await manager.subscribe(spec("select 1"), collector().subscriber, { scope: "tab-A" });
    snap = manager.snapshot()[0]!;
    expect(snap.scopeCount).toBe(2);
    expect(snap.dedupHits).toBe(2);
    await a.unsubscribe();
    await b.unsubscribe();
    await c.unsubscribe();
  });

  it("scopeCount is 1 for scope-less (in-process) subscribers", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const manager = makeManager(fake);
    const a = await manager.subscribe(spec("select 1"), collector().subscriber);
    const b = await manager.subscribe(spec("select 1"), collector().subscriber);
    const snap = manager.snapshot()[0]!;
    expect(snap.subscriberCount).toBe(2);
    expect(snap.scopeCount).toBe(1); // no scopes → one bucket
    await a.unsubscribe();
    await b.unsubscribe();
  });

  it("emits a teardown-failed debug event when unsubscribe rejects", async () => {
    const events: string[] = [];
    setSyncDebugSink((event) => {
      if (event.startsWith("live-query")) events.push(event);
    });
    try {
      const fake = new FakeLive();
      fake.initialRows = rows("1");
      const manager = makeManager(fake);
      const sub = await manager.subscribe(spec("select 1"), collector().subscriber);
      fake.queries[0]!.failUnsubscribe = true;
      await sub.unsubscribe();
      await tick();
      expect(events).toContain("live-query teardown-failed");
    } finally {
      setSyncDebugSink(undefined);
    }
  });

  it("validates policy fields at construction (finite, non-negative; budgets integer)", () => {
    const live = new FakeLive() as unknown as LiveQueryManagerDeps["live"];
    expect(() => createLiveQueryManager({ live, policy: { defaultKeepAliveMs: Number.NaN } })).toThrow(
      /defaultKeepAliveMs/,
    );
    expect(() => createLiveQueryManager({ live, policy: { defaultKeepAliveMs: -1 } })).toThrow(/defaultKeepAliveMs/);
    expect(() => createLiveQueryManager({ live, policy: { defaultKeepAliveMs: Infinity } })).toThrow(
      /defaultKeepAliveMs/,
    );
    expect(() => createLiveQueryManager({ live, policy: { maxRetainedQueries: 1.5 } })).toThrow(/maxRetainedQueries/);
    expect(() => createLiveQueryManager({ live, policy: { maxRetainedRows: -5 } })).toThrow(/maxRetainedRows/);
    // A valid policy constructs fine.
    expect(() =>
      createLiveQueryManager({ live, policy: { defaultKeepAliveMs: 0, maxRetainedQueries: 4, maxRetainedRows: 100 } }),
    ).not.toThrow();
  });

  it("rejects a non-finite / negative per-subscription keepAliveMs hint", async () => {
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const manager = makeManager(fake);
    expect(
      await rejectionOf(manager.subscribe(spec("select 1"), collector().subscriber, { keepAliveMs: Infinity })),
    ).toMatch(/keepAliveMs/);
    expect(
      await rejectionOf(manager.subscribe(spec("select 1"), collector().subscriber, { keepAliveMs: -10 })),
    ).toMatch(/keepAliveMs/);
  });

  it("rejects a keep-alive above the signed-32-bit setTimeout ceiling (policy + hint), but accepts the ceiling", async () => {
    // ADR-0040 decision 4: a delay above 2_147_483_647 ms clamps to ~0 in browsers/Node, so a "30-day"
    // keep-alive would expire IMMEDIATELY — reject it at the boundary rather than let it become a footgun.
    const live = new FakeLive() as unknown as LiveQueryManagerDeps["live"];
    // Policy default: one past the ceiling is rejected (error names the limit); the exact ceiling constructs fine.
    expect(() => createLiveQueryManager({ live, policy: { defaultKeepAliveMs: 2_147_483_648 } })).toThrow(/2147483647/);
    expect(() => createLiveQueryManager({ live, policy: { defaultKeepAliveMs: 2_147_483_647 } })).not.toThrow();

    // Per-subscription hint: same ceiling. Fake timers so the accepted ceiling never arms a real 24.8-day
    // setTimeout in the runner. One past → reject; exactly at the ceiling → accepted.
    const fake = new FakeLive();
    fake.initialRows = rows("1");
    const { manager, timers } = makeKeepAliveManager(fake, { defaultKeepAliveMs: 0 });
    expect(
      await rejectionOf(manager.subscribe(spec("select 1"), collector().subscriber, { keepAliveMs: 2_147_483_648 })),
    ).toMatch(/2147483647/);
    // The ceiling is accepted (it registers and delivers its initial snapshot, and retains on the hint).
    const c = collector();
    const sub = await manager.subscribe(spec("select 1"), c.subscriber, { keepAliveMs: 2_147_483_647 });
    expect(c.initials).toHaveLength(1);
    await sub.unsubscribe();
    expect(timers.pending).toBe(1); // retained on the accepted ceiling hint — a fake timer, not a real one
    await manager.dispose();
  });
});

describe("live-query manager PGlite #1055 param guard", () => {
  it("throws for an out-of-order-placeholder spec WITHOUT ever calling the underlying live.query/incrementalQuery", async () => {
    const fake = new FakeLive();
    const manager = makeManager(fake);
    // Out-of-order `$2 … $1` with two params trips PGlite bug #1055's sequential inlining — the guard must
    // reject it synchronously at the boundary, before any registration is attempted.
    const message = await rejectionOf(
      manager.subscribe(
        { materialSql: "select * from t where a = $2 and b = $1", params: ["x", "y"], pkColumns: ["id"] },
        collector().subscriber,
      ),
    );
    expect(message).toMatch(/1055/);
    // The broken spec never reached PGlite: no registration was created.
    expect(fake.queryCalls).toBe(0);
    expect(fake.incrementalCalls).toBe(0);
    expect(fake.queries).toHaveLength(0);
  });

  it("subscribes fine for a params-bearing spec with a strictly sequential $1..$n", async () => {
    const fake = new FakeLive();
    fake.initialRows = [{ id: "1", v: "a" }];
    const manager = makeManager(fake);
    const c = collector();
    const sub = await manager.subscribe(
      { materialSql: "select * from t where a = $1 and b = $2", params: ["x", "y"], pkColumns: ["id"] },
      c.subscriber,
    );
    expect(fake.incrementalCalls).toBe(1);
    expect(c.initials).toEqual([[{ id: "1", v: "a" }]]);
    await sub.unsubscribe();
  });
});

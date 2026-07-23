import { describe, expect, it } from "bun:test";

// The placement probe (ADR-0049 decision 1, plan step 4, invariant 8). The verdict is a REAL
// `createSyncAccessHandle` open on a scratch file under the toolkit's `pgxsinkit/probe/` namespace —
// never method-presence sniffing — and it is NEVER cached: every call probes afresh. These tests pin
// the granted/denied/API-absent verdicts, the verbatim `Name: message` attribution, the mandatory
// best-effort cleanup (which must never demote a granted verdict), and the per-boot (no-cache) contract.
import {
  type OpfsProbeDirectoryHandle,
  type OpfsProbeFileHandle,
  probeOpfsSyncAccess,
} from "../../packages/client/src/placement-probe";

const SCRATCH = "probe-deadbeef";

/** A directory hop that must never be reached in a well-formed probe walk. */
function unexpectedDir(label: string): OpfsProbeDirectoryHandle["getDirectoryHandle"] {
  return () => Promise.reject(new Error(`unexpected getDirectoryHandle on ${label}`));
}
function unexpectedFile(label: string): OpfsProbeDirectoryHandle["getFileHandle"] {
  return () => Promise.reject(new Error(`unexpected getFileHandle on ${label}`));
}
function unexpectedRemove(label: string): OpfsProbeDirectoryHandle["removeEntry"] {
  return () => Promise.reject(new Error(`unexpected removeEntry on ${label}`));
}

interface ProbeCalls {
  dirWalk: Array<{ name: string; options: { create: boolean } }>;
  fileWalk: Array<{ name: string; options: { create: boolean } }>;
  removed: string[];
  rootOpens: number;
}

/**
 * Build a fake OPFS root that walks `root → pgxsinkit → probe → <scratch file>`, recording every hop.
 * `fileHandle` is what the probe-directory's `getFileHandle` resolves to; `removeEntryImpl` (optional)
 * lets a test make cleanup throw.
 */
function fakeOpfs(
  fileHandle: OpfsProbeFileHandle,
  removeEntryImpl?: (name: string) => Promise<void>,
): { getRoot: () => Promise<OpfsProbeDirectoryHandle>; calls: ProbeCalls } {
  const calls: ProbeCalls = { dirWalk: [], fileWalk: [], removed: [], rootOpens: 0 };

  const probeDir: OpfsProbeDirectoryHandle = {
    getDirectoryHandle: unexpectedDir("probe dir"),
    getFileHandle: (name, options) => {
      calls.fileWalk.push({ name, options });
      return Promise.resolve(fileHandle);
    },
    removeEntry: (name) => {
      calls.removed.push(name);
      return removeEntryImpl ? removeEntryImpl(name) : Promise.resolve();
    },
  };
  const container: OpfsProbeDirectoryHandle = {
    getDirectoryHandle: (name, options) => {
      calls.dirWalk.push({ name, options });
      return Promise.resolve(probeDir);
    },
    getFileHandle: unexpectedFile("container"),
    removeEntry: unexpectedRemove("container"),
  };
  const root: OpfsProbeDirectoryHandle = {
    getDirectoryHandle: (name, options) => {
      calls.dirWalk.push({ name, options });
      return Promise.resolve(container);
    },
    getFileHandle: unexpectedFile("root"),
    removeEntry: unexpectedRemove("root"),
  };
  return {
    getRoot: () => {
      calls.rootOpens += 1;
      return Promise.resolve(root);
    },
    calls,
  };
}

/** A monotonic injected clock: `[start, ...ticks]` handed out in order (last value repeats). */
function fakeClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

describe("probeOpfsSyncAccess — granted (a real sync-access handle opened)", () => {
  it("opens on scratch, closes it, cleans up, and reports granted with a non-negative ms", async () => {
    let closed = false;
    const syncHandle = {
      close() {
        closed = true;
      },
    };
    let opened = 0;
    const fileHandle: OpfsProbeFileHandle = {
      createSyncAccessHandle: () => {
        opened += 1;
        return Promise.resolve(syncHandle);
      },
    };
    const { getRoot, calls } = fakeOpfs(fileHandle);

    const result = await probeOpfsSyncAccess({ getRoot, scratchName: SCRATCH, now: fakeClock([1000, 1007]) });

    expect(result.granted).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.ms).toBe(7);
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(opened).toBe(1);
    expect(closed).toBe(true);
    // Cleanup removed exactly the scratch file we created.
    expect(calls.removed).toEqual([SCRATCH]);
    // The walk created the `pgxsinkit/probe` namespace with { create: true } at every hop.
    expect(calls.dirWalk).toEqual([
      { name: "pgxsinkit", options: { create: true } },
      { name: "probe", options: { create: true } },
    ]);
    expect(calls.fileWalk).toEqual([{ name: SCRATCH, options: { create: true } }]);
  });
});

describe("probeOpfsSyncAccess — denied (verbatim attribution, cleanup still attempted)", () => {
  it("reports the thrown TypeError verbatim when createSyncAccessHandle is absent at call time", async () => {
    // A file handle WITHOUT the method — calling it throws a real TypeError (no pre-check sniffing).
    const fileHandle = {} as OpfsProbeFileHandle;
    const { getRoot, calls } = fakeOpfs(fileHandle);

    const result = await probeOpfsSyncAccess({ getRoot, scratchName: SCRATCH, now: fakeClock([0, 2]) });

    expect(result.granted).toBe(false);
    expect(result.error).toContain("TypeError");
    expect(result.ms).toBe(2);
    // Cleanup is still attempted after a mid-walk failure.
    expect(calls.removed).toEqual([SCRATCH]);
  });

  it("reports a rejecting createSyncAccessHandle verbatim as `Name: message`", async () => {
    const denial = Object.assign(new Error("The operation failed for an unknown reason"), {
      name: "UnknownError",
    });
    const fileHandle: OpfsProbeFileHandle = {
      createSyncAccessHandle: () => Promise.reject(denial),
    };
    const { getRoot, calls } = fakeOpfs(fileHandle);

    const result = await probeOpfsSyncAccess({ getRoot, scratchName: SCRATCH });

    expect(result.granted).toBe(false);
    expect(result.error).toBe("UnknownError: The operation failed for an unknown reason");
    expect(calls.removed).toEqual([SCRATCH]);
  });
});

describe("probeOpfsSyncAccess — OPFS API absent (answers, never throws)", () => {
  it("returns granted:false with an API-absent error when navigator.storage is missing", async () => {
    const g = globalThis as { navigator?: { storage?: unknown } };
    const hadNavigator = "navigator" in g;
    const savedNavigator = g.navigator;
    const savedStorage = g.navigator?.storage;
    // Remove the OPFS entry point for the duration of this probe (deps.getRoot deliberately omitted).
    if (g.navigator) g.navigator.storage = undefined;
    try {
      const result = await probeOpfsSyncAccess();
      expect(result.granted).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.toLowerCase()).toContain("not available");
      expect(result.ms).toBeGreaterThanOrEqual(0);
    } finally {
      if (hadNavigator && savedNavigator) savedNavigator.storage = savedStorage;
      else if (!hadNavigator) delete g.navigator;
    }
  });
});

describe("probeOpfsSyncAccess — cleanup failure never demotes a granted verdict", () => {
  it("stays granted:true even when removeEntry throws", async () => {
    let closed = false;
    const fileHandle: OpfsProbeFileHandle = {
      createSyncAccessHandle: () =>
        Promise.resolve({
          close() {
            closed = true;
          },
        }),
    };
    const { getRoot, calls } = fakeOpfs(fileHandle, () =>
      Promise.reject(Object.assign(new Error("gone"), { name: "NotFoundError" })),
    );

    const result = await probeOpfsSyncAccess({ getRoot, scratchName: SCRATCH });

    expect(result.granted).toBe(true);
    expect(result.error).toBeUndefined();
    expect(closed).toBe(true);
    // Cleanup was attempted (and swallowed) — the granted verdict survives.
    expect(calls.removed).toEqual([SCRATCH]);
  });
});

describe("probeOpfsSyncAccess — never caches (probe per boot, invariant 8)", () => {
  it("hits the injected root on every call", async () => {
    const fileHandle: OpfsProbeFileHandle = {
      createSyncAccessHandle: () => Promise.resolve({ close() {} }),
    };
    const { getRoot, calls } = fakeOpfs(fileHandle);

    await probeOpfsSyncAccess({ getRoot, scratchName: SCRATCH });
    await probeOpfsSyncAccess({ getRoot, scratchName: SCRATCH });

    expect(calls.rootOpens).toBe(2);
  });
});

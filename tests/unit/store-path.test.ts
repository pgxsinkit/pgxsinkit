import { describe, expect, it } from "bun:test";
// The store path contract (ADR-0036): the ONE place `idb://` / `file://` / `memory://` URLs are assembled,
// plus the scheme-rejection guard, the browser/node backend derivation, the browser-only IndexedDB naming
// helper, the BYO classification, and the testing-marker plumbing. This is the resolution module's own unit
// test — the only place besides the module itself where the `memory://` literal is expected to appear.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyNonPersistentDataDir,
  InvalidStorePathError,
  normaliseStorePathInput,
  readTestStoreMarker,
  resolveStoreDataDir,
  storeIndexedDbDatabaseName,
  storeTargetExists,
  TEST_STORE_BACKEND,
} from "../../packages/client/src/store-path";
import { memoryStoreForTests, testStoreAcknowledgment } from "../../packages/client/src/testing";

const browserEnv = { hasIndexedDb: true };
const nodeEnv = { hasIndexedDb: false };

describe("resolveStoreDataDir — backend derivation (ADR-0036 decision 2)", () => {
  it("derives idb:// in a browser/worker (indexedDB present)", () => {
    expect(resolveStoreDataDir("my-app-store", undefined, browserEnv)).toBe("idb://my-app-store");
  });

  it("derives file:// on Bun/Node (no indexedDB)", () => {
    expect(resolveStoreDataDir("my-app-store", undefined, nodeEnv)).toBe("file://my-app-store");
  });

  it("selects a scheme-selected memory store only via the internal override — irrespective of environment", () => {
    expect(resolveStoreDataDir("my-app-store", "memory", browserEnv)).toBe("memory://my-app-store");
    expect(resolveStoreDataDir("my-app-store", "memory", nodeEnv)).toBe("memory://my-app-store");
  });
});

describe("resolveStoreDataDir — scheme rejection (ADR-0036 decision 1)", () => {
  it.each(["idb://my-store", "memory://my-store", "file://my-store", "custom://my-store", "s3://bucket/key"])(
    "rejects a scheme-bearing path %p with InvalidStorePathError",
    (bad) => {
      expect(() => resolveStoreDataDir(bad, undefined, browserEnv)).toThrow(InvalidStorePathError);
    },
  );

  it("rejects empty and whitespace-only paths", () => {
    expect(() => resolveStoreDataDir("", undefined, browserEnv)).toThrow(InvalidStorePathError);
    expect(() => resolveStoreDataDir("   ", undefined, browserEnv)).toThrow(InvalidStorePathError);
  });

  it("the error message points at the plain-path contract without echoing a resolvable URL to imitate", () => {
    let caught: InvalidStorePathError | undefined;
    try {
      resolveStoreDataDir("idb://oops", undefined, browserEnv);
    } catch (error) {
      caught = error as InvalidStorePathError;
    }
    expect(caught).toBeInstanceOf(InvalidStorePathError);
    // Names the contract and the fix; does NOT hand back a `idb://…` the caller could copy as a storePath.
    expect(caught!.message).toContain("plain name");
    expect(caught!.message).not.toMatch(/pass .*idb:\/\//i);
  });
});

describe("storeIndexedDbDatabaseName — browser-only operational helper (ADR-0036)", () => {
  it("maps a store path to PGlite's IndexedDB database name", () => {
    expect(storeIndexedDbDatabaseName("pgxsinkit-board-abc")).toBe("/pglite/pgxsinkit-board-abc");
  });

  it("rejects a scheme-bearing/empty path exactly as resolveStoreDataDir does", () => {
    expect(() => storeIndexedDbDatabaseName("idb://x")).toThrow(InvalidStorePathError);
    expect(() => storeIndexedDbDatabaseName("")).toThrow(InvalidStorePathError);
  });
});

describe("classifyNonPersistentDataDir — the BYO predicate (ADR-0036 decision 4)", () => {
  it("flags the two provably non-persistent shapes", () => {
    expect(classifyNonPersistentDataDir(undefined)).toBe("in-memory-default");
    expect(classifyNonPersistentDataDir("memory://x")).toBe("memory-scheme");
  });

  it("passes anything else — including exotic configs it cannot classify (not a whitelist)", () => {
    expect(classifyNonPersistentDataDir("idb://x")).toBeNull();
    expect(classifyNonPersistentDataDir("file:///var/data/x")).toBeNull();
    expect(classifyNonPersistentDataDir("some-custom-vfs-handle")).toBeNull();
  });
});

describe("testing-marker plumbing (ADR-0036 decision 3)", () => {
  it("memoryStoreForTests carries the marker at runtime but not in the public type", () => {
    const options = memoryStoreForTests("unit-x");
    expect(options.storePath).toBe("unit-x");
    // The marker is symbol-keyed, so it is invisible to `Object.keys` yet present at runtime.
    expect(Object.keys(options)).toEqual(["storePath"]);
    expect((options as { [TEST_STORE_BACKEND]?: string })[TEST_STORE_BACKEND]).toBe("memory");
    // The public type does not expose the marker: a compile-time probe that `storePath` is the only field.
    const typeProbe: { storePath: string } = options;
    expect(typeProbe.storePath).toBe("unit-x");
  });

  it("testStoreAcknowledgment carries only the acknowledgment marker (no storePath)", () => {
    const ack = testStoreAcknowledgment();
    expect(Object.keys(ack)).toEqual([]);
    expect((ack as { [TEST_STORE_BACKEND]?: string })[TEST_STORE_BACKEND]).toBe("acknowledged");
  });

  it("readTestStoreMarker reads either marker, and undefined for plain options", () => {
    expect(readTestStoreMarker(memoryStoreForTests("x"))).toBe("memory");
    expect(readTestStoreMarker(testStoreAcknowledgment())).toBe("acknowledged");
    expect(readTestStoreMarker({ storePath: "plain" })).toBeUndefined();
    expect(readTestStoreMarker(undefined)).toBeUndefined();
  });
});

describe("storeTargetExists — the restore fresh-target gate (ADR-0035 decision 6)", () => {
  it("is always false for a memory-backend store (fresh by construction)", async () => {
    expect(await storeTargetExists("mem-fresh", "memory", nodeEnv)).toBe(false);
    expect(await storeTargetExists("mem-fresh", "memory", browserEnv)).toBe(false);
  });

  it("reports filesystem existence for a file:// store (Bun/Node)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pgxsinkit-store-exists-"));
    try {
      // The temp dir itself is an existing datadir path; a sibling name that was never created is absent.
      const existing = dir; // absolute path — resolveStoreDataDir keeps it verbatim after `file://`.
      const missing = join(dir, "never-created");
      expect(await storeTargetExists(existing, undefined, nodeEnv)).toBe(true);
      expect(await storeTargetExists(missing, undefined, nodeEnv)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is best-effort false for idb:// when indexedDB.databases() is unavailable (never fabricates a positive)", async () => {
    // No `indexedDB` on the globalThis in bun → the idb branch cannot enumerate, so it reports false and lets
    // the restore proceed rather than inventing a result.
    expect(await storeTargetExists("idb-store", undefined, browserEnv)).toBe(false);
  });
});

describe("normaliseStorePathInput — string or testing-helper output", () => {
  it("passes a plain string through with no override", () => {
    expect(normaliseStorePathInput("plain")).toEqual({ storePath: "plain" });
  });

  it("extracts the storePath and the memory override from the testing helper's output", () => {
    expect(normaliseStorePathInput(memoryStoreForTests("mem-x"))).toEqual({
      storePath: "mem-x",
      backendOverride: "memory",
    });
  });
});

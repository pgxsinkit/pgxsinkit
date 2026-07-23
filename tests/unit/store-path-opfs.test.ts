import { afterEach, describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 1: the store-path module gains the `opfs://` scheme and
// becomes the sole owner of the browser-side identity encoding and the disjoint OPFS namespaces. This is that
// slice's own unit test — injective `storeIdentityComponent` over its defined domain (invariant 10), the
// `pgxsinkit/stores|commitments|probe` namespace builders (invariant 11 / D6), `opfs://` resolution
// precedence with the placement probe's injected `hasOpfsSyncAccess`, and the `storeTargetExists` opfs
// fresh-target gate.

import {
  InvalidStorePathError,
  OPFS_TOOLKIT_CONTAINER,
  opfsCommitmentSentinelPath,
  opfsProbeDirectoryPath,
  opfsStoreDirectoryPath,
  resolveStoreDataDir,
  storeIdentityComponent,
  storeIndexedDbDatabaseName,
  storeTargetExists,
} from "../../packages/client/src/store-path";

// A minimal structural OPFS directory-handle fake. Every hop records the options it was asked for (so the
// test can prove the traversal always passes `{ create: false }`); a missing child throws a NotFoundError-named
// DOMException-shaped error, exactly as the File System Standard does.
class NotFoundError extends Error {
  constructor() {
    super("A requested entry was not found.");
    this.name = "NotFoundError";
  }
}

class ForeignError extends Error {
  constructor() {
    super("The current usage exceeds the quota.");
    this.name = "QuotaExceededError";
  }
}

interface FakeDir {
  getDirectoryHandle(name: string, options: { create: boolean }): Promise<FakeDir>;
}

function fakeDir(children: Record<string, FakeDir | undefined>, recorded: Array<{ create: boolean }>): FakeDir {
  return {
    async getDirectoryHandle(name, options) {
      recorded.push(options);
      const child = children[name];
      if (child === undefined) throw new NotFoundError();
      return child;
    },
  };
}

function throwingDir(error: Error, recorded: Array<{ create: boolean }>): FakeDir {
  return {
    async getDirectoryHandle(_name, options) {
      recorded.push(options);
      throw error;
    },
  };
}

// Install a fake `navigator.storage.getDirectory` returning `root`; returns a restore fn (always call in
// finally — bun's `navigator` global is real).
const savedNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const savedIndexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
function withNavigatorStorage(getDirectory: (() => Promise<FakeDir>) | undefined): void {
  const value = getDirectory === undefined ? {} : { storage: { getDirectory } };
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}
afterEach(() => {
  if (savedNavigatorDescriptor === undefined) delete (globalThis as { navigator?: unknown }).navigator;
  else Object.defineProperty(globalThis, "navigator", savedNavigatorDescriptor);
  if (savedIndexedDbDescriptor === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB;
  else Object.defineProperty(globalThis, "indexedDB", savedIndexedDbDescriptor);
});

describe("storeIdentityComponent — one injective encoding over a defined domain (ADR-0049 D11, invariant 10)", () => {
  it("percent-encodes to a single filesystem-safe component", () => {
    expect(storeIdentityComponent("my-app-store")).toBe("my-app-store");
    expect(storeIdentityComponent("foo/bar")).toBe("foo%2Fbar");
  });

  it("is injective — distinct inputs never collapse to one identity, including the adversarial pairs", () => {
    // Percent-encoding is injective: the escape of a literal `/` is itself escaped when it appears literally.
    expect(storeIdentityComponent("foo/bar")).not.toBe(storeIdentityComponent("foo%2Fbar"));
    expect(storeIdentityComponent("foo")).not.toBe(storeIdentityComponent("foo.committed"));
  });

  it("rejects the two reserved component names `.` and `..` at the boundary (File System Standard)", () => {
    expect(() => storeIdentityComponent(".")).toThrow(InvalidStorePathError);
    expect(() => storeIdentityComponent("..")).toThrow(InvalidStorePathError);
  });

  it("rejects a lone UTF-16 surrogate as InvalidStorePathError (never a bare URIError)", () => {
    let caught: unknown;
    try {
      storeIdentityComponent("\uD800");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidStorePathError);
    expect(caught).not.toBeInstanceOf(URIError);
  });

  it("caps the ENCODED length at 128 — a 129-char ASCII input is rejected, 128 is accepted", () => {
    expect(storeIdentityComponent("a".repeat(128))).toBe("a".repeat(128));
    expect(() => storeIdentityComponent("a".repeat(129))).toThrow(InvalidStorePathError);
  });

  it("caps on the ENCODED length, not the raw length — a short multi-byte input whose encoding exceeds 128 is rejected", () => {
    // Each `é` percent-encodes to `%C3%A9` (6 chars). 30 raw chars (< 128) encode to 180 chars (> 128).
    const raw = "é".repeat(30);
    expect(raw.length).toBeLessThan(128);
    expect(encodeURIComponent(raw).length).toBeGreaterThan(128);
    expect(() => storeIdentityComponent(raw)).toThrow(InvalidStorePathError);
  });

  it("rejects empty/whitespace-only and scheme-bearing paths exactly as resolveStoreDataDir does", () => {
    expect(() => storeIdentityComponent("")).toThrow(InvalidStorePathError);
    expect(() => storeIdentityComponent("   ")).toThrow(InvalidStorePathError);
    expect(() => storeIdentityComponent("opfs://x")).toThrow(InvalidStorePathError);
  });
});

describe("OPFS namespace builders — disjoint toolkit-owned namespaces (ADR-0049 D6, invariant 11)", () => {
  it("routes every namespace through the one container and the one identity encoding", () => {
    expect(OPFS_TOOLKIT_CONTAINER).toBe("pgxsinkit");
    expect(opfsStoreDirectoryPath("foo")).toEqual(["pgxsinkit", "stores", "foo"]);
    expect(opfsCommitmentSentinelPath("foo")).toEqual(["pgxsinkit", "commitments", "foo"]);
    expect(opfsProbeDirectoryPath()).toEqual(["pgxsinkit", "probe"]);
    expect(opfsStoreDirectoryPath("foo/bar")).toEqual(["pgxsinkit", "stores", "foo%2Fbar"]);
  });

  it("two valid identities can never contend for one OPFS entry — `foo`'s sentinel vs `foo.committed`'s store dir are disjoint", () => {
    const sentinel = opfsCommitmentSentinelPath("foo"); // ["pgxsinkit", "commitments", "foo"]
    const storeDir = opfsStoreDirectoryPath("foo.committed"); // ["pgxsinkit", "stores", "foo.committed"]
    // The final two segments carry the namespace + identity; they must share NO overlap.
    expect(sentinel.slice(1)).toEqual(["commitments", "foo"]);
    expect(storeDir.slice(1)).toEqual(["stores", "foo.committed"]);
    expect(sentinel.slice(1)).not.toEqual(storeDir.slice(1));
    expect(sentinel[1]).not.toBe(storeDir[1]);
  });

  it("the namespace builders apply the domain guards too", () => {
    expect(() => opfsStoreDirectoryPath(".")).toThrow(InvalidStorePathError);
    expect(() => opfsCommitmentSentinelPath("..")).toThrow(InvalidStorePathError);
    expect(() => opfsStoreDirectoryPath("idb://x")).toThrow(InvalidStorePathError);
  });
});

describe("resolveStoreDataDir — opfs precedence with the placement probe's injected result (ADR-0049 D1)", () => {
  it("resolves opfs:// when hasOpfsSyncAccess is true (regardless of hasIndexedDb)", () => {
    expect(resolveStoreDataDir("s", undefined, { hasOpfsSyncAccess: true, hasIndexedDb: true })).toBe("opfs://s");
    expect(resolveStoreDataDir("s", undefined, { hasOpfsSyncAccess: true, hasIndexedDb: false })).toBe("opfs://s");
  });

  it("falls back to idb:// then file:// when the probe granted no handle", () => {
    expect(resolveStoreDataDir("s", undefined, { hasOpfsSyncAccess: false, hasIndexedDb: true })).toBe("idb://s");
    // `hasOpfsSyncAccess` omitted (undefined = false — the detectStoreEnv default) still derives idb.
    expect(resolveStoreDataDir("s", undefined, { hasIndexedDb: true })).toBe("idb://s");
    expect(resolveStoreDataDir("s", undefined, { hasOpfsSyncAccess: false, hasIndexedDb: false })).toBe("file://s");
  });

  it("the memory override still beats hasOpfsSyncAccess (test/ephemeral lane is first)", () => {
    expect(resolveStoreDataDir("s", "memory", { hasOpfsSyncAccess: true, hasIndexedDb: true })).toBe("memory://s");
  });
});

describe("storeTargetExists — the opfs fresh-target gate (ADR-0049; commitment authority is NOT its job)", () => {
  const opfsEnv = { hasOpfsSyncAccess: true, hasIndexedDb: true };

  it("resolves through the pgxsinkit/stores/<identity> chain → true, asking for { create: false } at every hop", async () => {
    const recorded: Array<{ create: boolean }> = [];
    const root = fakeDir(
      { pgxsinkit: fakeDir({ stores: fakeDir({ foo: fakeDir({}, recorded) }, recorded) }, recorded) },
      recorded,
    );
    withNavigatorStorage(async () => root);
    try {
      expect(await storeTargetExists("foo", undefined, opfsEnv)).toBe(true);
    } finally {
      // afterEach restores navigator.
    }
    expect(recorded).toHaveLength(3); // pgxsinkit → stores → foo
    expect(recorded.every((options) => options.create === false)).toBe(true);
  });

  it("NotFoundError at the leaf (identity dir) → false", async () => {
    const recorded: Array<{ create: boolean }> = [];
    const root = fakeDir({ pgxsinkit: fakeDir({ stores: fakeDir({}, recorded) }, recorded) }, recorded);
    withNavigatorStorage(async () => root);
    expect(await storeTargetExists("foo", undefined, opfsEnv)).toBe(false);
  });

  it("a granted restore guard still finds an idb-only predecessor", async () => {
    const recorded: Array<{ create: boolean }> = [];
    withNavigatorStorage(async () => fakeDir({}, recorded));
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: { databases: async () => [{ name: storeIndexedDbDatabaseName("foo") }] },
    });

    expect(await storeTargetExists("foo", undefined, opfsEnv)).toBe(true);
  });

  it("NotFoundError at the container (no pgxsinkit) → false", async () => {
    const recorded: Array<{ create: boolean }> = [];
    const root = fakeDir({}, recorded);
    withNavigatorStorage(async () => root);
    expect(await storeTargetExists("foo", undefined, opfsEnv)).toBe(false);
  });

  it("best-effort false when navigator.storage.getDirectory is absent (never fabricates a positive)", async () => {
    withNavigatorStorage(undefined);
    expect(await storeTargetExists("foo", undefined, opfsEnv)).toBe(false);
  });

  it("propagates a foreign error (a genuine failure the restore caller must see)", async () => {
    const recorded: Array<{ create: boolean }> = [];
    const root = throwingDir(new ForeignError(), recorded);
    withNavigatorStorage(async () => root);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a real promise typed as void
    await expect(storeTargetExists("foo", undefined, opfsEnv)).rejects.toBeInstanceOf(ForeignError);
  });
});

// Store path contract (ADR-0036). The public seams (`createSyncClient`, `createClientPGlite`, the worker
// attach/provision messages, the board store registry) take a `storePath` — a PLAIN path/name, never a
// PGlite storage URL. The storage backend is DERIVED from the engine home's capabilities here, never chosen by
// the consumer: opfs-repacked when that home holds sync access, IndexedDB as the browser fallback, and the
// filesystem on Bun/Node. A memory-backed store is
// not a product configuration — pgxsinkit's durability semantics (persistent retention, the optimistic
// Mutation journal) assume a persisted store — so it exists ONLY behind the explicit testing
// acknowledgment (`@pgxsinkit/client/testing`), carried into option handling as the module-internal
// {@link TEST_STORE_BACKEND} symbol.
//
// This module is the ONLY place in the toolkit that assembles `idb://` / `file://` / `memory://` / `opfs://`
// URLs (the export machinery's throwaway clone is the one other internal `memory://` site). A
// resolved URL is internal plumbing: it never leaks into config, results, reports, or errors as something a
// consumer could copy back into a storePath — hence the scheme-rejection guard below fails the old contract
// loudly at the boundary rather than silently re-interpreting it.
//
// Under ADR-0049 (capability-driven engine placement) it also owns the browser-side STORE IDENTITY encoding
// and the disjoint OPFS namespaces the placement probe, the commitment marker, and the store meta record all
// key on. `storeIdentityComponent` is the one injective encoding for every browser-side identity surface
// (OPFS namespace entries, leader lock, meta record key, communication-centre SharedWorker name; D11), and the
// `pgxsinkit/stores|commitments|probe` namespace builders are the one place those names live (D6).

/**
 * Thrown when a `storePath` is not a plain name (ADR-0036 decision 1): it carries a URL scheme (`://`) or
 * is empty/whitespace-only. A distinct type — not a bare `Error` — so a caller can `instanceof`-branch the
 * old dataDir-URL contract from a genuine store failure. The message names the plain-path contract and
 * shows the corrected form, without echoing a resolvable URL a consumer might imitate.
 */
export class InvalidStorePathError extends Error {
  constructor(message: string) {
    super(`[pgxsinkit] ${message}`);
    this.name = "InvalidStorePathError";
  }
}

/**
 * Thrown when a caller-owned PGlite handed to {@link CreateSyncClientOptions.pgliteInstance} /
 * {@link CreateSyncClientOptions.precreatedPglite} is PROVABLY non-persistent (ADR-0036 decision 4): its
 * `dataDir` is `undefined` (PGlite's in-memory default — the `new PGlite()` a copy-paste reaches) or begins
 * `memory://`. Names both the why (durability semantics assume a persisted store) and the two exits, so a
 * consumer is never left guessing which store to hand us instead.
 */
export class NonPersistentStoreError extends Error {
  constructor(observed: "in-memory-default" | "memory-scheme") {
    const reason =
      observed === "in-memory-default"
        ? "its dataDir is undefined — PGlite's default is an in-memory store (`new PGlite()`)"
        : "its dataDir is a memory-backed store";
    super(
      `[pgxsinkit] refusing a non-persistent PGlite instance: ${reason}. pgxsinkit's durability semantics ` +
        "(persistent retention, the optimistic Mutation journal) assume a persisted store — a memory store " +
        "would silently forget acked-but-unflushed writes. Either hand a persisted instance (open it under a " +
        "plain store path so the backend is derived), or, for a test/ephemeral store, acknowledge it with " +
        '`memoryStoreForTests` / `testStoreAcknowledgment` from "@pgxsinkit/client/testing" (ADR-0036).',
    );
    this.name = "NonPersistentStoreError";
  }
}

/**
 * Thrown when a restore (`restoreFrom`, ADR-0035 decision 6) targets a store path whose backend store ALREADY
 * exists. Restore is a CREATION-path feature — it boots a brand-new store on `loadDataDir` — and never
 * overlays a live store: silently merging a backup into an existing datadir would corrupt it. A distinct type
 * (not a bare `Error`) so a caller can `instanceof`-branch "target already there" from a genuine boot failure.
 * The remedy is a deliberate manual {@link SyncClient.destroy} of the existing store first (never automatic —
 * dropping a user's local store must be their explicit act).
 */
export class RestoreTargetExistsError extends Error {
  constructor(storePath: string) {
    super(
      `[pgxsinkit] refusing to restore into ${JSON.stringify(storePath)}: a store already exists at that path. ` +
        "Restore only ever boots a brand-new store (it never overlays an existing one — that would corrupt the " +
        "datadir). Destroy the existing store first (a deliberate `destroy()`), then restore into the now-fresh " +
        "path (ADR-0035 decision 6).",
    );
    this.name = "RestoreTargetExistsError";
  }
}

/**
 * The module-internal marker a testing helper stamps onto the options object so option handling can select
 * the memory backend / unlock the BYO refusal (ADR-0036 decision 3). `Symbol.for` (not a bare `Symbol()`)
 * on purpose: each public entry point is bundled STANDALONE (`scripts/build-public-packages.ts`,
 * `splitting: false`), so a plain module symbol would be DUPLICATED between the main bundle and the
 * `./testing` bundle — two distinct symbols, and the marker set by `./testing` would be invisible to the
 * main entry's reader. The global registry key guarantees ONE symbol across bundles. It is deliberately
 * absent from the main entry's exports and from every public type, so a production consumer cannot name it.
 */
export const TEST_STORE_BACKEND: unique symbol = Symbol.for("pgxsinkit.internal.testStoreBackend");

/**
 * What a testing helper's marker asks of option handling: `"memory"` mints a scheme-selected memory store
 * (and, being ours-under-the-covers, also unlocks the BYO refusal); `"acknowledged"` only unlocks the BYO
 * refusal for a caller who owns the (test) instance themselves. Both are visible, deliberate acts — an
 * import whose name says what it is.
 */
export type TestStoreMarker = "memory" | "acknowledged";

/** An options object that MAY carry the internal testing marker (read via {@link readTestStoreMarker}). */
export type WithTestStoreMarker = { [TEST_STORE_BACKEND]?: TestStoreMarker };

/** Read the internal testing marker off an options object, or `undefined` when none was stamped. */
export function readTestStoreMarker(options: unknown): TestStoreMarker | undefined {
  if (options == null || typeof options !== "object") return undefined;
  const marker = (options as WithTestStoreMarker)[TEST_STORE_BACKEND];
  return marker === "memory" || marker === "acknowledged" ? marker : undefined;
}

/**
 * What {@link createClientPGlite} (and any store-opening seam) accepts as its store argument: a plain
 * `storePath` string, or the option object a testing helper mints (`memoryStoreForTests(...)`) — carrying a
 * `storePath` plus the invisible internal marker. Accepting the object form is what lets the testing
 * helper's output flow STRAIGHT into `createClientPGlite(memoryStoreForTests("x"))` without a consumer ever
 * naming a backend.
 */
export type StorePathInput = string | ({ storePath: string } & WithTestStoreMarker);

/** Normalise a {@link StorePathInput} to a plain path plus any internal memory-backend override it carried. */
export function normaliseStorePathInput(input: StorePathInput): { storePath: string; backendOverride?: "memory" } {
  if (typeof input === "string") return { storePath: input };
  return {
    storePath: input.storePath,
    ...(readTestStoreMarker(input) === "memory" ? { backendOverride: "memory" as const } : {}),
  };
}

/**
 * The environment seam the backend derivation reads — factored out so a browser derivation is fakeable in
 * a Bun unit test (there is no `indexedDB` there). `hasIndexedDb` is the browser/worker signal: PGlite's
 * IndexedDB backend needs `indexedDB`, which a browser tab AND a Web/Shared/dedicated worker expose but
 * Bun/Node do not — so it distinguishes "run in the browser" (idb) from "run on the server" (filesystem)
 * without a DOM-lib dependency.
 */
export interface StoreEnv {
  hasIndexedDb: boolean;
  /**
   * ADR-0049 (D1): the PLACEMENT PROBE's injected result — whether a REAL `createSyncAccessHandle` open
   * succeeded in the executing scope (the bench phase-0 mechanism, performed by the async boot path — never
   * method-presence sniffing). Optional so every existing `StoreEnv` construction stays valid; `undefined`
   * means "no OPFS sync access" (false). {@link detectStoreEnv} ALWAYS reports `false` for it: there is no
   * synchronous ambient detection for handle grants, and method-presence sniffing is forbidden — only the
   * boot path's real probe open can flip it true.
   */
  hasOpfsSyncAccess?: boolean;
}

/** Detect the ambient store environment off `globalThis` (the library carries no DOM lib dependency). */
function detectStoreEnv(): StoreEnv {
  // `hasOpfsSyncAccess` is deliberately absent (false): the placement probe (an async handle open) is the
  // only honest source, and this synchronous ambient detector must never guess it (ADR-0049 D1).
  return { hasIndexedDb: typeof (globalThis as { indexedDB?: unknown }).indexedDB !== "undefined" };
}

/**
 * The shared plain-`storePath` boundary guard (ADR-0036 decision 1). A storePath is a PLAIN name, never a
 * storage URL: empty/whitespace-only or scheme-bearing (`://`) values fail loudly with
 * {@link InvalidStorePathError}. Factored so {@link resolveStoreDataDir} and {@link storeIdentityComponent}
 * share ONE message set (no drift between the two identity-surface entry points).
 */
function assertPlainStorePath(storePath: string): void {
  if (typeof storePath !== "string" || storePath.trim().length === 0) {
    throw new InvalidStorePathError(
      'invalid storePath: expected a non-empty plain store name (e.g. "my-app-store"); received an empty or whitespace-only value (ADR-0036).',
    );
  }
  if (storePath.includes("://")) {
    throw new InvalidStorePathError(
      `invalid storePath ${JSON.stringify(storePath)}: a store path is a plain name, not a storage URL. ` +
        'Pass just the name (e.g. "my-app-store") — the storage backend (capability-selected opfs-repacked ' +
        "with IndexedDB fallback in a browser, or the filesystem on Bun/Node) is derived for you; drop the " +
        "scheme prefix (ADR-0036/ADR-0049).",
    );
  }
}

/**
 * Resolve a plain {@link storePath} to the PGlite dataDir URL the store opens at — the ONE derivation point
 * (ADR-0036 decision 2, amended by ADR-0049). A browser worker with a proven OPFS sync-access grant resolves
 * to `opfs://<storePath>`; another browser context (`indexedDB` present) resolves to `idb://<storePath>`;
 * Bun/Node resolves to `file://<storePath>` (relative paths use the working directory). The `backendOverride`
 * is internal-only: `"memory"` selects a scheme-selected `memory://<storePath>` test/ephemeral store.
 *
 * Rejects a scheme-bearing or empty/whitespace-only path with {@link InvalidStorePathError} — the storePath
 * contract fails loudly at the boundary, never silently re-interpreted. The returned URL is
 * internal plumbing; do not surface it to consumers as something to imitate.
 *
 * CRITICAL (ADR-0036 decision 5, probed on PGlite 0.5.4): memory selection is ALWAYS the scheme-selected
 * `memory://` form, NEVER PGlite's explicit `fs: new MemoryFS()` option — `dumpDataDir` from an explicit-`fs`
 * instance silently omits relation files created after initdb, so a restored clone raises "relation does not
 * exist". Callers that need a memory store must route through this function, never construct `MemoryFS`.
 *
 * ADR-0049 (D1) adds the `opfs://<storePath>` form: when the placement probe granted a sync-access handle in
 * the executing scope (`env.hasOpfsSyncAccess`), the browser store lives on `opfs-repacked`. Precedence:
 * memory override (test/ephemeral) → `opfs://` (probe granted) → `idb://` (browser, handle denied) →
 * `file://` (Bun/Node). `opfs://` is TOOLKIT-INTERNAL plumbing — PGlite does NOT accept it as a `dataDir`;
 * {@link createClientPGlite} (plan step 10) interprets it via the opfs-repacked factory + the OPFS namespace
 * builders below. Like every URL resolved here, it never leaks to consumers.
 */
export function resolveStoreDataDir(
  storePath: string,
  backendOverride?: "memory",
  env: StoreEnv = detectStoreEnv(),
): string {
  assertPlainStorePath(storePath);
  if (backendOverride === "memory") return `memory://${storePath}`;
  if (env.hasOpfsSyncAccess) return `opfs://${storePath}`;
  return env.hasIndexedDb ? `idb://${storePath}` : `file://${storePath}`;
}

/**
 * The per-component ENCODED length cap for {@link storeIdentityComponent}. A filesystem-safe bound for a
 * single OPFS name component; the fixed container/namespace names (`pgxsinkit`, `stores`, `commitments`,
 * `probe`) are SEPARATE path components and add nothing to this budget. Encoding is what is capped, not the
 * raw input — a short multi-byte name can expand past the bound.
 */
const STORE_IDENTITY_ENCODED_CAP = 128;

/**
 * The ONE injective encoding for every browser-side identity surface (ADR-0049 D11, invariant 10): OPFS
 * namespace entries ({@link opfsStoreDirectoryPath} / {@link opfsCommitmentSentinelPath}), the leader lock
 * name, the store meta record key, and the communication-centre SharedWorker name all derive from this single
 * canonical component. Percent-encoding (`encodeURIComponent`) — injective, never lossy sanitising, so two
 * distinct store paths can never collapse to one identity (e.g. `"foo/bar"` → `foo%2Fbar` vs the literal
 * `"foo%2Fbar"` → `foo%252Fbar`).
 *
 * Domain (invariant 10):
 * - Same boundary guards as {@link resolveStoreDataDir}: empty/whitespace-only or scheme-bearing (`://`)
 *   paths throw {@link InvalidStorePathError} (shared {@link assertPlainStorePath}).
 * - A lone UTF-16 surrogate makes `encodeURIComponent` raise a `URIError`; that is wrapped into
 *   {@link InvalidStorePathError} so callers branch one error type at the boundary.
 * - `.` and `..` pass through `encodeURIComponent` UNCHANGED, but the File System Standard reserves them as
 *   invalid file names, so both are rejected.
 * - The ENCODED length is capped at {@link STORE_IDENTITY_ENCODED_CAP} (a per-component filesystem-safe
 *   bound); overflow is rejected.
 */
export function storeIdentityComponent(storePath: string): string {
  assertPlainStorePath(storePath);
  let identity: string;
  try {
    identity = encodeURIComponent(storePath);
  } catch (error) {
    // The only `encodeURIComponent` failure is a lone UTF-16 surrogate (`URIError`); rewrap it so the domain
    // presents ONE error type at the boundary (never a bare `URIError`).
    if (error instanceof URIError) {
      throw new InvalidStorePathError(
        `invalid storePath ${JSON.stringify(storePath)}: it contains a lone UTF-16 surrogate, which has no ` +
          "valid encoding as a store identity (ADR-0049).",
      );
    }
    throw error;
  }
  if (identity === "." || identity === "..") {
    throw new InvalidStorePathError(
      `invalid storePath ${JSON.stringify(storePath)}: "." and ".." are reserved file names (File System ` +
        "Standard) and cannot be a store identity (ADR-0049).",
    );
  }
  if (identity.length > STORE_IDENTITY_ENCODED_CAP) {
    throw new InvalidStorePathError(
      `invalid storePath ${JSON.stringify(storePath)}: its encoded store identity is ${identity.length} ` +
        `characters, over the ${STORE_IDENTITY_ENCODED_CAP}-character per-component cap (ADR-0049). Note the ` +
        "cap is on the ENCODED form — a short multi-byte name can expand past it.",
    );
  }
  return identity;
}

/**
 * The toolkit-owned OPFS container at the root (ADR-0049 D6). Its child namespaces (`stores`, `commitments`,
 * `probe`) are DISJOINT so two valid identities can never contend for one OPFS entry (e.g. store `"foo"`'s
 * commitment sentinel vs a store literally named `"foo.committed"`). This module is the ONLY place that knows
 * these names — the same rule that keeps {@link storeIndexedDbDatabaseName} the sole owner of the `/pglite/`
 * prefix.
 */
export const OPFS_TOOLKIT_CONTAINER = "pgxsinkit";

/**
 * OPFS path (segment array) of a store's four-file VFS directory: `pgxsinkit/stores/<identity>` (ADR-0049 D6).
 * Returned as SEGMENTS, not a joined string, because consumers traverse OPFS via a `getDirectoryHandle` chain.
 */
export function opfsStoreDirectoryPath(storePath: string): readonly [string, string, string] {
  return [OPFS_TOOLKIT_CONTAINER, "stores", storeIdentityComponent(storePath)];
}

/**
 * OPFS path (segment array) of a store's commitment marker sentinel: `pgxsinkit/commitments/<identity>`
 * (ADR-0049 D6). Disjoint from {@link opfsStoreDirectoryPath} — the store directory holds exactly the four
 * VFS-owned files, and a suffix-sibling sentinel would collide across valid identities. Segments, not a joined
 * string, for the same `getDirectoryHandle`-chain reason.
 */
export function opfsCommitmentSentinelPath(storePath: string): readonly [string, string, string] {
  return [OPFS_TOOLKIT_CONTAINER, "commitments", storeIdentityComponent(storePath)];
}

/**
 * OPFS path (segment array) of the placement-probe scratch namespace: `pgxsinkit/probe` (ADR-0049 D6). No
 * identity — the probe is per-SharedWorker-scope, not per-store. Segments, not a joined string.
 */
export function opfsProbeDirectoryPath(): readonly [string, string] {
  return [OPFS_TOOLKIT_CONTAINER, "probe"];
}

/**
 * The IndexedDB database name a browser store occupies (ADR-0036) — a browser-only OPERATIONAL helper for
 * orphan GC / corrupt-store deletion (`indexedDB.deleteDatabase(...)`), NOT part of the create path. PGlite
 * maps `idb://<storePath>` to the IndexedDB database `/pglite/<storePath>` (its `WASM_PREFIX` `/pglite`
 * joined with the path after the scheme; verified against `@electric-sql/pglite` 0.5.4 dist). Exposed so a
 * consumer that GCs its own stores routes that PGlite-internal naming knowledge through the library rather
 * than re-deriving the `/pglite/` prefix itself. Rejects a scheme-bearing/empty path exactly as
 * {@link resolveStoreDataDir} does, so the two stay in lockstep.
 */
export function storeIndexedDbDatabaseName(storePath: string): string {
  if (typeof storePath !== "string" || storePath.trim().length === 0) {
    throw new InvalidStorePathError(
      "invalid storePath: storeIndexedDbDatabaseName expects a non-empty plain store name (ADR-0036).",
    );
  }
  if (storePath.includes("://")) {
    throw new InvalidStorePathError(
      `invalid storePath ${JSON.stringify(storePath)}: storeIndexedDbDatabaseName expects a plain name, not a storage URL (ADR-0036).`,
    );
  }
  return `/pglite/${storePath}`;
}

/**
 * Classify a PGlite instance's `dataDir` for the BYO refusal (ADR-0036 decision 4). Returns the offending
 * shape when the instance is PROVABLY non-persistent (`undefined` = PGlite's in-memory default; a
 * `memory://` prefix = an explicit memory store), or `null` when it passes — anything else present,
 * including exotic custom-VFS configs we cannot classify, is the caller's own call (the guard catches the
 * two accidental non-persistent shapes, it is not a storage-backend whitelist).
 */
export function classifyNonPersistentDataDir(
  dataDir: string | undefined,
): "in-memory-default" | "memory-scheme" | null {
  if (dataDir == null) return "in-memory-default";
  if (dataDir.startsWith("memory://")) return "memory-scheme";
  return null;
}

/**
 * The minimal structural shape of an OPFS `FileSystemDirectoryHandle` this module traverses — just the
 * never-creating `getDirectoryHandle` hop. Declared locally so the module carries no DOM lib dependency
 * (matching how the rest of it reads capabilities structurally off `globalThis`).
 */
interface OpfsDirectoryHandle {
  getDirectoryHandle(name: string, options: { create: false }): Promise<OpfsDirectoryHandle>;
}

/**
 * Does either backend a browser boot could own for a plain {@link storePath} ALREADY exist? The fresh-target
 * gate for a restore (ADR-0035 decision 6) — restore refuses a target that is already there. Per backend:
 *
 * - **memory** (`backendOverride === "memory"`) — a scheme-selected memory store is fresh by construction:
 *   it lives only for the instance about to be created, so there is nothing to collide with. Always `false`
 *   (the sanctioned test/ephemeral lane never blocks a restore).
 * - **`file://`** (Bun/Node) — filesystem existence of the datadir directory. `node:fs` is imported
 *   DYNAMICALLY inside this branch, never at module top level, so a browser bundle (which only ever hits the
 *   `idb://` branch below) never pulls `node:fs` in. Relative paths resolve against the working directory,
 *   exactly as PGlite's filesystem backend and {@link resolveStoreDataDir} do.
 * - **`opfs://`** (browser, placement probe granted) — existence of the store DIRECTORY at
 *   `pgxsinkit/stores/<identity>` ({@link opfsStoreDirectoryPath}), walked via
 *   `navigator.storage.getDirectory()` and a `getDirectoryHandle` chain with `{ create: false }`. This is
 *   ONLY the fresh-target gate; it is emphatically NOT commitment authority — a store directory without a
 *   commitment marker is an uncommitted CANDIDATE, and deciding that is the store meta record's phase machine
 *   (plan step 2), never this function. `navigator.storage`/`getDirectory` absent → best-effort `false`
 *   (mirrors the idb `databases()` stance — never fabricate a positive). A `NotFoundError` anywhere in the
 *   chain → `false`; any OTHER error propagates (a genuine failure the restore caller must see).
 *   A missing OPFS directory does not finish a granted browser check: IDB is also probed, because a predecessor
 *   or fixed-placement store may still own the same public path.
 * - **`idb://`** (browser/worker) — `indexedDB.databases()` enumerated for the store's database name
 *   ({@link storeIndexedDbDatabaseName}). BEST-EFFORT: `databases()` is unavailable on some engines (older
 *   Firefox, certain worker contexts); when absent we CANNOT prove existence, so we report `false` and let
 *   the restore proceed rather than fabricate a result — a real overlay collision would still surface as a
 *   PGlite-level boot failure. We never fake a positive.
 */
export async function storeTargetExists(
  storePath: string,
  backendOverride?: "memory",
  env: StoreEnv = detectStoreEnv(),
): Promise<boolean> {
  const dataDir = resolveStoreDataDir(storePath, backendOverride, env);
  if (dataDir.startsWith("memory://")) return false;
  if (dataDir.startsWith("file://")) {
    // The datadir path is everything after the `file://` scheme; `node:fs` handles absolute and
    // cwd-relative paths identically to PGlite's own filesystem backend.
    const path = dataDir.slice("file://".length);
    const { existsSync } = await import("node:fs");
    return existsSync(path);
  }
  if (dataDir.startsWith("opfs://")) {
    // Structural typing off `globalThis` — no DOM lib dependency (like the rest of the module).
    const storage = (
      globalThis as {
        navigator?: {
          storage?: { getDirectory?: () => Promise<OpfsDirectoryHandle> };
        };
      }
    ).navigator?.storage;
    // API absent → best-effort false (never a fabricated positive), same stance as idb `databases()`.
    if (storage?.getDirectory != null) {
      const segments = opfsStoreDirectoryPath(storePath);
      try {
        let handle = await storage.getDirectory();
        for (const segment of segments) {
          // Never-creating existence walk: `{ create: false }` at every hop — this is a gate, not a mkdir.
          handle = await handle.getDirectoryHandle(segment, { create: false });
        }
        return true;
      } catch (error) {
        // A missing entry anywhere in the chain proves OPFS absence; anything else is a real failure to surface.
        if ((error as { name?: string }).name !== "NotFoundError") throw error;
      }
    }
    // A granted browser must also reject an IDB predecessor at this path; fall through to the shared IDB probe.
  }
  // `idb://` — enumerate the IndexedDB databases for this store's database name. `databases()` is optional in
  // the spec, so guard it: when absent, best-effort `false` (documented above), never a fabricated positive.
  const idb = (globalThis as { indexedDB?: { databases?: () => Promise<Array<{ name?: string }>> } }).indexedDB;
  if (idb?.databases == null) return false;
  const target = storeIndexedDbDatabaseName(storePath);
  const databases = await idb.databases();
  return databases.some((db) => db.name === target);
}

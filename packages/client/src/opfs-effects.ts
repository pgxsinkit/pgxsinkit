// The REAL OPFS effects for the store-boot wiring (ADR-0049 capability-driven engine placement, plan
// step 10a). `store-lifecycle.ts` owns the PURE, effect-injected destruction/adoption/fresh-candidate
// machines; `store-boot.ts` assembles observations and executes their verdicts. This module is the concrete
// OPFS side those verdicts drive: create/delete the commitment sentinel, delete the store directory, observe
// the commitment namespace without creating anything, and hand the store directory handle to the
// opfs-repacked factory.
//
// It carries NO DOM lib dependency — the OPFS surface is typed STRUCTURALLY off `globalThis`, exactly as
// `store-path.ts` and `placement-probe.ts` do. Every path is built ONLY from `store-path.ts`'s namespace
// builders ({@link opfsCommitmentSentinelPath}, {@link opfsStoreDirectoryPath}) — this module never
// re-derives an OPFS name. Every effect is IDEMPOTENT per the store-lifecycle contracts it satisfies:
// create-if-absent (publishSentinel, getStoreDirectoryHandle) and delete-if-present with `NotFoundError`
// swallowed (deleteSentinel, deleteStoreDirectory). `observeCommitmentNamespace` never creates and never
// throws — a root/API failure reads as `"unobservable"` (present absence is not historical proof).

import { opfsCommitmentSentinelPath, opfsStoreDirectoryPath } from "./store-path";

/**
 * The minimal structural shape of an OPFS `FileSystemDirectoryHandle` this module traverses: the
 * create-or-not `getDirectoryHandle`/`getFileHandle` hops and the recursive `removeEntry`. Declared locally
 * so the module carries no DOM lib dependency (the pattern the rest of the toolkit uses for OPFS handles).
 */
export interface DirLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<unknown>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

/** The injectable seam so Bun unit tests fake the OPFS root (there is no real OPFS there). */
export interface OpfsEffectsDeps {
  /**
   * The OPFS root getter. Omit in production: the default reads `navigator.storage.getDirectory` off
   * `globalThis` (structural, no DOM lib). Absent API → the delete effects are no-ops, `observe` is
   * `"unobservable"`, and the create effects throw (they are only reached in the opfs engine home).
   */
  getRoot?: () => Promise<DirLike>;
}

/** The effects surface the store-boot wiring drives (create-if-absent / delete-if-present / never-creating observe). */
export interface OpfsEffects {
  /** Create-if-absent the commitment sentinel file at `pgxsinkit/commitments/<identity>`. */
  publishSentinel(): Promise<void>;
  /** Delete-if-present the commitment sentinel (`NotFoundError` swallowed). */
  deleteSentinel(): Promise<void>;
  /** Recursively delete-if-present the store directory `pgxsinkit/stores/<identity>` (`NotFoundError` swallowed). */
  deleteStoreDirectory(): Promise<void>;
  /**
   * Never-creating walk of the commitment namespace. A root/API failure (or the API being absent) reads as
   * `"unobservable"` — this method NEVER throws.
   */
  observeCommitmentNamespace(): Promise<{ sentinelPresent: boolean; storeDirectoryPresent: boolean } | "unobservable">;
  /** Create-if-absent chain to the store directory, returning its handle for the opfs-repacked factory. */
  getStoreDirectoryHandle(): Promise<unknown>;
}

/** Is this a `NotFoundError` (a missing OPFS entry) — the delete/observe "absent" signal? */
function isNotFoundError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "NotFoundError";
}

/** Resolve the default OPFS root getter off `globalThis`, or `null` when the API is absent. */
function resolveDefaultGetRoot(): (() => Promise<DirLike>) | null {
  const storage = (globalThis as { navigator?: { storage?: { getDirectory?: () => Promise<DirLike> } } }).navigator
    ?.storage;
  const getDirectory = storage?.getDirectory;
  if (getDirectory == null) return null;
  return () => getDirectory.call(storage);
}

/**
 * Construct the real OPFS effects for a store, all under `store-path.ts`'s disjoint namespaces. The returned
 * object's methods satisfy the idempotency contracts the `store-lifecycle.ts` machines require, so a boot that
 * resumes an interrupted destruction/candidate/adoption re-runs them safely.
 */
export function createOpfsEffects(storePath: string, deps?: OpfsEffectsDeps): OpfsEffects {
  const getRoot = deps?.getRoot ?? resolveDefaultGetRoot();

  // Walk (optionally creating) a chain of directory segments, returning the leaf handle. Throws when the OPFS
  // API is absent — only the create paths call it in that state, and they are only reached in the opfs home.
  async function walkDirectories(segments: readonly string[], create: boolean): Promise<DirLike> {
    if (getRoot == null) throw new Error("[pgxsinkit] OPFS root is unavailable in this scope");
    let handle = await getRoot();
    for (const segment of segments) handle = await handle.getDirectoryHandle(segment, { create });
    return handle;
  }

  // Never-creating existence check for one namespace entry; `NotFoundError` anywhere in the chain → absent.
  async function entryExists(path: readonly string[], kind: "file" | "dir"): Promise<boolean> {
    try {
      let handle = await getRoot!();
      const lastIndex = path.length - 1;
      for (let i = 0; i < path.length; i += 1) {
        const segment = path[i]!;
        if (i === lastIndex && kind === "file") {
          await handle.getFileHandle(segment, { create: false });
          return true;
        }
        handle = await handle.getDirectoryHandle(segment, { create: false });
      }
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return false;
      // A non-NotFound failure means we cannot tell — let `observeCommitmentNamespace` map it to "unobservable".
      throw error;
    }
  }

  return {
    async publishSentinel(): Promise<void> {
      const path = opfsCommitmentSentinelPath(storePath);
      const parent = await walkDirectories(path.slice(0, -1), true);
      // Create-if-absent: the sentinel is a marker file; re-publishing over an existing one is a no-op success.
      await parent.getFileHandle(path[path.length - 1]!, { create: true });
    },

    async deleteSentinel(): Promise<void> {
      if (getRoot == null) return;
      const path = opfsCommitmentSentinelPath(storePath);
      try {
        const parent = await walkDirectories(path.slice(0, -1), false);
        await parent.removeEntry(path[path.length - 1]!);
      } catch (error) {
        // Delete-if-present: a missing parent dir or a missing sentinel both count as already deleted.
        if (!isNotFoundError(error)) throw error;
      }
    },

    async deleteStoreDirectory(): Promise<void> {
      if (getRoot == null) return;
      const path = opfsStoreDirectoryPath(storePath);
      try {
        const parent = await walkDirectories(path.slice(0, -1), false);
        // Recursive: the store directory holds the four VFS-owned files; the whole leaf goes.
        await parent.removeEntry(path[path.length - 1]!, { recursive: true });
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    },

    async observeCommitmentNamespace(): Promise<
      { sentinelPresent: boolean; storeDirectoryPresent: boolean } | "unobservable"
    > {
      if (getRoot == null) return "unobservable";
      try {
        const sentinelPresent = await entryExists(opfsCommitmentSentinelPath(storePath), "file");
        const storeDirectoryPresent = await entryExists(opfsStoreDirectoryPath(storePath), "dir");
        return { sentinelPresent, storeDirectoryPresent };
      } catch {
        // Root open failed or an entry check raised something other than NotFound: we cannot observe the
        // namespace honestly, so report "unobservable" (present absence is not proof) — never throw.
        return "unobservable";
      }
    },

    getStoreDirectoryHandle(): Promise<unknown> {
      // Create-if-absent chain to `pgxsinkit/stores/<identity>`, returning the leaf handle for the factory.
      return walkDirectories(opfsStoreDirectoryPath(storePath), true);
    },
  };
}

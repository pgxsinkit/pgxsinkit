import { describe, expect, test } from "bun:test";

import { FsError, StoreLimitError } from "../../packages/pglite-opfs-repacked/src/core/errors";
import { MAX_COMPONENT_BYTES, MAX_U64 } from "../../packages/pglite-opfs-repacked/src/core/limits";
import { parsePath } from "../../packages/pglite-opfs-repacked/src/core/path";
import {
  applyTxn,
  createInitialState,
  estimateMetadataBasePayloadBytes,
  getInodeAtPath,
  makeOrphanRecord,
  planChmod,
  planCreateFile,
  planMkdir,
  planRename,
  planReserveQuarantine,
  planResizeFile,
  planResizeFileForInode,
  planRmdir,
  planUnlink,
  planUtimes,
  prepareTxnProjection,
  preflightTxn,
  projectRepack,
  projectRepackForActivation,
  canonicalStateView,
  validateState,
} from "../../packages/pglite-opfs-repacked/src/core/state-machine";
import type { TxnRecord } from "../../packages/pglite-opfs-repacked/src/core/state-machine";
import type { VfsState } from "../../packages/pglite-opfs-repacked/src/core/state-machine";
import { ReferenceFs } from "../../packages/pglite-opfs-repacked/test/support/reference-fs";

function observableEntries(state: VfsState): unknown[] {
  const entries: unknown[] = [];
  const walk = (inodeId: bigint, path: string) => {
    const inode = state.inodes.get(inodeId);
    if (inode === undefined) {
      throw new Error("missing inode");
    }
    entries.push({
      path,
      kind: inode.kind,
      mode: inode.mode,
      atimeMs: inode.atimeMs,
      mtimeMs: inode.mtimeMs,
      ctimeMs: inode.ctimeMs,
      size: inode.kind === "file" ? inode.size : 0n,
    });
    if (inode.kind === "directory") {
      for (const [name, childId] of [...inode.children].sort(([left], [right]) => left.localeCompare(right))) {
        walk(childId, path === "/" ? `/${name}` : `${path}/${name}`);
      }
    }
  };
  walk(state.rootInodeId, "/");
  return entries;
}

describe("opfs-repacked pure state machine", () => {
  test("inode-first resize planning is identical to path-based planning", () => {
    const state = createInitialState(8192);
    applyTxn(state, planCreateFile(state, "/file", { nowMs: 1n, size: 8192n }).record);
    const inode = getInodeAtPath(state, "/file");
    if (inode.kind !== "file") throw new Error("expected file inode");

    expect(planResizeFileForInode(state, inode, 24_576n, 2n, "write")).toEqual(
      planResizeFile(state, "/file", 24_576n, 2n, "write"),
    );
    expect(planResizeFileForInode(state, inode, 0n, 3n, "truncate")).toEqual(
      planResizeFile(state, "/file", 0n, 3n, "truncate"),
    );
  });

  test("live apply can reuse its exact preflight while replay always recomputes it", () => {
    const live = createInitialState(8192);
    const record = planCreateFile(live, "/file", { nowMs: 1n, size: 8192n }).record;
    const prepared = prepareTxnProjection(live, record);
    const projectedBasePayloadBytes = prepared.projectedBasePayloadBytes;
    applyTxn(live, record, prepared);
    expect(live.basePayloadBytes).toBe(projectedBasePayloadBytes);

    const replayed = createInitialState(8192);
    const replayBasePayloadBytes = replayed.basePayloadBytes;
    expect(() => applyTxn(replayed, record, prepared)).toThrow("does not match the live transition");
    expect(replayed.basePayloadBytes).toBe(replayBasePayloadBytes);
    applyTxn(replayed, record);
    expect(replayed.basePayloadBytes).toBe(projectedBasePayloadBytes);
  });

  test("the independent reference model renames a complete directory subtree", () => {
    const reference = new ReferenceFs();
    reference.mkdir("/source", 0o40700, 1n);
    reference.mkdir("/source/nested", 0o40701, 2n);
    reference.createFile("/source/nested/value", 0o100600, 7n, 3n);

    reference.rename("/source", "/destination", 4n);

    expect(reference.entries()).toContainEqual({
      path: "/destination/nested/value",
      kind: "file",
      mode: 0o100600,
      atimeMs: 3n,
      mtimeMs: 3n,
      ctimeMs: 3n,
      size: 7n,
    });
    expect(reference.entries().some((entry) => String((entry as { path: string }).path).startsWith("/source"))).toBe(
      false,
    );
  });

  test("recursive mkdir records every choice and replays to exactly the same state", () => {
    const live = createInitialState(8192);
    const before = canonicalStateView(live);

    const plan = planMkdir(live, "/__proto__/nested", {
      mode: 0,
      nowMs: 42n,
      recursive: true,
    });

    expect(canonicalStateView(live)).toEqual(before);
    expect(plan.record.kind).toBe("createDirectories");
    applyTxn(live, plan.record);
    validateState(live);

    const parent = getInodeAtPath(live, "/__proto__");
    const nested = getInodeAtPath(live, "/__proto__/nested");
    expect(parent.kind).toBe("directory");
    expect(nested.kind).toBe("directory");
    expect(nested.mode).toBe(0);
    expect(nested.atimeMs).toBe(42n);
    expect(nested.mtimeMs).toBe(42n);
    expect(nested.ctimeMs).toBe(42n);

    const replayed = createInitialState(8192);
    applyTxn(replayed, plan.record);
    expect(canonicalStateView(replayed)).toEqual(canonicalStateView(live));
  });

  test("the path parser treats root explicitly and rejects non-canonical paths", () => {
    expect(parsePath("/")).toEqual([]);
    expect(parsePath("/__proto__")).toEqual(["__proto__"]);

    for (const path of ["", "relative", "/a/", "/a//b", "/./a", "/a/../b", "/a\0b"]) {
      expect(() => parsePath(path)).toThrow();
    }
    expect(() => parsePath("/\ud800")).toThrow();
  });

  test("invalid numeric inputs are rejected without state mutation", () => {
    expect(() => createInitialState(8193)).toThrow(TypeError);
    const state = createInitialState(8192);
    const before = canonicalStateView(state);

    expect(() => planMkdir(state, "/bad-mode", { mode: Number.NaN, nowMs: 1n })).toThrow();
    expect(() => planMkdir(state, "/negative-time", { nowMs: -1n })).toThrow(StoreLimitError);
    expect(() => planCreateFile(state, "/huge", { nowMs: 1n, size: 1n << 64n })).toThrow(StoreLimitError);
    expect(canonicalStateView(state)).toEqual(before);
  });

  test("an invalid record is rejected before it can mutate the input state", () => {
    const state = createInitialState(8192);
    const valid = planMkdir(state, "/first/second", {
      nowMs: 7n,
      recursive: true,
    }).record;
    const invalid = {
      ...valid,
      entries: [valid.entries[0]!, { ...valid.entries[1]!, parentId: 999n }],
    };
    const before = canonicalStateView(state);

    expect(() => applyTxn(state, invalid)).toThrow();
    expect(canonicalStateView(state)).toEqual(before);
  });

  test("a freed extent crosses two physical metadata replacements before reuse", () => {
    const state = createInitialState(8192);
    applyTxn(
      state,
      planCreateFile(state, "/a", {
        mode: 0,
        nowMs: 11n,
        size: 8192n,
      }).record,
    );
    validateState(state);
    const file = getInodeAtPath(state, "/a");
    expect(file.kind).toBe("file");
    if (file.kind !== "file") {
      throw new Error("expected file");
    }
    expect(file.extents).toEqual([0n]);
    expect(state.allocator.ownedBy.get(0n)).toBe(file.id);

    applyTxn(state, planUnlink(state, "/a", 12n).record);
    validateState(state);
    expect(() => getInodeAtPath(state, "/a")).toThrow();
    expect(state.allocator.quarantine.get(0n)).toBeNull();
    expect(state.allocator.available.has(0n)).toBe(false);

    const first = projectRepack(state);
    expect(canonicalStateView(state)).not.toEqual(canonicalStateView(first));
    validateState(first);
    expect(first.generation).toBe(2n);
    expect(first.activeMetadataFile).toBe("b");
    expect(first.allocator.quarantine.get(0n)).toBe(2n);
    expect(first.allocator.available.has(0n)).toBe(false);
    first.allocator.quarantine.set(0n, 1n);
    expect(() => validateState(first)).toThrow(StoreLimitError);
    first.allocator.quarantine.set(0n, 2n);

    const second = projectRepack(first);
    validateState(second);
    expect(second.generation).toBe(3n);
    expect(second.activeMetadataFile).toBe("a");
    expect(second.allocator.quarantine.has(0n)).toBe(false);
    expect(second.allocator.available.has(0n)).toBe(false);
    expect(second.allocator.totalExtents).toBe(0n);
  });

  test("repack projection maintains fixed-width quarantine sizing incrementally", () => {
    const state = createInitialState(8192);
    applyTxn(state, planCreateFile(state, "/released", { nowMs: 1n, size: 1n }).record);
    applyTxn(state, planCreateFile(state, "/tail-owner", { nowMs: 2n, size: 1n }).record);
    applyTxn(state, planUnlink(state, "/released", 3n).record);
    const untaggedBytes = state.basePayloadBytes;

    const tagged = projectRepack(state);
    expect(tagged.allocator.quarantine.get(0n)).toBe(tagged.generation);
    expect(tagged.basePayloadBytes).toBe(untaggedBytes);
    expect(tagged.basePayloadBytes).toBe(estimateMetadataBasePayloadBytes(tagged));

    const available = projectRepack(tagged);
    expect(available.allocator.quarantine.has(0n)).toBe(false);
    expect(available.allocator.available.has(0n)).toBe(true);
    expect(available.basePayloadBytes).toBe(tagged.basePayloadBytes - 8);
    expect(available.basePayloadBytes).toBe(estimateMetadataBasePayloadBytes(available));
  });

  test("activation projection matches the isolated projection without mutating its source", () => {
    const state = createInitialState(8192);
    applyTxn(state, planCreateFile(state, "/released", { nowMs: 1n, size: 1n }).record);
    applyTxn(state, planCreateFile(state, "/owner", { nowMs: 2n, size: 1n }).record);
    applyTxn(state, planUnlink(state, "/released", 3n).record);
    const before = canonicalStateView(state);

    const isolated = projectRepack(state);
    const activation = projectRepackForActivation(state);

    expect(canonicalStateView(activation)).toEqual(canonicalStateView(isolated));
    expect(canonicalStateView(state)).toEqual(before);
    validateState(activation);
  });

  test("runtime orphan extents stay untagged until descriptors release them", () => {
    const state = createInitialState(8192);
    applyTxn(state, planCreateFile(state, "/orphan", { nowMs: 1n, size: 1n }).record);
    applyTxn(state, planUnlink(state, "/orphan", 2n).record);
    const pinned = new Set([0n]);

    const first = projectRepack(state, pinned);
    const second = projectRepack(first, pinned);
    expect(first.allocator.quarantine.get(0n)).toBeNull();
    expect(second.allocator.quarantine.get(0n)).toBeNull();
    expect(second.allocator.totalExtents).toBe(1n);

    const releasedFirst = projectRepack(second);
    const releasedSecond = projectRepack(releasedFirst);
    expect(releasedFirst.allocator.quarantine.get(0n)).toBe(releasedFirst.generation);
    expect(releasedSecond.allocator.quarantine.has(0n)).toBe(false);
    expect(releasedSecond.allocator.totalExtents).toBe(0n);
  });

  test("the closed metadata operation set replays through one reducer", () => {
    const live = createInitialState(8192);
    const replayed = createInitialState(8192);
    const records: TxnRecord[] = [];
    const commit = (record: Parameters<typeof applyTxn>[1]) => {
      records.push(record);
      applyTxn(live, record);
      validateState(live);
    };

    commit(planMkdir(live, "/dir", { mode: 0, nowMs: 1n }).record);
    commit(planCreateFile(live, "/dir/a", { mode: 0, nowMs: 2n, size: 1n }).record);
    commit(planChmod(live, "/dir/a", 0o100600, 3n).record);
    commit(planUtimes(live, "/dir/a", 4n, 5n, 6n).record);
    commit(planResizeFile(live, "/dir/a", 9000n, 7n, "truncate").record);
    commit(planResizeFile(live, "/dir/a", 1n, 8n, "truncate").record);
    commit(planCreateFile(live, "/destination", { nowMs: 9n, size: 1n }).record);

    const destination = getInodeAtPath(live, "/destination");
    if (destination.kind !== "file") {
      throw new Error("expected destination file");
    }
    const replacedExtent = destination.extents[0]!;
    commit(planRename(live, "/dir/a", "/destination", 10n).record);
    commit(planRmdir(live, "/dir", 11n).record);

    const moved = getInodeAtPath(live, "/destination");
    expect(moved.kind).toBe("file");
    expect(moved.mode).toBe(0o100600);
    expect(moved.atimeMs).toBe(4n);
    expect(moved.mtimeMs).toBe(8n);
    expect(moved.ctimeMs).toBe(10n);
    expect(live.allocator.quarantine.get(replacedExtent)).toBeNull();
    expect(() => getInodeAtPath(live, "/dir")).toThrow();

    for (const record of records) {
      applyTxn(replayed, record);
    }
    validateState(replayed);
    expect(canonicalStateView(replayed)).toEqual(canonicalStateView(live));
  });

  test("orphan growth reserves chosen extents as persistent quarantine", () => {
    const state = createInitialState(8192);
    applyTxn(state, planCreateFile(state, "/old", { nowMs: 1n, size: 1n }).record);
    applyTxn(state, planUnlink(state, "/old", 2n).record);
    const reusable = projectRepack(projectRepack(state));

    const plan = planReserveQuarantine(reusable, 2);
    applyTxn(reusable, plan.record);
    validateState(reusable);

    expect(reusable.allocator.totalExtents).toBe(2n);
    expect(reusable.allocator.available.size).toBe(0);
    expect(reusable.allocator.quarantine.get(0n)).toBeNull();
    expect(reusable.allocator.quarantine.get(1n)).toBeNull();
  });

  test("frame and projected-base limits reject before state mutation", () => {
    const state = createInitialState(8192);
    const record = planMkdir(state, "/bounded", { nowMs: 1n }).record;
    const before = canonicalStateView(state);

    expect(() =>
      preflightTxn(state, record, {
        maxBasePayloadBytes: 1,
        maxFramePayloadBytes: 1,
      }),
    ).toThrow(StoreLimitError);
    expect(canonicalStateView(state)).toEqual(before);
  });

  test("inode counter exhaustion rejects before a plan or record can mutate state", () => {
    const exhausted = createInitialState(8192);
    exhausted.nextInodeId = MAX_U64;
    validateState(exhausted);
    const before = canonicalStateView(exhausted);

    expect(() => planCreateFile(exhausted, "/file", { nowMs: 1n })).toThrow(StoreLimitError);
    expect(() => planMkdir(exhausted, "/directory", { nowMs: 1n })).toThrow(StoreLimitError);
    expect(() =>
      applyTxn(exhausted, {
        kind: "createFile",
        parentId: exhausted.rootInodeId,
        name: "file",
        inodeId: MAX_U64,
        mode: 0,
        atimeMs: 1n,
        mtimeMs: 1n,
        ctimeMs: 1n,
        size: 0n,
        extents: [],
      }),
    ).toThrow(StoreLimitError);
    expect(canonicalStateView(exhausted)).toEqual(before);

    const oneRemaining = createInitialState(8192);
    oneRemaining.nextInodeId = MAX_U64 - 1n;
    const oneRemainingBefore = canonicalStateView(oneRemaining);
    expect(() => planMkdir(oneRemaining, "/a/b", { nowMs: 1n, recursive: true })).toThrow(StoreLimitError);
    expect(canonicalStateView(oneRemaining)).toEqual(oneRemainingBefore);
  });

  test("state validation rejects invalid persistent generation and inode identities", () => {
    const zeroGeneration = createInitialState(8192);
    zeroGeneration.generation = 0n;
    zeroGeneration.retainedGenerations.a = 0n;
    expect(() => validateState(zeroGeneration)).toThrow(StoreLimitError);

    const mismatchedKey = createInitialState(8192);
    const mismatchedRoot = mismatchedKey.inodes.get(1n)!;
    mismatchedKey.inodes.delete(1n);
    mismatchedKey.inodes.set(2n, mismatchedRoot);
    mismatchedKey.rootInodeId = 2n;
    expect(() => validateState(mismatchedKey)).toThrow(StoreLimitError);

    const reusedNextId = createInitialState(8192);
    const reusedRoot = reusedNextId.inodes.get(1n)!;
    reusedRoot.id = reusedNextId.nextInodeId;
    reusedNextId.inodes.delete(1n);
    reusedNextId.inodes.set(reusedRoot.id, reusedRoot);
    reusedNextId.rootInodeId = reusedRoot.id;
    expect(() => validateState(reusedNextId)).toThrow(StoreLimitError);
  });

  test("replay rejects an identical rename record before mutation", () => {
    const state = createInitialState(8192);
    applyTxn(state, planCreateFile(state, "/a", { nowMs: 1n }).record);
    const before = canonicalStateView(state);

    expect(() =>
      applyTxn(state, {
        kind: "rename",
        sourceParentId: state.rootInodeId,
        sourceName: "a",
        destinationParentId: state.rootInodeId,
        destinationName: "a",
        timestampMs: 2n,
      }),
    ).toThrow(FsError);
    expect(canonicalStateView(state)).toEqual(before);
  });

  test("renamed subtrees remain within reachable depth and full-path bounds", () => {
    const depthState = createInitialState(8192);
    const descendants = Array.from({ length: 31 }, (_, index) => `d${index}`);
    applyTxn(
      depthState,
      planMkdir(depthState, `/source/${descendants.join("/")}`, { nowMs: 1n, recursive: true }).record,
    );
    applyTxn(depthState, planMkdir(depthState, "/destination", { nowMs: 2n }).record);
    const destination = getInodeAtPath(depthState, "/destination");
    if (destination.kind !== "directory") throw new Error("expected destination directory");
    const depthBefore = canonicalStateView(depthState);

    expect(() => planRename(depthState, "/source", "/destination/source", 3n)).toThrow(FsError);
    expect(() =>
      applyTxn(depthState, {
        kind: "rename",
        sourceParentId: depthState.rootInodeId,
        sourceName: "source",
        destinationParentId: destination.id,
        destinationName: "source",
        timestampMs: 3n,
      }),
    ).toThrow(FsError);
    expect(canonicalStateView(depthState)).toEqual(depthBefore);

    const depthRoot = getInodeAtPath(depthState, "/");
    const source = getInodeAtPath(depthState, "/source");
    if (depthRoot.kind !== "directory" || source.kind !== "directory") {
      throw new Error("expected source and root directories");
    }
    depthRoot.children.delete("source");
    destination.children.set("source", source.id);
    depthState.parentByInode.set(source.id, {
      parentId: destination.id,
      name: "source",
    });
    expect(() => validateState(depthState)).toThrow(StoreLimitError);

    const lengthState = createInitialState(8192);
    const longSourceComponent = "x".repeat(MAX_COMPONENT_BYTES);
    const longDestinationComponent = "y".repeat(MAX_COMPONENT_BYTES);
    applyTxn(
      lengthState,
      planMkdir(lengthState, `/s/${longSourceComponent}/${longSourceComponent}/${longSourceComponent}`, {
        nowMs: 1n,
        recursive: true,
      }).record,
    );
    applyTxn(lengthState, planMkdir(lengthState, `/${longDestinationComponent}`, { nowMs: 2n }).record);
    const longDestination = getInodeAtPath(lengthState, `/${longDestinationComponent}`);
    if (longDestination.kind !== "directory") throw new Error("expected long destination directory");
    const lengthBefore = canonicalStateView(lengthState);

    expect(() => planRename(lengthState, "/s", `/${longDestinationComponent}/s`, 3n)).toThrow(FsError);
    expect(() =>
      applyTxn(lengthState, {
        kind: "rename",
        sourceParentId: lengthState.rootInodeId,
        sourceName: "s",
        destinationParentId: longDestination.id,
        destinationName: "s",
        timestampMs: 3n,
      }),
    ).toThrow(FsError);
    expect(canonicalStateView(lengthState)).toEqual(lengthBefore);
  });

  test("multi-seed random commands including directory moves match an independent reference filesystem", () => {
    for (const seed of [0x6d2b79f5, 0x12345678, 0xdeadbeef, 0x1]) {
      const state = createInitialState(8192);
      const replayed = createInitialState(8192);
      const reference = new ReferenceFs();
      const records: TxnRecord[] = [];
      const files: string[] = [];
      const directories: string[] = [];
      let nextName = 0;
      let nowMs = 1n;
      let randomState = seed;
      const random = () => {
        randomState = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
        randomState ^= randomState + Math.imul(randomState ^ (randomState >>> 7), 61 | randomState);
        return ((randomState ^ (randomState >>> 14)) >>> 0) / 4_294_967_296;
      };
      const choose = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
      const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";
      const childPath = (parent: string, prefix: string): string =>
        parent === "/" ? `/${prefix}${nextName++}` : `${parent}/${prefix}${nextName++}`;
      const commit = (record: TxnRecord) => {
        records.push(record);
        applyTxn(state, record);
        validateState(state);
        expect(state.basePayloadBytes).toBe(estimateMetadataBasePayloadBytes(state));
        expect(observableEntries(state)).toEqual(reference.entries());
      };

      for (let step = 0; step < 350; step += 1) {
        const action = files.length === 0 ? 0 : Math.floor(random() * 10);
        nowMs += 1n;
        if (action === 0) {
          const parent = choose(["/", ...directories.filter((path) => path.split("/").length < 5)]);
          const path = childPath(parent, "f");
          const size = BigInt(Math.floor(random() * 20_000));
          const mode = Math.floor(random() * 0x1ff);
          const record = planCreateFile(state, path, { mode, nowMs, size }).record;
          reference.createFile(path, mode, size, nowMs);
          files.push(path);
          commit(record);
        } else if (action === 1) {
          const path = choose(files);
          const size = BigInt(Math.floor(random() * 24_000));
          const record = planResizeFile(state, path, size, nowMs, "truncate").record;
          reference.resize(path, size, nowMs);
          commit(record);
        } else if (action === 2) {
          const path = choose([...files, ...directories]);
          const mode = Math.floor(random() * 0x1ff);
          const record = planChmod(state, path, mode, nowMs).record;
          reference.chmod(path, mode, nowMs);
          commit(record);
        } else if (action === 3) {
          const path = choose([...files, ...directories]);
          const record = planUtimes(state, path, nowMs, nowMs + 1n, nowMs + 2n).record;
          reference.utimes(path, nowMs, nowMs + 1n, nowMs + 2n);
          commit(record);
        } else if (action === 4) {
          const index = Math.floor(random() * files.length);
          const oldPath = files[index]!;
          const parent = choose(["/", ...directories]);
          const newPath = childPath(parent, "f");
          const record = planRename(state, oldPath, newPath, nowMs).record;
          reference.rename(oldPath, newPath, nowMs);
          files[index] = newPath;
          commit(record);
        } else if (action === 5) {
          const index = Math.floor(random() * files.length);
          const path = files[index]!;
          const record = planUnlink(state, path, nowMs).record;
          reference.unlink(path, nowMs);
          files.splice(index, 1);
          commit(record);
        } else if (action === 6) {
          const parent = choose(["/", ...directories.filter((path) => path.split("/").length < 5)]);
          const path = childPath(parent, "d");
          const mode = Math.floor(random() * 0x1ff);
          const record = planMkdir(state, path, { mode, nowMs }).record;
          reference.mkdir(path, mode, nowMs);
          directories.push(path);
          commit(record);
        } else if (action === 7) {
          const empty = directories.filter(
            (path) =>
              !files.some((file) => parentOf(file) === path) && !directories.some((dir) => parentOf(dir) === path),
          );
          if (empty.length === 0) continue;
          const path = choose(empty);
          const record = planRmdir(state, path, nowMs).record;
          reference.rmdir(path, nowMs);
          directories.splice(directories.indexOf(path), 1);
          commit(record);
        } else if (action === 8 && directories.length > 0) {
          const oldPath = choose(directories);
          const parents = ["/", ...directories].filter(
            (path) => path !== oldPath && !path.startsWith(`${oldPath}/`) && path.split("/").length < 5,
          );
          const newPath = childPath(choose(parents), "d");
          const record = planRename(state, oldPath, newPath, nowMs).record;
          reference.rename(oldPath, newPath, nowMs);
          for (let index = 0; index < directories.length; index += 1) {
            if (directories[index] === oldPath || directories[index]!.startsWith(`${oldPath}/`)) {
              directories[index] = `${newPath}${directories[index]!.slice(oldPath.length)}`;
            }
          }
          for (let index = 0; index < files.length; index += 1) {
            if (files[index]!.startsWith(`${oldPath}/`)) {
              files[index] = `${newPath}${files[index]!.slice(oldPath.length)}`;
            }
          }
          commit(record);
        } else if (directories.length > 0) {
          const path = choose(directories);
          const mode = Math.floor(random() * 0x1ff);
          const record = planChmod(state, path, mode, nowMs).record;
          reference.chmod(path, mode, nowMs);
          commit(record);
        }
      }

      for (const record of records) applyTxn(replayed, record);
      validateState(replayed);
      expect(canonicalStateView(replayed)).toEqual(canonicalStateView(state));
    }
  });

  test("an orphan runtime record keeps an independent view after persistent unlink", () => {
    const state = createInitialState(8192);
    applyTxn(state, planCreateFile(state, "/open", { nowMs: 1n, size: 9000n }).record);
    const inode = getInodeAtPath(state, "/open");
    if (inode.kind !== "file") {
      throw new Error("expected file");
    }
    const orphan = makeOrphanRecord(inode);

    applyTxn(state, planUnlink(state, "/open", 2n).record);
    expect(orphan.inodeId).toBe(inode.id);
    expect(orphan.size).toBe(9000n);
    expect(orphan.extents).toEqual([0n, 1n]);
    expect(state.allocator.quarantine.get(0n)).toBeNull();
    expect(state.allocator.quarantine.get(1n)).toBeNull();
  });
});

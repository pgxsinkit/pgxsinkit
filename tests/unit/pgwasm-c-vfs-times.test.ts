import { describe, expect, it, spyOn } from "bun:test";

import { cBuild } from "../../packages/pgwasm-c/src";
import type { EmscriptenNode, PostgresModule } from "../../packages/pgwasm-c/src/host/emscripten";
import { createVfsFilesystem } from "../../packages/pgwasm-c/src/host/vfs-mount";
import { C_POSTGRES_MAJOR } from "../../packages/pgwasm-c/src/postgres-version";
import { openOpfsRepackedFsForPort } from "../../packages/pgwasm/src/opfs/opfs-repacked-fs";
import { MemoryRepackedPort } from "./support/pgwasm-opfs/memory-port";

interface Attributes {
  timestamp?: number;
  atime?: number;
  mtime?: number;
  mode?: number;
}

/** Only node creation and errno translation are needed to exercise the mount's actual setattr callback. */
function moduleForNodes(): PostgresModule {
  const FS = {
    isDir: (mode: number) => (mode & 0o170000) === 0o040000,
    isFile: (mode: number) => (mode & 0o170000) === 0o100000,
    ErrnoError: class extends Error {
      readonly errno: number;
      constructor(errno: number) {
        super(String(errno));
        this.errno = errno;
      }
    },
    createNode(parent: EmscriptenNode | null, name: string, mode: number): EmscriptenNode {
      const node = {
        name,
        mode,
        id: 1,
        rdev: 0,
        mount: { opts: { root: "" } },
        node_ops: {},
        stream_ops: {},
      } as EmscriptenNode;
      node.parent = parent ?? node;
      return node;
    },
  };
  return { FS } as unknown as PostgresModule;
}

describe("the C build's custom VFS timestamps", () => {
  it("honors separate and zero times, preserves omitted sides and supports legacy timestamps", async () => {
    const fs = await openOpfsRepackedFsForPort(new MemoryRepackedPort());
    try {
      fs.writeFile("/value", "timed");
      fs.utimes("/value", 11, 22);
      const mounted = createVfsFilesystem(moduleForNodes(), fs);
      const createNode = mounted["createNode"] as (
        parent: EmscriptenNode | null,
        name: string,
        mode: number,
      ) => EmscriptenNode;
      const root = createNode(null, "/", 0o040777);
      const node = createNode(root, "value", 0o100600);
      const { setattr } = node.node_ops as { setattr(this: void, node: EmscriptenNode, attrs: Attributes): void };
      const lstat = spyOn(fs, "lstat");
      const apply = (attrs: Attributes, expected: [number, number], reads: number) => {
        lstat.mockClear();
        setattr(node, attrs);
        expect(lstat).toHaveBeenCalledTimes(reads);
        const stats = fs.lstat("/value");
        expect([stats.atime, stats.mtime]).toEqual(expected);
      };
      apply({ atime: 0, mtime: 1234 }, [0, 1234], 0);
      apply({ mtime: 0 }, [0, 0], 1);
      apply({ atime: 5678 }, [5678, 0], 1);
      apply({ timestamp: 4321 }, [4321, 4321], 0);
      apply({ timestamp: 9000, atime: 0 }, [0, 9000], 0);
      apply({ timestamp: 9000, mtime: 0 }, [9000, 0], 0);
      apply({ mode: 0o100640 }, [9000, 0], 0);
      lstat.mockRestore();
    } finally {
      await fs.closeFs();
    }
  });

  it("restores archived timestamps through the pinned WASM filesystem into a custom VFS", async () => {
    const fs = await openOpfsRepackedFsForPort(new MemoryRepackedPort());
    const mounted = await cBuild.boot({
      storage: { kind: "vfs", vfs: fs },
      extensions: [],
      user: "postgres",
      database: "postgres",
      debug: 0,
    });
    try {
      await mounted.writeEntries([
        {
          path: "/PG_VERSION",
          type: "file",
          mode: 0o600,
          mtimeSeconds: 123,
          data: new TextEncoder().encode(`${C_POSTGRES_MAJOR}\n`),
        },
        { path: "/epoch", type: "file", mode: 0o600, mtimeSeconds: 0, data: new Uint8Array([1]) },
      ]);
      for (const [path, expected] of [
        ["/PG_VERSION", 123000],
        ["/epoch", 0],
      ] as const) {
        const stats = fs.lstat(path);
        expect([stats.atime, stats.mtime]).toEqual([expected, expected]);
      }
    } finally {
      await mounted.release();
    }
  });
});

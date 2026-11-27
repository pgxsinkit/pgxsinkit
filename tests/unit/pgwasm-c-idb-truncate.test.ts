import { describe, expect, it } from "bun:test";

import type {
  EmscriptenFS,
  EmscriptenNode,
  EmscriptenStream,
  PostgresModule,
} from "../../packages/pgwasm-c/src/host/emscripten";
import { IdbMount } from "../../packages/pgwasm-c/src/host/mounts/idb";

describe("the C build's IndexedDB truncate timestamps", () => {
  it("marks successful truncates for persistence and preserves metadata when truncation fails", () => {
    const calls: { fs: EmscriptenFS; stream: EmscriptenStream | null; node: EmscriptenNode; length: number }[] = [];
    const failure = new Error("truncate failed");
    const FS = {
      filesystems: { IDBFS: {} },
      analyzePath: () => ({ exists: true }),
      mount: () => {},
      symlink: () => {},
      doTruncate(this: EmscriptenFS, stream: EmscriptenStream | null, node: EmscriptenNode, length: number) {
        calls.push({ fs: this, stream, node, length });
        if (length < 0) throw failure;
      },
    } as unknown as EmscriptenFS;
    const node = { mtime: 1, ctime: 2 } as EmscriptenNode;
    const stream = { node } as EmscriptenStream;
    new IdbMount("truncate").preRun({ FS } as PostgresModule);

    expect(() => FS.doTruncate(stream, node, -1)).toThrow(failure);
    expect([node.mtime, node.ctime]).toEqual([1, 2]);

    const startedAt = Date.now();
    FS.doTruncate(stream, node, 0);
    expect(node.mtime).toBeGreaterThanOrEqual(startedAt);
    expect(node.mtime).toBeLessThanOrEqual(Date.now());
    expect(node.ctime).toBe(node.mtime);
    expect(calls).toEqual([
      { fs: FS, stream, node, length: -1 },
      { fs: FS, stream, node, length: 0 },
    ]);
  });
});

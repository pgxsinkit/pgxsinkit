/**
 * The file-backed port, and the one property it exists for: the four owned files ARE the store, so a
 * store built on a directory under Node opens unchanged on any other port over the same four files.
 *
 * The format lives above `RepackedPort` — nothing in `RepackedVfs`, the metadata log or the arena
 * knows which port it is on — so this is identity by construction rather than a compatibility layer,
 * and the way to prove it is to move the bytes across and open them on the other side.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { StoreOwnedError } from "../../packages/pglite-opfs-repacked/src/core/errors";
import { OWNED_FILE_NAMES, readExact, writeExact } from "../../packages/pglite-opfs-repacked/src/core/port";
import type { OwnedFileName, RepackedPort } from "../../packages/pglite-opfs-repacked/src/core/port";
import { RepackedVfs } from "../../packages/pglite-opfs-repacked/src/core/repacked-vfs";
import { FileRepackedPort } from "../../packages/pglite-opfs-repacked/src/file-port";
import { MemoryRepackedPort } from "../../packages/pglite-opfs-repacked/test/support/memory-port";

/** `tmp/` is gitignored, so a fresh checkout (CI) has no `tmp/agents` for mkdtemp to create into. */
const scratchParent = join(process.cwd(), "tmp", "agents");
mkdirSync(scratchParent, { recursive: true });
const scratchRoot = mkdtempSync(join(scratchParent, "repacked-file-port-"));

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

let nextDirectory = 0;
function storeDirectory(): string {
  nextDirectory += 1;
  return join(scratchRoot, `store-${nextDirectory}`);
}

const EXTENT_SIZE = 8192;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A datadir-shaped write set: a nested directory, a tiny file, and one file past a single extent. */
const CONTENT: readonly (readonly [string, Uint8Array])[] = [
  ["/base/PG_VERSION", encoder.encode("17\n")],
  ["/base/1/2619", new Uint8Array(3 * EXTENT_SIZE).fill(0x5a)],
  ["/global/pg_control", encoder.encode("control bytes")],
];

function seed(vfs: RepackedVfs): void {
  vfs.mkdir("/base/1", { recursive: true, nowMs: 1n });
  vfs.mkdir("/global", { recursive: true, nowMs: 1n });
  for (const [path, bytes] of CONTENT) {
    vfs.writeFile(path, bytes, { nowMs: 1n });
  }
  vfs.strictSync();
}

function expectSeeded(vfs: RepackedVfs): void {
  for (const [path, bytes] of CONTENT) {
    expect(vfs.readFile(path)).toEqual(bytes);
  }
  expect(vfs.readdir("/base").sort()).toEqual(["1", "PG_VERSION"]);
}

/** Every owned file's bytes, read through whichever port holds them. */
async function ownedBytes(port: RepackedPort): Promise<Record<OwnedFileName, Uint8Array>> {
  const bytes: Partial<Record<OwnedFileName, Uint8Array>> = {};
  for (const name of OWNED_FILE_NAMES) {
    const handle = await port.acquire(name, `copy.acquire.${name}`);
    try {
      const size = handle.getSize(`copy.size.${name}`);
      bytes[name] = readExact(handle, 0n, size, size, `copy.read.${name}`);
    } finally {
      handle.close();
    }
  }
  return bytes as Record<OwnedFileName, Uint8Array>;
}

/** Write those same bytes into another port, byte for byte, and make them durable. */
async function writeOwnedBytes(port: RepackedPort, bytes: Record<OwnedFileName, Uint8Array>): Promise<void> {
  for (const name of OWNED_FILE_NAMES) {
    const handle = await port.acquire(name, `paste.acquire.${name}`);
    try {
      const source = bytes[name];
      handle.truncate(source.byteLength, `paste.truncate.${name}`);
      if (source.byteLength > 0) writeExact(handle, 0n, source, `paste.write.${name}`);
      handle.flush(`paste.flush.${name}`);
    } finally {
      handle.close();
    }
  }
}

describe("opfs-repacked file-backed port", () => {
  test("a store written through the file port reopens through the file port", async () => {
    const directory = storeDirectory();
    const vfs = await RepackedVfs.open(new FileRepackedPort(directory), { extentSize: EXTENT_SIZE });
    seed(vfs);
    vfs.close();

    // The directory holds the store and nothing else: four files, created by the port itself.
    expect(readdirSync(directory).sort()).toEqual([...OWNED_FILE_NAMES].sort());

    const reopened = await RepackedVfs.open(new FileRepackedPort(directory), { extentSize: EXTENT_SIZE });
    expectSeeded(reopened);
    // And it is still writable after a reopen, not merely readable.
    reopened.writeFile("/global/pg_control", encoder.encode("second generation"), { nowMs: 2n });
    reopened.strictSync();
    reopened.close();

    const third = await RepackedVfs.open(new FileRepackedPort(directory), { extentSize: EXTENT_SIZE });
    expect(decoder.decode(third.readFile("/global/pg_control"))).toBe("second generation");
    third.close();
  });

  test("the four files carry the store from the file port to the memory port and back", async () => {
    const directory = storeDirectory();
    const written = await RepackedVfs.open(new FileRepackedPort(directory), { extentSize: EXTENT_SIZE });
    seed(written);
    written.close();

    // file -> memory: the four files copied byte for byte, and the store opens as the same store.
    const fromFile = await ownedBytes(new FileRepackedPort(directory));
    const memoryPort = new MemoryRepackedPort();
    await writeOwnedBytes(memoryPort, fromFile);
    const onMemory = await RepackedVfs.open(memoryPort, { extentSize: EXTENT_SIZE });
    expectSeeded(onMemory);
    onMemory.close();

    // memory -> file: the same four files back out into a DIFFERENT directory, which opens the same.
    const copyDirectory = storeDirectory();
    await writeOwnedBytes(new FileRepackedPort(copyDirectory), fromFile);
    const onCopy = await RepackedVfs.open(new FileRepackedPort(copyDirectory), { extentSize: EXTENT_SIZE });
    expectSeeded(onCopy);
    onCopy.close();

    // And the bytes really did travel unchanged: the copy's four files equal the original's.
    const fromCopy = await ownedBytes(new FileRepackedPort(copyDirectory));
    for (const name of OWNED_FILE_NAMES) {
      expect(fromCopy[name]).toEqual(fromFile[name]);
    }
  });

  test("a store built in memory opens on the file port over the same four files", async () => {
    const memoryPort = new MemoryRepackedPort();
    const inMemory = await RepackedVfs.open(memoryPort, { extentSize: EXTENT_SIZE });
    seed(inMemory);
    inMemory.close();

    const directory = storeDirectory();
    // `durableBytes` is the memory port's own image of each file — the same bytes an OPFS or file
    // port would have on disk, which is the point being made.
    await writeOwnedBytes(new FileRepackedPort(directory), {
      "arena.bin": memoryPort.durableBytes("arena.bin"),
      "metadata-a.bin": memoryPort.durableBytes("metadata-a.bin"),
      "metadata-b.bin": memoryPort.durableBytes("metadata-b.bin"),
      "activation.bin": memoryPort.durableBytes("activation.bin"),
    });

    const onFile = await RepackedVfs.open(new FileRepackedPort(directory), { extentSize: EXTENT_SIZE });
    expectSeeded(onFile);
    onFile.close();
  });

  test("the port enumerates what is really there and refuses a name it already holds", async () => {
    const directory = storeDirectory();
    const port = new FileRepackedPort(directory);
    expect(port.directory).toBe(directory);
    // A fresh directory is created on first use, exactly as the OPFS port's caller creates its handle.
    expect(await port.enumerate("store.enumerate.initial")).toEqual([]);

    const handle = await port.acquire("arena.bin", "store.acquire.arena");
    expect(await port.enumerate("store.enumerate.locked")).toEqual([{ name: "arena.bin", kind: "file" }]);
    expect(port.acquire("arena.bin", "store.acquire.arena")).rejects.toBeInstanceOf(StoreOwnedError);
    handle.close();
    // Released, so the same name can be taken again.
    (await port.acquire("arena.bin", "store.acquire.arena")).close();

    // A stranger's entry is reported rather than filtered, which is what makes a store fail closed
    // over a directory it does not own.
    mkdirSync(join(directory, "not-ours"), { recursive: true });
    expect(await port.enumerate("store.enumerate.initial")).toContainEqual({ name: "not-ours", kind: "directory" });
    expect(RepackedVfs.open(new FileRepackedPort(directory), { extentSize: EXTENT_SIZE })).rejects.toThrow("not-ours");
  });
});

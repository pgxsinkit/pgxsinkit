import { CorruptStoreError, StoreLimitError } from "./errors";
import {
  ARENA_HEADER_BYTES,
  MAX_TOTAL_EXTENTS,
  checkedAdd,
  checkedMultiply,
  checkedSafeNumber,
  checkedU64,
  validateExtentSize,
} from "./limits";
import type { MetadataFile } from "./state-machine";

export const OWNED_FILE_NAMES = ["arena.bin", "metadata-a.bin", "metadata-b.bin", "activation.bin"] as const;
export type OwnedFileName = (typeof OWNED_FILE_NAMES)[number];
export type MetadataFileName = Extract<OwnedFileName, "metadata-a.bin" | "metadata-b.bin">;

export function metadataFileName(file: MetadataFile): MetadataFileName {
  return file === "a" ? "metadata-a.bin" : "metadata-b.bin";
}

export interface RepackedPortEntry {
  name: string;
  kind: "file" | "directory";
}

export interface RepackedFileHandle {
  readonly name: OwnedFileName;
  getSize(label: string): number;
  read(target: Uint8Array, at: number, label: string): number;
  write(source: Uint8Array, at: number, label: string): number;
  truncate(size: number, label: string): void;
  flush(label: string): void;
  close(): void;
}

export interface RepackedPort {
  enumerate(label: string): Promise<readonly RepackedPortEntry[]>;
  acquire(name: OwnedFileName, label: string): Promise<RepackedFileHandle>;
}

export class PortWriteError extends Error {
  constructor(label: string) {
    super(`${label} made no valid write progress`);
    this.name = "PortWriteError";
  }
}

function checkedRange(offset: bigint, length: number, label: string): number {
  checkedU64(offset, `${label} offset`);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new StoreLimitError(`${label} length is invalid`);
  }
  checkedSafeNumber(checkedAdd(offset, BigInt(length), `${label} end`), `${label} end`);
  return checkedSafeNumber(offset, `${label} offset`);
}

export function readExact(
  handle: RepackedFileHandle,
  offset: bigint,
  length: number,
  maximumLength: number,
  label: string,
): Uint8Array {
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 0 || length > maximumLength) {
    throw new StoreLimitError(`${label} length exceeds the bounded read limit`);
  }
  const start = checkedRange(offset, length, label);
  const output = new Uint8Array(length);
  let completed = 0;
  while (completed < output.byteLength) {
    const count = handle.read(output.subarray(completed), start + completed, label);
    if (!Number.isSafeInteger(count) || count <= 0 || count > output.byteLength - completed) {
      throw new CorruptStoreError(`${label} ended before the declared byte length`);
    }
    completed += count;
  }
  return output;
}

export function writeExact(handle: RepackedFileHandle, offset: bigint, bytes: Uint8Array, label: string): void {
  const start = checkedRange(offset, bytes.byteLength, label);
  let completed = 0;
  while (completed < bytes.byteLength) {
    const count = handle.write(bytes.subarray(completed), start + completed, label);
    if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.byteLength - completed) {
      throw new PortWriteError(label);
    }
    completed += count;
  }
}

export function truncateChecked(handle: RepackedFileHandle, size: bigint, label: string): void {
  handle.truncate(checkedSafeNumber(size, `${label} size`), label);
}

export function arenaByteOffset(extentId: bigint, extentSize: number, withinExtent = 0): bigint {
  validateExtentSize(extentSize);
  checkedU64(extentId, "extent ID");
  if (extentId >= BigInt(MAX_TOTAL_EXTENTS)) {
    throw new StoreLimitError(`extent ID exceeds ${MAX_TOTAL_EXTENTS - 1}`);
  }
  if (!Number.isSafeInteger(withinExtent) || withinExtent < 0 || withinExtent >= extentSize) {
    throw new StoreLimitError("within-extent offset is outside the extent");
  }
  return checkedAdd(
    checkedAdd(
      BigInt(ARENA_HEADER_BYTES),
      checkedMultiply(extentId, BigInt(extentSize), "arena offset"),
      "arena offset",
    ),
    BigInt(withinExtent),
    "arena offset",
  );
}

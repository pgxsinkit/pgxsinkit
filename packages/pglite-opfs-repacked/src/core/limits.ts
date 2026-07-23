import { StoreLimitError } from "./errors";

export const FORMAT_VERSION = 1;
export const LIMITS_PROFILE_VERSION = 1;
export const ARENA_HEADER_BYTES = 8192;
export const MIN_EXTENT_BYTES = 8192;
export const MAX_EXTENT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_EXTENT_BYTES = 64 * 1024;
export const MAX_COMPONENT_BYTES = 255;
export const MAX_PATH_BYTES = 1024;
export const MAX_PATH_DEPTH = 32;
export const MAX_INODES = 65_536;
export const MAX_EXTENTS_PER_INODE = 2 ** 20;
export const MAX_TOTAL_EXTENTS = 2 ** 22;
export const MAX_METADATA_BASE_READER_BYTES = 64 * 1024 * 1024;
export const MAX_METADATA_BASE_WRITER_BYTES = 32 * 1024 * 1024;
export const MAX_FRAME_PAYLOAD_BYTES = 1024 * 1024;
export const MAX_ACTIVE_LOG_BYTES = 16 * 1024 * 1024;
export const SOFT_ACTIVE_LOG_BYTES = 8 * 1024 * 1024;
export const MAX_ACTIVE_LOG_FRAMES = 32_768;
export const SOFT_ACTIVE_LOG_FRAMES = 16_384;
export const MAX_U64 = (1n << 64n) - 1n;

export function validateExtentSize(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_EXTENT_BYTES ||
    value > MAX_EXTENT_BYTES ||
    value % ARENA_HEADER_BYTES !== 0
  ) {
    throw new TypeError(
      `extentSize must be an ${ARENA_HEADER_BYTES}-byte multiple between ${MIN_EXTENT_BYTES} and ${MAX_EXTENT_BYTES}`,
    );
  }
  return value;
}

export function checkedU64(value: bigint, label: string): bigint {
  if (value < 0n || value > MAX_U64) {
    throw new StoreLimitError(`${label} is outside the unsigned 64-bit range`);
  }
  return value;
}

export function checkedSafeNumber(value: bigint, label: string): number {
  checkedU64(value, label);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StoreLimitError(`${label} exceeds JavaScript's safe integer range`);
  }
  return Number(value);
}

export function checkedAdd(left: bigint, right: bigint, label: string): bigint {
  return checkedU64(left + right, label);
}

export function checkedMultiply(left: bigint, right: bigint, label: string): bigint {
  return checkedU64(left * right, label);
}

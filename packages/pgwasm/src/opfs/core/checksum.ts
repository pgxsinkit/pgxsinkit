const CRC32_TABLE = new Uint32Array(256);

for (let value = 0; value < CRC32_TABLE.length; value += 1) {
  let remainder = value;
  for (let bit = 0; bit < 8; bit += 1) {
    remainder = (remainder & 1) === 1 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1;
  }
  CRC32_TABLE[value] = remainder >>> 0;
}

const CRC32_SLICES: Uint32Array[] = [CRC32_TABLE];
for (let slice = 1; slice < 8; slice += 1) {
  const previous = CRC32_SLICES[slice - 1]!;
  const current = new Uint32Array(256);
  for (let value = 0; value < current.length; value += 1) {
    const remainder = previous[value]!;
    current[value] = (CRC32_TABLE[remainder & 0xff]! ^ (remainder >>> 8)) >>> 0;
  }
  CRC32_SLICES.push(current);
}

const CRC32_SLICE_1 = CRC32_SLICES[1]!;
const CRC32_SLICE_2 = CRC32_SLICES[2]!;
const CRC32_SLICE_3 = CRC32_SLICES[3]!;
const CRC32_SLICE_4 = CRC32_SLICES[4]!;
const CRC32_SLICE_5 = CRC32_SLICES[5]!;
const CRC32_SLICE_6 = CRC32_SLICES[6]!;
const CRC32_SLICE_7 = CRC32_SLICES[7]!;

function updateCrc32(remainder: number, bytes: Uint8Array, start: number, end: number): number {
  let index = start;
  while (index + 8 <= end) {
    const word =
      remainder ^ (bytes[index]! | (bytes[index + 1]! << 8) | (bytes[index + 2]! << 16) | (bytes[index + 3]! << 24));
    remainder =
      CRC32_SLICE_7[word & 0xff]! ^
      CRC32_SLICE_6[(word >>> 8) & 0xff]! ^
      CRC32_SLICE_5[(word >>> 16) & 0xff]! ^
      CRC32_SLICE_4[word >>> 24]! ^
      CRC32_SLICE_3[bytes[index + 4]!]! ^
      CRC32_SLICE_2[bytes[index + 5]!]! ^
      CRC32_SLICE_1[bytes[index + 6]!]! ^
      CRC32_TABLE[bytes[index + 7]!]!;
    index += 8;
  }
  for (; index < end; index += 1) {
    remainder = CRC32_TABLE[(remainder ^ bytes[index]!) & 0xff]! ^ (remainder >>> 8);
  }
  return remainder;
}

function updateCrc32WithZeros(remainder: number, length: number): number {
  while (length >= 8) {
    remainder =
      CRC32_SLICE_7[remainder & 0xff]! ^
      CRC32_SLICE_6[(remainder >>> 8) & 0xff]! ^
      CRC32_SLICE_5[(remainder >>> 16) & 0xff]! ^
      CRC32_SLICE_4[remainder >>> 24]!;
    length -= 8;
  }
  while (length > 0) {
    remainder = CRC32_TABLE[remainder & 0xff]! ^ (remainder >>> 8);
    length -= 1;
  }
  return remainder;
}

export function crc32(bytes: Uint8Array): number {
  const remainder = updateCrc32(0xffff_ffff, bytes, 0, bytes.byteLength);
  return (remainder ^ 0xffff_ffff) >>> 0;
}

export function crc32WithZeroedRange(bytes: Uint8Array, offset: number, length: number): number {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new TypeError("checksum range must use non-negative safe integers");
  }
  if (offset + length > bytes.byteLength) {
    throw new RangeError("checksum range exceeds the input");
  }
  const zeroEnd = offset + length;
  let remainder = updateCrc32(0xffff_ffff, bytes, 0, offset);
  remainder = updateCrc32WithZeros(remainder, length);
  remainder = updateCrc32(remainder, bytes, zeroEnd, bytes.byteLength);
  return (remainder ^ 0xffff_ffff) >>> 0;
}

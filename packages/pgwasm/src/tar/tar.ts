/**
 * A minimal ustar codec: regular files and directories, which is everything a Postgres data
 * directory and an npm tarball hold.
 *
 * Writing produces the layout pgwasm's Store backups have always had: a 512-byte ustar header per
 * entry, the name in the `name` field when it fits (99 bytes), the payload padded to a record, and
 * two zero records at the end. Reading also accepts what other writers add around that: a name
 * split into `prefix` + `name`, PAX extended headers (`x`, per entry; `g`, global and ignored) and GNU
 * long names (`L`). Links, devices and FIFOs are refused rather than skipped, so an archive with
 * content this codec cannot represent fails loudly instead of restoring partially.
 *
 * Reading is strict about completeness, for the same reason: a data directory restored from part of
 * a backup is a corrupt database. A header or payload cut short, a size that is not a number, a
 * header whose checksum fails and an archive without its two zero end records are all refused. The
 * end records are required because every writer whose archives reach this reader writes them: every
 * PGlite Store backup came from tinytar's `tar()`, which always appends them (checked for the fork's
 * dumps and the prepopulated data directory), as do npm's tarballs and the extension bundles.
 */

/** One archive member. */
export interface TarEntry {
  /** The member's path as stored, `/`-separated. */
  readonly name: string;
  readonly type: "file" | "directory";
  /** Permission bits (the `0o7777` part of the mode). */
  readonly mode: number;
  /** Modification time, whole seconds since the epoch. */
  readonly mtimeSeconds: number;
  /** The file's bytes; empty for a directory. */
  readonly data: Uint8Array;
}

/** An archive this codec cannot read or represent. */
export class TarFormatError extends Error {
  override readonly name = "TarFormatError";
}

const RECORD = 512;
const NAME_LENGTH = 100;
const PREFIX_LENGTH = 155;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Serialize entries into an uncompressed ustar archive. */
export function writeTar(entries: readonly TarEntry[]): Uint8Array {
  let total = RECORD * 2;
  for (const entry of entries) total += RECORD + padded(entry.type === "file" ? entry.data.byteLength : 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const entry of entries) {
    const size = entry.type === "file" ? entry.data.byteLength : 0;
    writeHeader(archive, offset, entry, size);
    offset += RECORD;
    if (size > 0) archive.set(entry.data, offset);
    offset += padded(size);
  }
  return archive;
}

/** Parse an uncompressed ustar archive. Throws {@link TarFormatError} for anything it cannot represent. */
export function readTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingName: string | undefined;
  let pendingSize: number | undefined;
  for (;;) {
    if (offset === archive.byteLength) {
      throw new TarFormatError(
        `tar archive ends at byte ${offset} without its end-of-archive records: it is truncated`,
      );
    }
    if (offset + RECORD > archive.byteLength) {
      throw new TarFormatError(`tar archive ends inside the header at byte ${offset}: it is truncated`);
    }
    const header = archive.subarray(offset, offset + RECORD);
    if (isZeroRecord(header)) {
      const second = archive.subarray(offset + RECORD, offset + 2 * RECORD);
      if (second.byteLength < RECORD || !isZeroRecord(second)) {
        throw new TarFormatError(
          `tar archive has one end-of-archive record at byte ${offset}, not two: it is truncated or damaged`,
        );
      }
      if (pendingName !== undefined || pendingSize !== undefined) {
        throw new TarFormatError(`tar archive ends after an extended header with no member for it`);
      }
      return entries;
    }
    verifyChecksum(header, offset);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const declaredSize = readOctal(header, 124, 12, offset);
    const size = pendingSize ?? declaredSize;
    const dataStart = offset + RECORD;
    if (dataStart + padded(size) > archive.byteLength) {
      throw new TarFormatError(`tar member at byte ${offset} runs past the end of the archive: it is truncated`);
    }
    const data = archive.subarray(dataStart, dataStart + size);
    offset = dataStart + padded(size);

    if (typeflag === "x") {
      const pax = readPax(data, offset);
      pendingName = pax.path ?? pendingName;
      pendingSize = pax.size;
      continue;
    }
    if (typeflag === "g") continue;
    if (typeflag === "L") {
      pendingName = readCString(data, 0, data.byteLength);
      continue;
    }

    const name = pendingName ?? joinPrefix(header);
    pendingName = undefined;
    pendingSize = undefined;
    const mode = readOctal(header, 100, 8, offset) & 0o7777;
    const mtimeSeconds = readOctal(header, 136, 12, offset);
    if (typeflag === "0" || typeflag === "\0" || typeflag === "7") {
      entries.push({ name, type: "file", mode, mtimeSeconds, data: data.slice() });
    } else if (typeflag === "5") {
      entries.push({ name, type: "directory", mode, mtimeSeconds, data: new Uint8Array(0) });
    } else {
      throw new TarFormatError(`tar member "${name}" has unsupported type "${typeflag}"`);
    }
  }
}

function padded(size: number): number {
  return Math.ceil(size / RECORD) * RECORD;
}

function writeHeader(archive: Uint8Array, offset: number, entry: TarEntry, size: number): void {
  const [prefix, rest] = splitName(entry.name);
  writeString(archive, offset + 0, NAME_LENGTH, rest);
  writeOctal(archive, offset + 100, 8, entry.mode & 0o7777);
  writeOctal(archive, offset + 108, 8, 0);
  writeOctal(archive, offset + 116, 8, 0);
  writeOctal(archive, offset + 124, 12, size);
  writeOctal(archive, offset + 136, 12, Math.max(0, Math.floor(entry.mtimeSeconds)));
  archive[offset + 156] = (entry.type === "directory" ? "5" : "0").charCodeAt(0);
  writeString(archive, offset + 257, 6, "ustar");
  writeString(archive, offset + 263, 2, "00", false);
  writeString(archive, offset + 345, PREFIX_LENGTH, prefix);
  // The checksum is computed with its own field read as eight spaces, then stored as six octal
  // digits, a NUL and a space.
  archive.fill(0x20, offset + 148, offset + 156);
  let sum = 0;
  for (let index = offset; index < offset + RECORD; index++) sum += archive[index] ?? 0;
  archive.set(encoder.encode(sum.toString(8).padStart(6, "0")), offset + 148);
  archive[offset + 154] = 0;
}

/** Split a name that does not fit the 99-byte name field into ustar's `prefix` / `name` pair. */
function splitName(name: string): [prefix: string, name: string] {
  if (encoder.encode(name).byteLength < NAME_LENGTH) return ["", name];
  for (let cut = name.indexOf("/"); cut !== -1; cut = name.indexOf("/", cut + 1)) {
    const prefix = name.slice(0, cut);
    const rest = name.slice(cut + 1);
    if (encoder.encode(prefix).byteLength < PREFIX_LENGTH && encoder.encode(rest).byteLength < NAME_LENGTH) {
      return [prefix, rest];
    }
  }
  throw new TarFormatError(`tar member name is too long to store: "${name}"`);
}

function joinPrefix(header: Uint8Array): string {
  const name = readCString(header, 0, NAME_LENGTH);
  const magic = readCString(header, 257, 6);
  if (magic !== "ustar") return name;
  const prefix = readCString(header, 345, PREFIX_LENGTH);
  return prefix === "" ? name : `${prefix}/${name}`;
}

function writeString(archive: Uint8Array, at: number, length: number, value: string, terminate = true): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > (terminate ? length - 1 : length)) {
    throw new TarFormatError(`tar header field overflow: "${value}"`);
  }
  archive.set(bytes, at);
}

function writeOctal(archive: Uint8Array, at: number, length: number, value: number): void {
  const digits = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || digits.length > length - 1) {
    throw new TarFormatError(`tar header number out of range: ${value}`);
  }
  writeString(archive, at, length, digits.padStart(length - 1, "0"));
}

function readCString(bytes: Uint8Array, at: number, length: number): string {
  let end = at;
  while (end < at + length && bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(at, end));
}

function readOctal(header: Uint8Array, at: number, length: number, recordOffset: number): number {
  if (((header[at] ?? 0) & 0x80) !== 0) {
    throw new TarFormatError(`tar header at byte ${recordOffset} uses base-256 numbers, which are not supported`);
  }
  const text = readCString(header, at, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new TarFormatError(`tar header at byte ${recordOffset} has a malformed number: "${text}"`);
  }
  return Number.parseInt(text, 8);
}

function verifyChecksum(header: Uint8Array, recordOffset: number): void {
  const stored = readOctal(header, 148, 8, recordOffset);
  let sum = 0;
  for (let index = 0; index < RECORD; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (sum !== stored) throw new TarFormatError(`tar header at byte ${recordOffset} fails its checksum`);
}

function isZeroRecord(header: Uint8Array): boolean {
  for (const byte of header) if (byte !== 0) return false;
  return true;
}

/**
 * PAX extended header records: `"<length> <key>=<value>\n"`, lengths in bytes. Only `path` and `size`
 * matter; a record that does not parse, or a `size` that is not a non-negative integer, is refused.
 */
function readPax(data: Uint8Array, recordOffset: number): { path?: string; size?: number } {
  const result: { path?: string; size?: number } = {};
  const malformed = (what: string) =>
    new TarFormatError(`tar PAX header before byte ${recordOffset} has a malformed ${what}`);
  let cursor = 0;
  while (cursor < data.byteLength) {
    let space = cursor;
    while (space < data.byteLength && data[space] !== 0x20) space++;
    const lengthText = decoder.decode(data.subarray(cursor, space));
    if (space >= data.byteLength || !/^[0-9]+$/.test(lengthText)) throw malformed("record");
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= space - cursor + 1 || cursor + length > data.byteLength) {
      throw malformed("record");
    }
    if (data[cursor + length - 1] !== 0x0a) throw malformed("record");
    const record = decoder.decode(data.subarray(space + 1, cursor + length - 1));
    const equals = record.indexOf("=");
    if (equals === -1) throw malformed("record");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path") result.path = value;
    if (key === "size") {
      const size = /^[0-9]+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
      if (!Number.isSafeInteger(size)) throw malformed(`size ("${value}")`);
      result.size = size;
    }
    cursor += length;
  }
  return result;
}

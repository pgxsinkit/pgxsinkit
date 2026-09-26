import { describe, expect, it } from "bun:test";

import { gunzip, gunzipIfCompressed, gzip, isGzip } from "../../packages/pgwasm/src/tar/gzip";
import { readTar, TarFormatError, writeTar, type TarEntry } from "../../packages/pgwasm/src/tar/tar";

const encoder = new TextEncoder();

function file(name: string, text: string, mode = 0o600): TarEntry {
  return { name, type: "file", mode, mtimeSeconds: 1_700_000_000, data: encoder.encode(text) };
}

function directory(name: string): TarEntry {
  return { name, type: "directory", mode: 0o700, mtimeSeconds: 1_700_000_000, data: new Uint8Array(0) };
}

/** A ustar header record with a valid checksum, for hand-built archives in the tests below. */
function header(name: string, typeflag: string, size: number): Uint8Array {
  const record = new Uint8Array(512);
  record.set(encoder.encode(name), 0);
  record.set(encoder.encode("0000644"), 100);
  record.set(encoder.encode(size.toString(8).padStart(11, "0")), 124);
  record.set(encoder.encode("00000000000"), 136);
  record[156] = typeflag.charCodeAt(0);
  record.set(encoder.encode("ustar"), 257);
  record.set(encoder.encode("00"), 263);
  record.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of record) sum += byte;
  record.set(encoder.encode(sum.toString(8).padStart(6, "0")), 148);
  record[154] = 0;
  return record;
}

function member(name: string, typeflag: string, data: Uint8Array): Uint8Array[] {
  const padding = new Uint8Array((512 - (data.byteLength % 512)) % 512);
  return [header(name, typeflag, data.byteLength), data, padding];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe("the ustar codec", () => {
  it("round-trips files and directories with their mode and time", () => {
    const entries = [directory("/base"), file("/base/1", "hello"), file("/PG_VERSION", "18\n", 0o644)];
    const archive = writeTar(entries);
    expect(archive.byteLength % 512).toBe(0);
    expect(readTar(archive)).toEqual(entries);
  });

  it("stores a long name as ustar prefix + name and reads it back whole", () => {
    const longName = `/${"segment/".repeat(15)}file`;
    const [entry] = readTar(writeTar([file(longName, "x")]));
    expect(entry?.name).toBe(longName);
  });

  it("refuses a name that cannot be stored", () => {
    expect(() => writeTar([file(`/${"x".repeat(300)}`, "x")])).toThrow(TarFormatError);
  });

  it("applies a PAX path and skips a global PAX header", () => {
    const paxRecord = (key: string, value: string): string => {
      const body = ` ${key}=${value}\n`;
      let length = body.length + 1;
      while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
      return `${length}${body}`;
    };
    const archive = concat([
      ...member("pax_global_header", "g", encoder.encode(paxRecord("comment", "ignored"))),
      ...member("PaxHeader/x", "x", encoder.encode(paxRecord("path", "long/real/name.txt"))),
      ...member("short", "0", encoder.encode("payload")),
      new Uint8Array(1024),
    ]);
    const entries = readTar(archive);
    expect(entries.map((entry) => entry.name)).toEqual(["long/real/name.txt"]);
    expect(new TextDecoder().decode(entries[0]?.data)).toBe("payload");
  });

  it("applies a GNU long name", () => {
    const archive = concat([
      ...member("././@LongLink", "L", encoder.encode("gnu/long/name\0")),
      ...member("short", "0", encoder.encode("gnu")),
      new Uint8Array(1024),
    ]);
    expect(readTar(archive).map((entry) => entry.name)).toEqual(["gnu/long/name"]);
  });

  it("refuses links rather than skipping them", () => {
    const archive = concat([...member("link", "2", new Uint8Array(0)), new Uint8Array(1024)]);
    expect(() => readTar(archive)).toThrow(TarFormatError);
  });

  it("refuses a header whose checksum does not match", () => {
    const archive = writeTar([file("/a", "b")]);
    archive[0] = "z".charCodeAt(0);
    expect(() => readTar(archive)).toThrow(/checksum/);
  });

  it("refuses a member that runs past the end", () => {
    const archive = writeTar([file("/a", "x".repeat(2000))]);
    expect(() => readTar(archive.subarray(0, 1024))).toThrow(/past the end/);
  });
});

describe("gzip", () => {
  it("round-trips and is recognised by its magic number", async () => {
    const plain = encoder.encode("pgwasm ".repeat(100));
    const compressed = await gzip(plain);
    expect(isGzip(compressed)).toBe(true);
    expect(isGzip(plain)).toBe(false);
    expect(await gunzip(compressed)).toEqual(plain);
    expect(await gunzipIfCompressed(compressed)).toEqual(plain);
    expect(await gunzipIfCompressed(plain)).toBe(plain);
  });
});

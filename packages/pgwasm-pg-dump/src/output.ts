/**
 * pg_dump's output file, as the `File` pgDump returns.
 *
 * A plain-format dump is an SQL script. pg_dump 18.3 brackets it in psql's `\restrict <key>` /
 * `\unrestrict <key>` meta-commands, which only psql understands; the script is meant for `exec()`, so
 * those two lines are removed. They are found by pg_dump's random key, so a row whose text happens to
 * hold a line starting `\restrict` is left alone. The custom and tar formats and a compressed plain dump
 * are returned byte for byte.
 */

const encoder = new TextEncoder();

function startsWith(bytes: Uint8Array, prefix: ArrayLike<number>, at = 0): boolean {
  if (at + prefix.length > bytes.byteLength) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (bytes[at + index] !== prefix[index]) return false;
  }
  return true;
}

/** A format other than an uncompressed plain script: custom (`PGDMP`), tar (`ustar`), or gzip. */
function isArchive(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, encoder.encode("PGDMP")) ||
    startsWith(bytes, encoder.encode("ustar"), 257) ||
    startsWith(bytes, [0x1f, 0x8b])
  );
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  if (first === undefined) return -1;
  for (let at = haystack.indexOf(first, from); at !== -1; at = haystack.indexOf(first, at + 1)) {
    if (at + needle.byteLength > haystack.byteLength) return -1;
    if (startsWith(haystack, needle, at)) return at;
  }
  return -1;
}

function lastIndexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  const first = needle[0];
  if (first === undefined) return -1;
  for (let at = haystack.lastIndexOf(first); at !== -1; at = at === 0 ? -1 : haystack.lastIndexOf(first, at - 1)) {
    if (startsWith(haystack, needle, at)) return at;
  }
  return -1;
}

/** The end of the line starting at `start`, past its newline. */
function lineEnd(bytes: Uint8Array, start: number): number {
  const newline = bytes.indexOf(0x0a, start);
  return newline === -1 ? bytes.byteLength : newline + 1;
}

/** Remove the `\restrict <key>` line and its matching `\unrestrict <key>` line. */
export function withoutRestrictLines(script: Uint8Array): Uint8Array {
  const restrict = indexOfBytes(script, encoder.encode("\n\\restrict "));
  if (restrict === -1) return script;
  const lineStart = restrict + 1;
  const end = lineEnd(script, lineStart);
  const key = new TextDecoder().decode(script.subarray(lineStart + "\\restrict ".length, end)).trim();
  if (!/^[A-Za-z0-9]+$/.test(key)) return script;
  const unrestrictLine = encoder.encode(`\n\\unrestrict ${key}\n`);
  const unrestrict = lastIndexOfBytes(script, unrestrictLine);
  const parts = [script.subarray(0, lineStart)];
  if (unrestrict > end) {
    parts.push(script.subarray(end, unrestrict + 1), script.subarray(unrestrict + unrestrictLine.byteLength));
  } else {
    parts.push(script.subarray(end));
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** The dump as a `File`: a plain script without its psql-only lines, or an archive as it is. */
export function dumpFile(output: Uint8Array, fileName: string): File {
  if (isArchive(output)) {
    return new File([output.slice()], fileName, { type: "application/octet-stream" });
  }
  return new File([withoutRestrictLines(output).slice()], fileName, { type: "text/plain" });
}

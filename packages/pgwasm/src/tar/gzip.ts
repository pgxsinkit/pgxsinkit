// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

/**
 * gzip through the platform's `CompressionStream` / `DecompressionStream`, which Bun and every
 * supported browser context provide, so there is one code path and no Node `zlib` fallback.
 */

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** Whether the bytes start with the gzip magic number. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return await pipe(bytes, new CompressionStream("gzip"));
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return await pipe(bytes, new DecompressionStream("gzip"));
}

/** Decompress when the bytes are gzip (by magic number), otherwise return them unchanged. */
export async function gunzipIfCompressed(bytes: Uint8Array): Promise<Uint8Array> {
  return isGzip(bytes) ? await gunzip(bytes) : bytes;
}

async function pipe(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = new Blob([bytes.slice()]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(input).arrayBuffer());
}

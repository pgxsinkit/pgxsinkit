// Began as a copy of `@electric-sql/pg-protocol`, itself adapted from node-postgres' `pg-protocol`
// (MIT, © Brian Carlson; ElectricSQL's changes taken under the PostgreSQL License — see NOTICE).
// Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

/**
 * The byte length of a string once UTF-8 encoded.
 * Adapted from https://stackoverflow.com/a/23329386
 */
export function byteLengthUtf8(str: string): number {
  let byteLength = str.length;
  for (let i = str.length - 1; i >= 0; i--) {
    const code = str.charCodeAt(i);
    if (code > 0x7f && code <= 0x7ff) byteLength++;
    else if (code > 0x7ff && code <= 0xffff) byteLength += 2;
    if (code >= 0xdc00 && code <= 0xdfff) i--; // trail surrogate
  }
  return byteLength;
}

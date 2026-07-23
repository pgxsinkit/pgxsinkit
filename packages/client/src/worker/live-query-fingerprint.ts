// Canonical fingerprint for a live query (ADR-0040 decisions 2 & 3). Two identical live queries — same
// POST-WRAP SQL, same bound params, same key mode — must map to ONE PGlite registration; anything that
// changes what PGlite actually runs (or how the diff is keyed) must map to a DISTINCT one. The fingerprint
// covers EXECUTION-relevant inputs only: the materialized SQL, a TYPED encoding of the params, and the PK
// columns (which pick `live.incrementalQuery` vs `live.query` and drive the diff key). `use` is deliberately
// NOT an input — activation/hydration are per-subscriber pre-steps that never influence the registration
// (ADR-0040 decision 3), so keying on `use` would only split sharing.
//
// The param codec runs over the DECODED (structured-clone) values and TAGS every leaf by type, so a value
// can never collide with a different-typed value that happens to stringify the same — a `Date` never with
// its ISO string, a `Uint8Array` never with its hex text, a number never with its numeric string.

/** The map key (full canonical string — the dedup identity) plus a short digest for diagnostics (Slice 5). */
export interface LiveQueryFingerprint {
  /** The exact dedup key: two subscriptions share a registration iff their `key` is identical. */
  key: string;
  /** A short, opaque hash of `key` — for diagnostics/observability only, NEVER used for dedup. */
  digest: string;
}

// Per-call unique token for values we cannot canonicalize (unknown prototypes). A random suffix guarantees
// two opaque values never collide; the counter guarantees uniqueness even within one millisecond.
let opaqueCounter = 0;
function opaqueToken(): string {
  return `${(opaqueCounter++).toString(36)}.${Math.random().toString(36).slice(2)}`;
}

/** Lowercase hex of a byte buffer — portable (no `Buffer`/`btoa`, so it runs in a browser SharedWorker). */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A JSON-safe, type-tagged encoding node: a `[tag, …payload]` tuple whose first element is the type tag. */
type Encoded = readonly [string, ...unknown[]];

/**
 * Encode one decoded value into a type-TAGGED, JSON-SAFE STRUCTURE (a `[tag, …]` tuple), never a flat string.
 * The tag is the first array element, so two values of different types can never collide, and because the
 * whole tuple is serialized ONCE with `JSON.stringify` (below), JSON does all the escaping/framing — a
 * delimiter-bearing string in an array or object can no longer masquerade as extra members (the flat-string
 * codec's collision class, e.g. `[["x,s:y"]]` vs `[["x","y"]]`). Recurses through arrays (order-significant)
 * and plain objects (keys SORTED, so object key order never changes the fingerprint).
 */
function encodeValue(value: unknown): Encoded {
  if (value === null) return ["z"]; // null
  if (value === undefined) return ["v"]; // undefined (distinct from null)
  switch (typeof value) {
    case "boolean":
      return ["b", value];
    case "number":
      // `String` already canonicalizes signed zero (`String(-0) === "0"`) and renders NaN/±Infinity
      // deterministically; NaN is an ALLOWED value here (two NaN params share a fingerprint), not a bail-out.
      return ["n", String(value)];
    case "bigint":
      return ["i", value.toString()];
    case "string":
      return ["s", value];
    case "object": {
      if (value instanceof Date) return ["d", value.getTime()]; // tagged epoch-ms — never equals an ISO string
      if (value instanceof Uint8Array) return ["x", toHex(value)];
      if (value instanceof ArrayBuffer) return ["x", toHex(new Uint8Array(value))];
      // Honour the view's window: encoding the WHOLE underlying buffer would falsely collide two different
      // views sharing one buffer (a wrong-dedup — the exact hazard this codec exists to prevent).
      if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        return ["x", toHex(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))];
      }
      if (Array.isArray(value)) return ["a", value.map(encodeValue)];
      if (isPlainObject(value)) {
        const record = value as Record<string, unknown>;
        const members = Object.keys(record)
          .sort()
          .map((k) => [k, encodeValue(record[k])] as const);
        return ["o", members];
      }
      // Unknown prototype (a class instance, Map, Set, …): we cannot canonicalize it safely, so tag it
      // `opaque` with a per-call unique token — it will NEVER dedup with anything (including an identical
      // instance) and NEVER falsely collide. Correctness over sharing for the values we don't understand.
      return ["q", opaqueToken()];
    }
    default:
      // function / symbol — not producible by structured clone, but stay safe: treat as opaque.
      return ["q", opaqueToken()];
  }
}

/** FNV-1a (32-bit) → 8 hex chars. Diagnostics only; the FULL `key` string is the dedup identity, never this. */
function shortDigest(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Fingerprint a live query. `materialSql` is the POST-WRAP SQL (the manager's registration input); `params`
 * are the decoded bound params; `pkColumns` selects the key mode. Returns the full canonical `key` (the dedup
 * identity) and a short `digest` for diagnostics.
 */
export function fingerprintLiveQuery(
  materialSql: string,
  params: readonly unknown[],
  pkColumns?: readonly string[],
): LiveQueryFingerprint {
  // Single-column PK → PGlite `live.incrementalQuery`; composite/keyless → `live.query` + worker-side diff.
  // The mode AND the exact pk columns both matter: same SQL with a different pk column is a different
  // registration (different diff key), and incremental vs full are different PGlite machines.
  const mode = pkColumns && pkColumns.length === 1 ? "inc" : "full";
  // ONE `JSON.stringify` over a fixed-shape object of type-tagged encoding STRUCTURES: the SQL is its own JSON
  // string element (cannot bleed into params), and JSON escaping makes the whole key unambiguous — no manual
  // delimiter framing anywhere, so no delimiter-bearing value can forge extra structure.
  const key = JSON.stringify({
    sql: materialSql,
    params: params.map(encodeValue),
    pk: pkColumns ? [...pkColumns] : null,
    mode,
  });
  return { key, digest: shortDigest(key) };
}

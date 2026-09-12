# Raw statements carry a COPY blob

Status: accepted (2026-09-12) — amends [ADR-0032](0032-sync-engine-in-shared-worker.md) decision 4

## Context

ADR-0032 decision 4 put the raw trio on the client shape both forms share, and `rawTransaction` gave the
one audience that is not a debug page — a consumer's LOCAL-ONLY tables, which pgxsinkit does not manage —
an atomic way to write them on a worker-attached client. The seam's statement is `{ sql, params }`: a
single statement with bound parameters.

That shape has a hard ceiling, and a consumer just hit it. A language module owns a definition cache —
10⁴–10⁵ rows, one `jsonb` column — filled in chunks of up to 1000 rows fetched from its server. On
`{ sql, params }` the only way to write a chunk is an INSERT per row: 1000 statements, each with its own
plan and round trip through the seam (and, on a worker-attached client, 1000 RPCs unless they are wrapped
in one `rawTransaction`, which then carries 1000 statements). The database has exactly the right primitive
for this — `COPY` — and pgxsinkit already uses it.

**Everything needed is in the library, and none of it is reachable.** The sync applier's bulk path
(`applyMessagesToTableWithCopy`) loads a batch with `COPY <table> (cols) FROM '/dev/blob' WITH (FORMAT
text)`, feeding PGlite's blob-ingest grammar through its `{ blob }` query option, and serializes the rows
with a faithful port of Postgres' own `CopyAttributeOutText` / `array_out` (`sync/copy.ts`) — arrays,
multi-dimensional arrays, `json`/`jsonb`, `bytea`, timestamps and strings with embedded delimiters all
round-trip, and a unit suite pins every built-in type against a parameterized INSERT. But `RawStatement`
has no field for the bytes, the in-process seam passes only `options` to `tx.query`, the worker bridge
structured-clones the statement list with no transfer list, and the serializer is not exported. An app
that owns its own table has the whole mechanism sitting behind a wall.

The bridge is the reason this is not simply "add a field". A COPY body is bulk bytes; cloning a megabyte
per chunk across `postMessage` would hand back much of what COPY wins. The library already has the
pattern for exactly this — ADR-0035's store backup decomposes a `File` into a transferred `ArrayBuffer`
(`RestoreArtefactWire`) because a `Blob` cannot cross as a transferable.

## Decision

1. **The blob rides on the STATEMENT, not on the client.** `RawStatement` gains an optional
   `blob?: Uint8Array<ArrayBuffer>`: the bytes PGlite reads for THAT statement's `/dev/blob`. A COPY is one
   statement's input, so that is where its input belongs — a client-level or transaction-level blob would
   have to answer "which statement in the list is it for?", and the honest answer is always "that one".
   `rawQuery` gets the same field on `RawQueryOptions` for the single-statement form (a chunk load needs no
   transaction around it when nothing else must land with it). `rawExec` does NOT: its PGlite counterpart
   runs a multi-statement script through the simple protocol, which has no `/dev/blob` hook. The field is
   typed over a real `ArrayBuffer` rather than the default `ArrayBufferLike` because that is the contract —
   a `SharedArrayBuffer`-backed view can neither be transferred nor read as a `Blob` part.

2. **The bytes are TRANSFERRED across the bridge, never copied — so the caller's buffer is consumed.** The
   tab lists every statement's `blob.buffer` on the dispatch's `postMessage` transfer list (the ADR-0035
   restore precedent, now a general per-message `transfer` argument on the RPC helper). The caller's buffer
   is therefore DETACHED once the call dispatches: it must not be read, reused, or re-sent. That is stated
   on the field, and a unit test asserts `byteLength === 0` on the tab after the call. Zero-copy is the
   entire point of choosing COPY here; a silently cloned megabyte would be a worse lie than a detached
   buffer.

   Nothing is rebuilt worker-side: a `Uint8Array` survives structured clone AS a `Uint8Array` view over the
   transferred buffer, so the worker hands the in-process client exactly the `RawStatement[]` it takes, and
   the single `Uint8Array → Blob` wrap lives in that client, at the PGlite call, for both client forms. No
   wire type changes.

   One consequence is recorded explicitly: a dispatch that transferred bytes is stamped a MUTATION for
   relocation settlement regardless of its op, so a lost response settles `"unknown"` rather than
   `"not-dispatched"`. `"not-dispatched"` means "safe to repeat", and a caller whose buffer is detached has
   nothing left to repeat with. A dispatch that never left the tab (the handoff queue's cap/deadline path)
   still settles `"not-dispatched"` — its buffers are intact.

3. **The serializer and the statement builder are PUBLIC.** `serializeCopyValue` and `generateCopyData`
   are exported from the package root with the contract an app-owned table needs spelled out: the column
   order passed IS the column list the COPY statement must name, and `json`/`jsonb` values must be given
   PARSED (objects, not pre-stringified JSON) with the column's Postgres `udt_name` in the type map. Above
   them sits `buildCopyFromBlobStatement({ table, columns, rows, udtNames })`, which renders the statement
   AND serializes the bytes from one column list, so the two cannot drift. It takes the table as a **Drizzle
   table object** and reads its identifier with `getTableConfig`, so no identifier in the rendered SQL is
   ever a hand-written string — a rename cannot leave a stale name behind. The statement text itself stays
   tier ③ (ADR-0028 allow-list): `COPY … FROM '/dev/blob'` is PGlite's blob-ingest grammar and has no
   Drizzle builder form.

4. **The applier and the raw seam share ONE implementation.** `applyMessagesToTableWithCopy` calls
   `buildCopyFromBlobStatement` instead of rendering its own COPY and serializing separately. An app-owned
   table therefore bulk-loads through exactly the code path the sync applier is tested against, and the
   COPY TEXT contract cannot fork between "what the library does to its own tables" and "what a consumer is
   handed for its own".

## Alternatives considered

- **A dedicated `copyInto(table, rows)` API.** The friendly shape — until it has to type itself. The
  target is a table the registry does not model: pgxsinkit knows no columns, no types and no identity for
  it, so the method would either take all of that as arguments (which is the builder, wearing a method's
  clothes) or introspect `information_schema` per call. It would also have to re-answer, for an unmanaged
  table, every question the raw seam already answers — transaction membership, worker dispatch, relocation
  settlement — when the raw seam exists precisely because app-owned tables need a generic escape.

- **Accept a `Blob` on the wire.** The natural type, given PGlite takes one — and not transferable. It
  would be structured-cloned on every dispatch, giving up the zero-copy win exactly where it matters most,
  and ADR-0035's restore precedent already decomposes a `Blob` into bytes + metadata for this reason.
  Bytes in, `Blob` built at the PGlite call, one wrap in one place.

- **Leave it to the consumer: export the serializer only, let apps hand-write the COPY statement.** Cheaper
  by one function, and it puts a hand-written `COPY "schema"."table" (…)` string — with the column list
  that must match the serializer's column order — into every consuming app, un-renamed-safe and duplicated
  per call site. The builder is small; the failure it prevents is silent column misalignment.

- **A chunked-INSERT helper instead (multi-row `VALUES`).** No new wire concern at all, and it is what a
  consumer would write today. It is also 10–100× the work per chunk for a `jsonb` payload, has a parameter
  ceiling per statement, and leaves the library's own COPY machinery unreachable while the app reimplements
  a worse version of it.

## Consequences

- The raw seam is now a **bulk-load** seam as well as an inspection one. `rawTransaction`'s docstring
  audience (LOCAL-ONLY tables an app owns) is unchanged; the ceiling on how much it can write in one
  statement is not.
- A consumer's buffer lifetime becomes part of the contract on the worker-attached client. The field
  documents it, the public builder produces a fresh buffer per call (so the natural usage is correct), and
  the bridge test pins the detachment.
- `sync/copy.ts` becomes public API surface. Its serialization behaviour was already load-bearing for
  every synced table; it is now load-bearing for consumer tables too, and its existing per-type round-trip
  suite is the proof for both.
- The bridge's RPC helper grows a general per-message `transfer` argument. Any later op with bulk bytes
  (a columnar codec, a zero-copy live-diff payload) uses the same seam rather than adding another.

/**
 * The change envelope carried on every Circuits table and shape stream.
 *
 * Restated rather than imported from `@electric-circuits/protocol`, for the reasons given on
 * {@link Predicate}: this is the wire contract pgxsinkit commits to, the protocol package is alpha,
 * and a published library should not put an alpha peer in its public types. The engine's serde
 * definitions are authoritative; any divergence is a bug here.
 */

/** A scalar cell value on the wire. */
export type StreamValue = string | number | boolean | null;

/** A row is a flat map of column name to value. */
export type StreamRow = Record<string, StreamValue>;

/**
 * The engine's **complete** shape-stream vocabulary — two verbs, not four.
 *
 * `insert`/`update` are the *input* side: what the replication ingestor parses out of Postgres. They
 * never reach a shape stream. Every row the engine emits goes out as `upsert` (`output.rs`
 * `translate_output`/`agg_envelope`) and every eviction as key-only `delete`
 * (`translate_output`/`delete_envelopes`) — the engine states the row's new value rather than
 * claiming anything about what preceded it, because a shape row can enter a subscriber's view for
 * reasons that are not a Postgres INSERT (a subquery flip, a scope grant, a backfill replay).
 *
 * Listing the input verbs here as if they might arrive is what produced a dead `"update"` branch in
 * the translator and a comment asserting `upsert` was backfill-only. Both were wrong.
 */
export type StreamOperation = "upsert" | "delete";

export interface StreamEnvelope {
  /** The table name — the collection discriminator. */
  type: string;
  /** The stringified primary key. Composite keys are already joined by the engine. */
  key: string;
  /** Present for insert/update/upsert; **absent for delete**, which is key-only. */
  value?: StreamRow;
  headers: {
    operation: StreamOperation;
    txid?: string;
    /** Stamped by the durable-streams server on read; never sent by a producer. */
    offset?: string;
    /**
     * Postgres commit LSN (`"HI/LO"` hex), stamped by the engine on **live** shape envelopes.
     *
     * **Absent on backfill rows**, and absent in library (no-Postgres) mode. That absence is why
     * ADR-0056 floors catch-up on the stream OFFSET rather than on this: a frontier that only some
     * envelopes can advance is not a frontier.
     */
    lsn?: string;
    /**
     * Position of the change within its transaction, stamped by the replication ingestor on
     * **table**-stream envelopes so the engine's own tailer can skip at-least-once duplicates.
     * **Not present on shape streams**, which is what we read — recorded so nobody builds
     * deduplication on a field that will never arrive.
     */
    seq?: number;
  };
}

/** A delete envelope carries no row body, so an eviction discloses nothing but the key. */
export function isDeleteEnvelope(envelope: StreamEnvelope): boolean {
  return envelope.headers.operation === "delete";
}

/**
 * One change as the APPLIER consumes it, after an envelope has been resolved against its table.
 *
 * Distinct from {@link StreamEnvelope} on purpose. An envelope is the wire form — key-only on a
 * delete, headers carrying transport metadata. This is what the apply path needs instead: a value
 * that is always present (a delete's is its reconstructed primary key), and the transport metadata
 * dropped.
 *
 * The operation set is {@link StreamOperation}'s, unchanged. The applier used to narrow the wire's
 * four verbs down to three DML verbs; there are only two verbs to carry now, and inventing a DML
 * distinction the engine never made is what the translator got wrong.
 *
 * `value` is `Record<string, unknown>` rather than {@link StreamRow} because the applier handles
 * values the wire never carries — a `bigint` id kept as a string for precision, a JSON column
 * arriving as a parsed object — and narrowing here would only push casts into the codecs.
 */
export type SyncRow = Record<string, unknown>;

export type SyncOperation = StreamOperation;

export interface SyncChange<T extends SyncRow = SyncRow> {
  /** The stringified primary key, as the stream named it. */
  key: string;
  value: T;
  headers: { operation: SyncOperation } & Record<string, unknown>;
}

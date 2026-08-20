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

export type StreamOperation = "insert" | "update" | "delete" | "upsert";

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

import type { Predicate } from "@pgxsinkit/contracts";

/**
 * The engine's shape-creation wire contract (`POST /shapes` → `ShapeResp`), restated here for the
 * same reason {@link Predicate} is: this is the boundary pgxsinkit commits to, and the engine's
 * serde definitions are authoritative for it.
 */
export interface CreateShapeRequest {
  table: string;
  where?: Predicate;
  /**
   * Output projection. Omitted = the full row; the primary key is always included regardless. The
   * predicate may reference columns outside this set, which is what lets a shape MATCH on a column it
   * does not EMIT — the control column a pre-computed redaction splits on (ADR-0055 decision 5).
   *
   * This is the ENGINE's projection, not the client's. `serverOnlyColumns` are IN it: an egress
   * `serverProjection.rowTransform` must read them, so they are fetched onto the stream on purpose and
   * are stripped from each row at the stream edge after the transform runs (`createStreamGate`). A
   * deployment that puts a cache between the engine and the edge is caching rows that still carry
   * them.
   */
  columns?: string[];
  /** Skip the backfill and stream only future matching changes. Subset queries only. */
  changesOnly?: boolean;
}

/** The engine's response to a shape creation or lookup. */
export interface CircuitsShapeHandle {
  shapeId: string;
  table: string;
  /** Stream path on the durable-streams server, e.g. `shape/s1`. */
  streamPath: string;
  /** Absolute URL of that stream, as the engine resolves its durable-streams base. */
  streamUrl: string;
  /** Retention lifecycle; absent on a freshly created shape, which is always active. */
  state?: "active" | "deactivating" | "dormant" | "reactivating";
}

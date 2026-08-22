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
  /**
   * The caller's **subscription id** — the name this claim on the shape is taken under (fork
   * ADR-0008). Any non-empty string up to 128 bytes with no control characters, and never starting
   * with `~` unless it is the `~` id the engine itself returned to you (the engine mints into that
   * namespace, and refuses an unknown `~` id as forged).
   *
   * Optional on the WIRE, because the engine will mint one for a caller that names none. It is not
   * optional for pgxsinkit: every call site here sends one, because an unnamed claim is a claim this
   * control plane cannot renew idempotently — a repeat create would be indistinguishable from a
   * second subscriber. Naming it makes the create a RENEW when repeated, and makes the release
   * (`DELETE /shapes/{id}?subscription=…`) retry-safe.
   */
  subscription?: string;
}

/**
 * The engine's response to a shape CREATE (`POST /shapes` → `ShapeResp`).
 *
 * `subscription` and `leaseSeconds` are present on a create and absent on a bare `GET /shapes/{id}`
 * lookup, which belongs to no subscriber. This client only ever creates, so both are required here
 * and the client refuses a create answer that omits either — see `createShape`.
 */
export interface CircuitsShapeHandle {
  shapeId: string;
  table: string;
  /** Stream path on the durable-streams server, e.g. `shape/s1`. */
  streamPath: string;
  /** Absolute URL of that stream, as the engine resolves its durable-streams base. */
  streamUrl: string;
  /**
   * The subscription this create was recorded under — echoed back, so a caller that named its own id
   * can confirm it and a caller that named none learns the one the engine minted.
   */
  subscription: string;
  /**
   * How long this subscription may go unrenewed before the engine releases it
   * (`ELECTRIC_CIRCUITS_SHAPE_IDLE_SECS`, default 1800). `0` means leases never lapse, because that
   * setting also disables dormancy.
   *
   * Reported rather than guessed: the renewal cadence is the deployment's to set, and a control plane
   * that renews on a schedule the engine does not accept is a control plane whose live sessions lapse
   * (see `CircuitsLeaseConfigError`).
   */
  leaseSeconds: number;
  /** Retention lifecycle; absent on a freshly created shape, which is always active. */
  state?: "active" | "deactivating" | "dormant" | "reactivating";
}

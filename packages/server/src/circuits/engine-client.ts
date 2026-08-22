import type { CircuitsShapeHandle, CreateShapeRequest } from "./wire";

export interface CircuitsEngineOptions {
  /** Base URL of the Circuits engine's control API, e.g. `http://circuits-engine:4000`. */
  baseUrl: string;
  /** Injected for tests; defaults to the ambient `fetch`. */
  fetch?: typeof fetch;
}

/**
 * An engine call that did not return 2xx, carrying the status so a caller can map it to its own.
 *
 * The one status with a MEANING rather than a severity is **409**: a create whose `subscription` id
 * is already held by a different shape (fork ADR-0008 — one name, one shape). It is the caller's
 * conflict, not an outage, and no retry changes it; match it as `error.status === 409` and re-subscribe
 * under a fresh id. Everything else is either a request this client built wrong (4xx) or an engine
 * that could not answer (5xx), and both propagate as a 503 to the client.
 */
export class CircuitsEngineError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = "CircuitsEngineError";
    this.status = status;
    this.body = body;
  }
}

/**
 * The control plane's client for the Circuits engine.
 *
 * Only the shape LIFECYCLE goes through here. Reads never do: they terminate on durable-streams,
 * which is the whole point of the native topology — the engine is asked once, at subscribe time,
 * for a stream to follow, and is then out of the read path entirely.
 */
export function createCircuitsEngineClient(options: CircuitsEngineOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");

  async function call(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    const response = await doFetch(`${base}${path}`, { ...init, headers });
    const body = await response.text();
    if (!response.ok) {
      throw new CircuitsEngineError(
        response.status,
        body,
        `[pgxsinkit] circuits engine ${init.method ?? "GET"} ${path} → ${response.status}: ${body}`,
      );
    }
    return body === "" ? undefined : JSON.parse(body);
  }

  return {
    /**
     * Register a shape and get the stream to follow — **and renew that registration**.
     *
     * There is deliberately no `renewShape`: a renewal IS this call, repeated with the same
     * `request.subscription` on the same definition (fork ADR-0008). The engine answers the same
     * handle, counts nothing extra, and moves the lease forward. That is also why a create whose
     * response was lost can simply be sent again, and why the control plane's token re-mint can renew
     * every live claim without a second route.
     *
     * Two outcomes a caller must distinguish:
     * - **409** ({@link CircuitsEngineError.status}) — the id names a DIFFERENT shape already. One
     *   name, one shape; nothing was taken, and a retry will not change it.
     * - a **different handle** — the claim had lapsed or the shape was evicted, so this call
     *   re-subscribed rather than renewed. The stream the old grant named is not this one (ADR-0007).
     *
     * The engine shares by definition: two identical bodies collapse onto one maintained stream and
     * return the same handle. Nothing here has to check for that or cache against it — which is
     * exactly why the shared tier's predicate must be GENERATED. Two subscribers in one scope produce
     * identical bodies only because neither's identity reached the predicate; they are still two
     * distinct subscriptions, because each names its own claim.
     *
     * The answer is VALIDATED, not cast, for the same reason {@link replicationState} validates the
     * barrier: an engine that acknowledges a create without saying which subscription it recorded or
     * how long that subscription lives cannot be renewed or released by id at all, and defaulting
     * either field would invent a lease this control plane was never promised.
     */
    async createShape(request: CreateShapeRequest): Promise<CircuitsShapeHandle> {
      const body = (await call("/shapes", {
        method: "POST",
        body: JSON.stringify(request),
      })) as Partial<CircuitsShapeHandle> | null;
      if (body === null || typeof body !== "object") throw unusableCreate("the body", body);
      if (typeof body.shapeId !== "string") throw unusableCreate("shapeId", body.shapeId);
      if (typeof body.streamPath !== "string") throw unusableCreate("streamPath", body.streamPath);
      if (typeof body.subscription !== "string" || body.subscription === "") {
        throw unusableCreate("subscription", body.subscription);
      }
      if (typeof body.leaseSeconds !== "number") throw unusableCreate("leaseSeconds", body.leaseSeconds);
      return body as CircuitsShapeHandle;
    },

    /**
     * Release ONE named subscription's claim on a shape (`DELETE /shapes/{id}?subscription=…`).
     *
     * **Idempotent**, and that is the whole point of naming the claim: releasing one that is already
     * gone is a no-op `200` rather than a decrement that steals another subscriber's. A caller whose
     * response was lost may simply send it again.
     *
     * There is no anonymous form here. The engine still accepts a bare `DELETE /shapes/{id}` as a
     * legacy refcount decrement, but it carries no claim identity and is not retry-safe, so this
     * client never issues one.
     *
     * The shape itself survives its other subscribers and then follows the engine's retention
     * lifecycle (idle → dormant → evicted); this is a release, not a delete.
     */
    async releaseShape(shapeId: string, subscription: string): Promise<void> {
      const query = `?subscription=${encodeURIComponent(subscription)}`;
      await call(`/shapes/${encodeURIComponent(shapeId)}${query}`, { method: "DELETE" });
    },

    /**
     * The engine's convergence barrier (ADR-0056): where replication is, how many
     * computed-but-undelivered subquery flips remain, and how many flip batches the engine gave up
     * on.
     *
     * The engine answers a `sync` field beside these and it is deliberately NOT read: it is the
     * `__el_sync` sentinel watermark — an i64 the engine's conformance harness bumps and waits on as
     * a global quiescence fence — which no pgxsinkit database ever writes, so it is 0 everywhere and
     * says nothing about convergence.
     *
     * `pendingFlips > 0` means a revocation has been computed and not yet written to any stream,
     * which no wire-format watermark can see. That is the term the Electric wire could not express
     * at all, and the reason the barrier is read out of band rather than inferred from a position.
     *
     * `flipFailures > 0` means a batch was **abandoned** after exhausting its propagation retries:
     * those membership effects are gone rather than late. The engine keeps the abandoned batch's
     * `pendingFlips` count held — so the waiting terms never falsely read converged — and latches
     * itself degraded: `/v1/health` answers 503, so do its membership-bearing routes, and a reaper
     * deletes every subquery shape stream. Recovery is an operator restart.
     *
     * The answer is VALIDATED, not cast. An engine that does not report both counters cannot answer
     * the question this barrier asks, and defaulting a missing term to zero would manufacture a
     * converged reading out of an engine that never claimed one.
     */
    async replicationState(): Promise<CircuitsReplicationState> {
      const body = (await call("/replication/lsn", { method: "GET" })) as Partial<CircuitsReplicationState>;
      if (body === null || typeof body !== "object") throw unusableBarrier("the body", body);
      if (body.lsn !== null && typeof body.lsn !== "string") throw unusableBarrier("lsn", body.lsn);
      if (typeof body.pendingFlips !== "number") throw unusableBarrier("pendingFlips", body.pendingFlips);
      if (typeof body.flipFailures !== "number") throw unusableBarrier("flipFailures", body.flipFailures);
      return { lsn: body.lsn, pendingFlips: body.pendingFlips, flipFailures: body.flipFailures };
    },
  };
}

/**
 * An engine whose barrier this client cannot read is not a degraded engine — it is the wrong engine,
 * and saying so is the point. Silently tolerating the omission would leave a gate claiming to check a
 * term nothing reports.
 */
function unusableBarrier(field: string, value: unknown): Error {
  return new Error(
    `[pgxsinkit] the engine's GET /replication/lsn answered with an unusable \`${field}\` (${JSON.stringify(value)}). ` +
      `This client requires an engine reporting the whole convergence barrier — \`lsn\`, \`pendingFlips\` and ` +
      `\`flipFailures\` (ADR-0056 decision 3); the engine at this URL is not the one this client targets.`,
  );
}

/**
 * An engine whose create answer this client cannot read is not a degraded engine — it is the wrong
 * engine, exactly as {@link unusableBarrier} says of the barrier. A create that does not name the
 * subscription it was recorded under, or the window that subscription must be renewed within, leaves
 * a claim nothing can renew and nothing can release by id; defaulting either would manufacture a
 * lease the engine never granted.
 */
function unusableCreate(field: string, value: unknown): Error {
  return new Error(
    `[pgxsinkit] the engine's POST /shapes answered with an unusable \`${field}\` (${JSON.stringify(value)}). ` +
      `This client requires an engine that records every shape claim under a named, leased subscription — ` +
      `\`shapeId\`, \`streamPath\`, \`subscription\` and \`leaseSeconds\` (fork ADR-0008); the engine at this ` +
      `URL is not the one this client targets.`,
  );
}

export type CircuitsEngineClient = ReturnType<typeof createCircuitsEngineClient>;

/** What `GET /replication/lsn` answers that this client reads — these fields exactly, no more. */
export interface CircuitsReplicationState {
  /** The ingest head — where the replication tailer has read to. */
  lsn: string | null;
  pendingFlips: number;
  /**
   * Flip batches the engine abandoned after exhausting their retries. Non-zero means membership
   * effects were **lost**, not delayed: the batch's pending count stays held, the engine is latched
   * degraded, and only a restart clears it.
   */
  flipFailures: number;
}

import type { CircuitsShapeHandle, CreateShapeRequest } from "./wire";

export interface CircuitsEngineOptions {
  /** Base URL of the Circuits engine's control API, e.g. `http://circuits-engine:4000`. */
  baseUrl: string;
  /** Injected for tests; defaults to the ambient `fetch`. */
  fetch?: typeof fetch;
}

/** An engine call that did not return 2xx, carrying the status so a caller can map it to its own. */
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
     * Register a shape and get the stream to follow.
     *
     * The engine shares by definition: two identical bodies collapse onto one maintained stream and
     * return the same handle, ref-counted. Nothing here has to check for that or cache against it —
     * which is exactly why the shared tier's predicate must be GENERATED. Two subscribers in one
     * scope produce identical bodies only because neither's identity reached the predicate.
     */
    async createShape(request: CreateShapeRequest): Promise<CircuitsShapeHandle> {
      return (await call("/shapes", {
        method: "POST",
        body: JSON.stringify(request),
      })) as CircuitsShapeHandle;
    },

    /**
     * Drop one subscription's claim on a shape. The shape itself survives its other subscribers and
     * then follows the engine's retention lifecycle (idle → dormant → evicted); this is a release,
     * not a delete.
     */
    async releaseShape(shapeId: string): Promise<void> {
      await call(`/shapes/${encodeURIComponent(shapeId)}`, { method: "DELETE" });
    },

    /**
     * The engine's convergence barrier (ADR-0056): where replication is, whether the tailer has
     * caught up, how many computed-but-undelivered subquery flips remain, and how many flip batches
     * the engine gave up on.
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
      return {
        lsn: body.lsn,
        sync: body.sync === true,
        pendingFlips: body.pendingFlips,
        flipFailures: body.flipFailures,
      };
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
      `This client requires an engine reporting the whole convergence barrier — \`lsn\`, \`sync\`, \`pendingFlips\` and ` +
      `\`flipFailures\` (ADR-0056 decision 3); the engine at this URL is not the one this client targets.`,
  );
}

export type CircuitsEngineClient = ReturnType<typeof createCircuitsEngineClient>;

/** What `GET /replication/lsn` answers — these fields exactly, no more. */
export interface CircuitsReplicationState {
  /** The ingest head — where the replication tailer has read to. */
  lsn: string | null;
  sync: boolean;
  pendingFlips: number;
  /**
   * Flip batches the engine abandoned after exhausting their retries. Non-zero means membership
   * effects were **lost**, not delayed: the batch's pending count stays held, the engine is latched
   * degraded, and only a restart clears it.
   */
  flipFailures: number;
}

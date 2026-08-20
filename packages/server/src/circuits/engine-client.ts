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
     * The engine's convergence barrier (ADR-0056): replication position, whether the tailer has
     * caught up, and how many computed-but-undelivered subquery flips remain. All three are the
     * barrier — `pendingFlips > 0` means a revocation has been computed and not yet written to any
     * stream, which no wire-format watermark can see.
     */
    async replicationState(): Promise<{ lsn: string | null; sync: boolean; pendingFlips: number }> {
      return (await call("/replication/lsn", { method: "GET" })) as {
        lsn: string | null;
        sync: boolean;
        pendingFlips: number;
      };
    },
  };
}

export type CircuitsEngineClient = ReturnType<typeof createCircuitsEngineClient>;

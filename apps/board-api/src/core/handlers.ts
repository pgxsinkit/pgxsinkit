import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { boardSyncRegistry } from "@pgxsinkit/board-schema";
import type { JwtClaims, RegistryRelations } from "@pgxsinkit/contracts";
import {
  createCircuitsEngineClient,
  createStreamGate,
  createSyncServer,
  importStreamTokenKey,
  STREAM_READ_EXPOSED_HEADERS,
  type EventsEnqueuedHook,
} from "@pgxsinkit/server";

import { stripFunctionPrefix } from "./routing";

export type BoardDb = PgAsyncDatabase<PgQueryResultHKT, RegistryRelations<typeof boardSyncRegistry>>;
export type BoardClaimsResolver = (request: Request) => Promise<JwtClaims | null> | JwtClaims | null;
export type FetchHandler = (request: Request) => Promise<Response>;

export interface BoardHandlerOptions {
  resolveAuthClaims: BoardClaimsResolver;
  allowedOrigins: string[];
}

export interface BoardWriteHandlerOptions extends BoardHandlerOptions {
  db: BoardDb;
  /**
   * The Event lane's ingest-side nudge (pgxsinkit ADR-0053, amendment 2026-08-02). Wired only on the cloud
   * stack, where the drain is a scheduled function rather than a long-lived process; see
   * `core/events-drain.ts`. Absent locally, where the runner polls anyway.
   */
  onEventsEnqueued?: EventsEnqueuedHook;
}

export interface BoardSyncHandlerOptions extends BoardHandlerOptions {
  /** The Circuits engine's control API. Never client-reachable — only this function calls it. */
  circuitsEngineUrl: string;
  /** The stream-token signing secret, shared with the edge. */
  streamTokenSecret: string;
}

export interface BoardStreamHandlerOptions extends Pick<BoardHandlerOptions, "allowedOrigins"> {
  /** durable-streams, which the edge proxies reads to. Never client-reachable directly. */
  durableStreamsUrl: string;
  /** The stream-token signing secret, shared with the control plane. */
  streamTokenSecret: string;
}

export function createBoardWriteHandler(options: BoardWriteHandlerOptions): FetchHandler {
  const server = createSyncServer({
    registry: boardSyncRegistry,
    db: options.db,
    resolveAuthClaims: options.resolveAuthClaims,
    deployment: {
      startupVerification: "deploy-time",
      operationsLog: "disabled",
    },
    logTimings: true,
    allowedOrigins: options.allowedOrigins,
    ...(options.onEventsEnqueued ? { onEventsEnqueued: options.onEventsEnqueued } : {}),
  });

  return (request) => server.fetch(stripFunctionPrefix(request, "board-write"));
}

/**
 * The board's native read-path control plane (ADR-0055): subscribe, re-mint, barrier.
 *
 * It answers about streams; it never serves their bytes. Board reads terminate on durable-streams
 * through the edge, so this function is asked once per subscription and is then out of the read path
 * — which is exactly what lets those streams be cached at all.
 *
 * No entitlement set: the board registry declares no shared-tier shape, and omitting it is the
 * statement of that fact. Adding one without wiring entitlements then fails loudly at subscribe
 * rather than quietly serving one member's rows to every visitor.
 */
export async function createBoardSyncHandler(options: BoardSyncHandlerOptions): Promise<FetchHandler> {
  const server = createSyncServer({
    registry: boardSyncRegistry,
    db: undefined as never,
    resolveAuthClaims: options.resolveAuthClaims,
    readPath: {
      engine: createCircuitsEngineClient({ baseUrl: options.circuitsEngineUrl }),
      key: await importStreamTokenKey(options.streamTokenSecret),
    },
    logTimings: true,
    allowedOrigins: options.allowedOrigins,
  });

  return async (request) => {
    const response = await server.fetch(stripFunctionPrefix(request, "board-sync"));
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

/**
 * The board's EDGE: verify the stream token, then proxy durable-streams bytes.
 *
 * A separate function from `board-sync`, and that separation is the point rather than tidiness. The
 * cache key is the URL, so the surface a CDN may share between subscribers has to be addressable
 * apart from the one that answers per-subject questions. Splitting them is what leaves the door open
 * to putting a CDN in front of this one and nothing in front of the other.
 *
 * No entitlement set, matching `board-sync`: the board declares no shared-tier shape, so a scoped
 * grant can only arrive if someone added one without wiring entitlements — and it is denied.
 */
export async function createBoardStreamHandler(options: BoardStreamHandlerOptions): Promise<FetchHandler> {
  const key = await importStreamTokenKey(options.streamTokenSecret);
  // The same `boardSyncRegistry` the control plane compiles shapes from — the edge resolves each
  // granted shapeKey in it to learn whether the shape declares an egress `serverProjection.rowTransform`
  // it must rewrite (ADR-0055 decision 5). Read off the module import rather than taken as an option,
  // matching `createBoardWriteHandler`/`createBoardSyncHandler`: the board serves exactly one registry,
  // and a second way to name it is a second way for the two halves to disagree.
  const handleStreamRead = createStreamGate({
    key,
    registry: boardSyncRegistry,
    durableStreamsUrl: options.durableStreamsUrl,
  });

  return async (request) => {
    const stripped = stripFunctionPrefix(request, "board-stream");
    const { pathname } = new URL(stripped.url);

    const cors: Record<string, string> = {
      "Access-Control-Allow-Origin": corsOriginFor(request, options.allowedOrigins),
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "authorization,apikey,content-type",
      // The edge is on its own origin by design, so every board read is cross-origin and none of the ds
      // protocol's response headers is CORS-safelisted. Set here rather than left to the gateway: the
      // compose stack's envoy sends `expose_headers: "*"`, which would leave this function correct only
      // behind that one deployment and silently hot-looping (`offset=-1`) anywhere else.
      "Access-Control-Expose-Headers": STREAM_READ_EXPOSED_HEADERS.join(", "),
      Vary: "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!pathname.startsWith(`${STREAM_MOUNT_PATH}/`)) {
      return new Response(JSON.stringify({ error: "not a stream path" }), {
        status: 404,
        headers: { ...cors, "content-type": "application/json" },
      });
    }

    // `now` is the request-start time so a long poll held across the token's expiry is judged by when
    // it started, rather than being killed mid-flight at the TTL boundary.
    const response = await handleStreamRead(
      stripped,
      pathname.slice(STREAM_MOUNT_PATH.length + 1),
      Math.floor(Date.now() / 1000),
    );
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

/** The board's edge mount, matching the `streamBaseUrl` the client is configured with. */
const STREAM_MOUNT_PATH = "/v1/stream";

function corsOriginFor(request: Request, allowedOrigins: string[]): string {
  const origin = request.headers.get("Origin");
  return origin && allowedOrigins.includes(origin) ? origin : (allowedOrigins[0] ?? "*");
}

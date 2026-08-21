import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { boardSyncRegistry } from "@pgxsinkit/board-schema";
import type { JwtClaims, RegistryRelations } from "@pgxsinkit/contracts";
import {
  createCircuitsEngineClient,
  createSyncServer,
  importStreamTokenKey,
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

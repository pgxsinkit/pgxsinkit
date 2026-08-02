import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { boardSyncRegistry } from "@pgxsinkit/board-schema";
import type { JwtClaims, RegistryRelations } from "@pgxsinkit/contracts";
import { createSyncServer, proxyElectricShapeRequest, type EventsEnqueuedHook } from "@pgxsinkit/server";

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
  electricUrl: string;
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

export function createBoardSyncHandler(options: BoardSyncHandlerOptions): FetchHandler {
  return async (request) => {
    const claims = await options.resolveAuthClaims(request);
    const response = await proxyElectricShapeRequest(request, claims, {
      registry: boardSyncRegistry,
      electricUrl: options.electricUrl,
      cors: { origins: options.allowedOrigins },
      logTimings: true,
    });
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

// The ADR-0049 step-12 SERVER-LANE fixture server (launcher-side, Bun/Node — NEVER imported by the browser
// bundle). It hosts the REAL sync stack over the container Postgres + Circuits + durable-streams:
// `createSyncServer`'s write handler (`POST /api/mutations`), the native control plane (`/sync/v1/*`), and the
// EDGE (`/v1/stream/*`) — all with CORS for the placement suite origin, over the standalone `fkSyncRegistry`
// `fk_parents` table (no RLS/FK — the simplest genuinely-syncable integration fixture). A thin CONTROL surface
// (`POST /__control`) injects an artificial per-write delay (`writeDelayMs`) or a hard refusal (`refuseWrites`
// → 503) so the placement lanes can hold a write in flight / prove offline-first commit.
//
// The edge rides this same origin rather than a second one, unlike the integration lanes: the browser suite
// needs every URL it talks to inside one CORS allow-list, and the fixture is not modelling the CDN topology.

import { count, sql } from "drizzle-orm";

import { fkParentsTable, fkSyncRegistry } from "@pgxsinkit/schema";
import {
  createCircuitsEngineClient,
  createStreamGate,
  createSyncServer,
  importStreamTokenKey,
  STREAM_READ_EXPOSED_HEADERS,
} from "@pgxsinkit/server";
import { createServerDb } from "@pgxsinkit/test-utils";

import { installPlpgsqlBatchFunction } from "../packages/server/src/mutations/plpgsql-apply";

export interface PlacementFixtureServer {
  port: number;
  batchWriteUrl: string;
  /** The native control plane this fixture mounts — subscribe / re-mint / barrier. */
  controlPlaneUrl: string;
  /** The edge this fixture mounts, on the same origin. */
  streamBaseUrl: string;
  /** Read the current `fk_parents` row count on the server (exactly-once convergence checks). */
  countParents: () => Promise<number>;
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const STREAM_MOUNT_PATH = "/v1/stream";

const FIXTURE_SUBJECT = "0198a000-0000-7000-8000-0000000f0001";

/**
 * The CORS headers every fixture response carries, edge reads included.
 *
 * Module-level and exported so the exposure rule can be pinned by a unit test — the fixture itself only
 * starts against containers, and the header set is exactly the part that must not silently regress.
 */
export function placementCorsHeaders(origin: string | null, allowedOrigins: string[]): Record<string, string> {
  const allow = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0]!;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,apikey,content-type",
    // The edge rides this same origin and the placement suite reads it from a BROWSER, cross-origin from
    // the preview server. Without this the ds client sees none of the stream headers, never advances past
    // `offset=-1`, and hot-loops — see `STREAM_READ_EXPOSED_HEADERS` for why that is silent.
    "Access-Control-Expose-Headers": STREAM_READ_EXPOSED_HEADERS.join(", "),
    Vary: "Origin",
  };
}

export async function startPlacementFixtureServer(opts: {
  databaseUrl: string;
  /** The container's Circuits engine control API, e.g. http://127.0.0.1:<port> */
  circuitsEngineUrl: string;
  /** The container's durable-streams server — what the edge proxies reads to. */
  durableStreamsUrl: string;
  port: number;
  /** Browser origins allowed to read/write (the placement suite preview origin). */
  allowedOrigins: string[];
}): Promise<PlacementFixtureServer> {
  const serverDb = createServerDb(fkSyncRegistry, opts.databaseUrl);

  // One key, minted by the control plane and verified by the edge, because both run in this process.
  const streamTokenKey = await importStreamTokenKey("placement-fixture-secret");

  const server = createSyncServer({
    registry: fkSyncRegistry,
    db: serverDb.db,
    // fk_parents carries no RLS, so the subject does not reach any predicate — but the native read path
    // still needs one, because a stream token names its bearer or it names nobody revocation could reach
    // (ADR-0055). A fixed authenticated claim is the whole auth story this fixture needs.
    resolveAuthClaims: () => ({ role: "authenticated", sub: FIXTURE_SUBJECT }),
    readPath: {
      engine: createCircuitsEngineClient({ baseUrl: opts.circuitsEngineUrl }),
      key: streamTokenKey,
    },
    allowedOrigins: opts.allowedOrigins,
  });

  const handleStreamRead = createStreamGate({
    key: streamTokenKey,
    registry: fkSyncRegistry,
    durableStreamsUrl: opts.durableStreamsUrl,
  });
  await installPlpgsqlBatchFunction(server.drizzle, fkSyncRegistry);

  // Fresh table each run (the container is per-run, but be explicit) so exactly-once counts start at zero.
  // Tier ② is deliberate: TRUNCATE gives this disposable fixture a fast child-inclusive reset and resets
  // identities. Ordered tier-① child/parent deletes could satisfy the FK, but would not provide those reset
  // semantics as one typed statement.
  await serverDb.db.execute(sql`TRUNCATE TABLE ${fkParentsTable} RESTART IDENTITY CASCADE`);

  // ── Control surface state ──
  let writeDelayMs = 0;
  let refuseWrites = false;
  let writesStarted = 0;

  const corsHeaders = (origin: string | null): Record<string, string> =>
    placementCorsHeaders(origin, opts.allowedOrigins);

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (url.pathname === "/__control") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
      const body = (await request.json().catch(() => ({}))) as { writeDelayMs?: number; refuseWrites?: boolean };
      if (typeof body.writeDelayMs === "number") writeDelayMs = body.writeDelayMs;
      if (typeof body.refuseWrites === "boolean") refuseWrites = body.refuseWrites;
      return Response.json({ writeDelayMs, refuseWrites, writesStarted }, { headers: corsHeaders(origin) });
    }

    // Server-side truth for exactly-once convergence assertions (the count of fk_parents rows on the DB).
    if (url.pathname === "/__count") {
      const [row] = await serverDb.db.select({ n: count() }).from(fkParentsTable);
      return Response.json({ count: row?.n ?? 0 }, { headers: corsHeaders(origin) });
    }

    // The edge. `createSyncServer` does not mount it — in production it is a separate, CDN-frontable
    // deployment — so the fixture mounts it here and adds the suite's CORS headers on the way out.
    if (url.pathname.startsWith(`${STREAM_MOUNT_PATH}/`)) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
      const streamed = await handleStreamRead(
        request,
        url.pathname.slice(STREAM_MOUNT_PATH.length + 1),
        Math.floor(Date.now() / 1000),
      );
      const headers = new Headers(streamed.headers);
      for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
      return new Response(streamed.body, { status: streamed.status, headers });
    }

    // The write path is where the control surface bites (offline-first: refuse; slow server: delay).
    if (url.pathname.startsWith("/api/mutations") && request.method === "POST") {
      writesStarted += 1;
      if (refuseWrites) {
        return new Response("write refused by fixture control", { status: 503, headers: corsHeaders(origin) });
      }
      if (writeDelayMs > 0) await sleep(writeDelayMs);
    }
    return server.fetch(request);
  };

  const listener = Bun.serve({ port: opts.port, fetch, idleTimeout: 60 });

  return {
    port: opts.port,
    batchWriteUrl: `http://127.0.0.1:${opts.port}/api/mutations`,
    controlPlaneUrl: `http://127.0.0.1:${opts.port}`,
    streamBaseUrl: `http://127.0.0.1:${opts.port}${STREAM_MOUNT_PATH}`,
    countParents: async () => {
      const [row] = await serverDb.db.select({ n: count() }).from(fkParentsTable);
      return row?.n ?? 0;
    },
    stop: async () => {
      await listener.stop(true);
      await server.stop();
      await serverDb.close();
    },
  };
}

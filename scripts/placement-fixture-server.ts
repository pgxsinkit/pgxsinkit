// The ADR-0049 step-12 SERVER-LANE fixture server (launcher-side, Bun/Node — NEVER imported by the browser
// bundle). It hosts the REAL sync stack over the container Postgres + Electric: `createSyncServer`'s write
// handler (`POST /api/mutations`) + the read-path Electric shape proxy (`GET /v1/electric-proxy`), both with
// CORS for the placement suite origin, over the standalone `fkSyncRegistry` `fk_parents` table (no RLS/FK — the
// simplest genuinely-syncable integration fixture). A thin CONTROL surface (`POST /__control`) injects an
// artificial per-write delay (`writeDelayMs`) or a hard refusal (`refuseWrites` → 503) so the placement lanes
// can hold a write in flight / prove offline-first commit.

import { count, sql } from "drizzle-orm";

import { fkParentsTable, fkSyncRegistry } from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import { createServerDb } from "@pgxsinkit/test-utils";

import { installPlpgsqlBatchFunction } from "../packages/server/src/mutations/plpgsql-apply";

export interface PlacementFixtureServer {
  port: number;
  batchWriteUrl: string;
  electricProxyUrl: string;
  /** Read the current `fk_parents` row count on the server (exactly-once convergence checks). */
  countParents: () => Promise<number>;
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startPlacementFixtureServer(opts: {
  databaseUrl: string;
  /** The container Electric shape endpoint, e.g. http://127.0.0.1:<port>/v1/shape */
  electricUrl: string;
  port: number;
  /** Browser origins allowed to read/write (the placement suite preview origin). */
  allowedOrigins: string[];
}): Promise<PlacementFixtureServer> {
  const serverDb = createServerDb(fkSyncRegistry, opts.databaseUrl);

  const server = createSyncServer({
    registry: fkSyncRegistry,
    db: serverDb.db,
    electricUrl: opts.electricUrl,
    shapeProxyPath: "/v1/electric-proxy",
    allowedOrigins: opts.allowedOrigins,
    // fk_parents carries no RLS, so no claims resolution is required — the write applier + unfiltered shape run
    // without auth (mirrors `write api deferred FK behavior` in tests/integration/write-api.integration.test.ts).
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

  const corsHeaders = (origin: string | null): Record<string, string> => {
    const allow = origin && opts.allowedOrigins.includes(origin) ? origin : opts.allowedOrigins[0]!;
    return {
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "authorization,apikey,content-type",
      Vary: "Origin",
    };
  };

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
    electricProxyUrl: `http://127.0.0.1:${opts.port}/v1/electric-proxy`,
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

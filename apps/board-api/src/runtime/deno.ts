import { createBoardClaimsResolver } from "../core/auth";
import { createBoardDrainNudge, createBoardIssueViewDrainHandler } from "../core/events-drain";
import { createBoardSyncHandler, createBoardWriteHandler } from "../core/handlers";
import { createDenoBoardDb } from "./deno-db";
import { parseAllowedOrigins, requireEnv } from "./env";

interface DenoRuntime {
  env: {
    get: (key: string) => string | undefined;
  };
  serve: (handler: (request: Request) => Promise<Response>) => void;
}

const deno = (globalThis as { Deno?: DenoRuntime }).Deno;

export function serveBoardWrite(): void {
  requireDeno().serve(createDenoBoardWriteHandler());
}

export function serveBoardSync(): void {
  requireDeno().serve(createDenoBoardSyncHandler());
}

/**
 * The Event lane's serverless drain (pgxsinkit ADR-0053, amendment 2026-08-02): the third function, invoked
 * by a Supabase Cron schedule and nudged by board-write. Only ever deployed to the cloud stack, where no
 * long-lived process can exist — the local stack keeps using `bun-consumer.ts`.
 */
export function serveBoardEventsDrain(): void {
  requireDeno().serve(createDenoBoardEventsDrainHandler());
}

export function createDenoBoardWriteHandler() {
  const env = readDenoEnv();
  // The nudge is wired only where a drain function exists (the cloud stack sets the secret). Locally the
  // long-lived runner is the drain, so the hook stays absent and board-write fires nothing.
  const nudge = createBoardDrainNudge({
    url: boardEventsDrainUrl(env),
    secret: env["BOARD_EVENTS_DRAIN_SECRET"],
  });
  return createBoardWriteHandler({
    db: createDenoBoardDb(
      requireEnv(env, ["SUPABASE_DB_URL"], "SUPABASE_DB_URL is not set — board-write cannot reach Postgres."),
    ),
    resolveAuthClaims: createBoardClaimsResolver({
      supabaseUrl: requireEnv(
        env,
        ["SUPABASE_URL"],
        "SUPABASE_URL is not set — board functions cannot resolve the GoTrue JWKS.",
      ),
      logTimings: true,
    }),
    allowedOrigins: parseAllowedOrigins(env["BOARD_ALLOWED_ORIGINS"]),
    ...(nudge ? { onEventsEnqueued: nudge } : {}),
  });
}

export function createDenoBoardEventsDrainHandler() {
  const env = readDenoEnv();
  return createBoardIssueViewDrainHandler({
    db: createDenoBoardDb(
      requireEnv(env, ["SUPABASE_DB_URL"], "SUPABASE_DB_URL is not set — board-events-drain cannot reach Postgres."),
    ),
    secret: requireEnv(
      env,
      ["BOARD_EVENTS_DRAIN_SECRET"],
      "BOARD_EVENTS_DRAIN_SECRET is not set — board-events-drain refuses to serve an unauthenticated drain.",
    ),
  });
}

/**
 * Where the drain function lives. Derived from the platform-injected `SUPABASE_URL` so an ordinary cloud
 * deploy needs no extra variable; `BOARD_EVENTS_DRAIN_URL` overrides it for a stack whose functions sit
 * behind a different origin.
 */
function boardEventsDrainUrl(env: Record<string, string | undefined>): string | undefined {
  const override = env["BOARD_EVENTS_DRAIN_URL"];
  if (override) {
    return override;
  }
  const base = env["SUPABASE_URL"];
  return base ? new URL("/functions/v1/board-events-drain", base).toString() : undefined;
}

export function createDenoBoardSyncHandler() {
  const env = readDenoEnv();
  return createBoardSyncHandler({
    electricUrl: env["ELECTRIC_SHAPE_URL"] ?? "http://electric:3000/v1/shape",
    resolveAuthClaims: createBoardClaimsResolver({
      supabaseUrl: requireEnv(
        env,
        ["SUPABASE_URL"],
        "SUPABASE_URL is not set — board functions cannot resolve the GoTrue JWKS.",
      ),
      logTimings: true,
    }),
    allowedOrigins: parseAllowedOrigins(env["BOARD_ALLOWED_ORIGINS"]),
  });
}

function readDenoEnv(): Record<string, string | undefined> {
  const runtime = requireDeno();
  return {
    BOARD_ALLOWED_ORIGINS: runtime.env.get("BOARD_ALLOWED_ORIGINS"),
    BOARD_EVENTS_DRAIN_SECRET: runtime.env.get("BOARD_EVENTS_DRAIN_SECRET"),
    BOARD_EVENTS_DRAIN_URL: runtime.env.get("BOARD_EVENTS_DRAIN_URL"),
    ELECTRIC_SHAPE_URL: runtime.env.get("ELECTRIC_SHAPE_URL"),
    SUPABASE_DB_URL: runtime.env.get("SUPABASE_DB_URL"),
    SUPABASE_URL: runtime.env.get("SUPABASE_URL"),
  };
}

function requireDeno(): DenoRuntime {
  if (!deno) {
    throw new Error("Deno runtime is required for this adapter.");
  }

  return deno;
}

import { createBoardClaimsResolver } from "../core/auth";
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

export function createDenoBoardWriteHandler() {
  const env = readDenoEnv();
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
  });
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

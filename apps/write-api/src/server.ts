import { Hono } from "hono";
import { cors } from "hono/cors";

import { demoSyncRegistry } from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";

import { composeCredentials } from "../../../infra/compose-credentials";
import { parseDemoAuthClaimsFromRequest } from "./demo-auth";
import { proxyElectricShapeRequest } from "./electric-proxy";

const databaseUrl = process.env.DATABASE_URL ?? composeCredentials.DEFAULT_DATABASE_URL;
const electricUrl = process.env.ELECTRIC_URL ?? "http://localhost:3000/v1/shape";
const allowedOrigins = ["http://localhost:5173", "http://localhost:5174"];
const backend = readWriteApiBackend(process.env.WRITE_API_BACKEND);
const operationsLogEnabled = readBooleanEnv(process.env.WRITE_API_OPS_LOG_ENABLED, true);
const idleTimeoutSeconds = readPositiveIntEnv(process.env.WRITE_API_IDLE_TIMEOUT_SECONDS, 120);

console.log("Starting write-api...", { databaseUrl, electricUrl, backend, operationsLogEnabled, idleTimeoutSeconds });

const server = createSyncServer({
  registry: demoSyncRegistry,
  databaseUrl,
  backend,
  resolveAuthClaims: (request) => {
    const claims = parseDemoAuthClaimsFromRequest(request);
    return claims ? { ...claims } : null;
  },
  operationsLog: {
    enabled: operationsLogEnabled,
  },
  allowedOrigins,
  port: Number(process.env.WRITE_API_PORT ?? 3001),
  idleTimeoutSeconds,
});

const app = new Hono();

app.use(
  "/v1/*",
  cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.get("/v1/electric-proxy", async (context) => {
  try {
    const claims = parseDemoAuthClaimsFromRequest(context.req.raw);
    return await proxyElectricShapeRequest(context.req.raw, claims, { electricUrl });
  } catch (error) {
    return context.json(
      {
        message: error instanceof Error ? error.message : "Failed to proxy Electric shape request",
      },
      502,
    );
  }
});

app.all("*", (context) => server.fetch(context.req.raw));

export default {
  port: Number(process.env.WRITE_API_PORT ?? 3001),
  idleTimeout: idleTimeoutSeconds,
  fetch: app.fetch,
};

function readWriteApiBackend(rawValue: string | undefined): "bulk-plpgsql-artifact" {
  const value = rawValue ?? "bulk-plpgsql-artifact";

  if (value === "bulk-plpgsql-artifact") {
    return value;
  }

  throw new Error(
    `Invalid WRITE_API_BACKEND=${value}. Only bulk-plpgsql-artifact is supported. Legacy backends have been removed.`,
  );
}

function readBooleanEnv(rawValue: string | undefined, fallback: boolean): boolean {
  if (rawValue === undefined) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();

  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  throw new Error(`Invalid WRITE_API_OPS_LOG_ENABLED=${rawValue}. Expected a boolean value.`);
}

function readPositiveIntEnv(rawValue: string | undefined, fallback: number): number {
  if (rawValue === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error(`Invalid WRITE_API_IDLE_TIMEOUT_SECONDS=${rawValue}. Expected a positive integer.`);
}

import { drizzle } from "drizzle-orm/bun-sql";
import { defineRelations } from "drizzle-orm/relations";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { demoMembershipSyncRegistry } from "@pgxsinkit/schema";
import { buildRegistrySchema, createSyncServer, proxyElectricShapeRequest } from "@pgxsinkit/server";

import { parseDemoAuthClaimsFromRequest } from "./demo-auth";
import { writeApiEnv } from "./env";

const databaseUrl = writeApiEnv.DATABASE_URL;
const electricUrl = writeApiEnv.ELECTRIC_URL;
const allowedOrigins = ["http://localhost:5173", "http://localhost:5174"];
const operationsLogEnabled = writeApiEnv.WRITE_API_OPS_LOG_ENABLED;
const idleTimeoutSeconds = writeApiEnv.WRITE_API_IDLE_TIMEOUT_SECONDS;

console.log("Starting write-api...", { databaseUrl, electricUrl, operationsLogEnabled, idleTimeoutSeconds });

const schema = buildRegistrySchema(demoMembershipSyncRegistry);
const relations = defineRelations(schema);
const db = drizzle({ connection: databaseUrl, relations });

const server = createSyncServer({
  registry: demoMembershipSyncRegistry,
  db,
  resolveAuthClaims: (request) => {
    const claims = parseDemoAuthClaimsFromRequest(request);
    return claims ? { ...claims } : null;
  },
  operationsLog: {
    enabled: operationsLogEnabled,
  },
  allowedOrigins,
  port: writeApiEnv.WRITE_API_PORT,
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
    return await proxyElectricShapeRequest(context.req.raw, claims, {
      registry: demoMembershipSyncRegistry,
      electricUrl,
    });
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
  port: writeApiEnv.WRITE_API_PORT,
  idleTimeout: idleTimeoutSeconds,
  fetch: app.fetch,
};

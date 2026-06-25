import { drizzle } from "drizzle-orm/bun-sql";
import { defineRelations } from "drizzle-orm/relations";

import { demoMembershipSyncRegistry } from "@pgxsinkit/schema";
import { buildRegistrySchema, createSyncServer } from "@pgxsinkit/server";

import { parseDemoAuthClaimsFromRequest } from "./demo-auth";
import { writeApiEnv } from "./env";

const databaseUrl = writeApiEnv.DATABASE_URL;
const electricUrl = writeApiEnv.ELECTRIC_URL;
const allowedOrigins = ["http://localhost:5173", "http://localhost:5174"];
const operationsLogEnabled = writeApiEnv.WRITE_API_OPS_LOG_ENABLED;
const idleTimeoutSeconds = writeApiEnv.WRITE_API_IDLE_TIMEOUT_SECONDS;

// Never log the raw DATABASE_URL — it carries the password. Mask userinfo so the line stays
// useful (host/database visible) without leaking credentials into logs a consumer might ship.
function redactDatabaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) {
      url.password = "***";
    }
    if (url.username) {
      url.username = "***";
    }
    return url.toString();
  } catch {
    return "<unparseable database url>";
  }
}

console.log("Starting write-api...", {
  databaseUrl: redactDatabaseUrl(databaseUrl),
  electricUrl,
  operationsLogEnabled,
  idleTimeoutSeconds,
});

const schema = buildRegistrySchema(demoMembershipSyncRegistry);
const relations = defineRelations(schema);
const db = drizzle({ connection: databaseUrl, relations });

// One server owns both ingress paths: the write route (POST /api/mutations) and the
// read-path Electric shape proxy, both resolving identity through the single
// resolveAuthClaims adapter (ADR-0003). The proxy fails closed on tables absent from
// the registry. The path stays /v1/electric-proxy for client/env compatibility.
const server = createSyncServer({
  registry: demoMembershipSyncRegistry,
  db,
  resolveAuthClaims: (request) => {
    const claims = parseDemoAuthClaimsFromRequest(request);
    return claims ? { ...claims } : null;
  },
  electricUrl,
  shapeProxyPath: "/v1/electric-proxy",
  operationsLog: {
    enabled: operationsLogEnabled,
  },
  allowedOrigins,
  port: writeApiEnv.WRITE_API_PORT,
  idleTimeoutSeconds,
});

export default {
  port: writeApiEnv.WRITE_API_PORT,
  idleTimeout: idleTimeoutSeconds,
  fetch: server.fetch,
};

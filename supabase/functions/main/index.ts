// Local departure from the vendored upstream router: upstream pins deno.land/x/jose@v4.14.4
// (April 2023, predates the jose 4.15.5 security fix for GHSA-hhhv-q57q-mxfw). We load current
// jose via npm: instead — same API surface (createRemoteJWKSet/jwtVerify/decodeProtectedHeader).
import * as jose from "npm:jose@6.2.3";

console.log("main function started");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const VERIFY_JWT = Deno.env.get("VERIFY_JWT") === "true";

// Create the JWKS resolver for the supported ES256/RS256 token algorithms.
let SUPABASE_JWT_KEYS: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
if (SUPABASE_URL) {
  try {
    SUPABASE_JWT_KEYS = jose.createRemoteJWKSet(new URL("/auth/v1/.well-known/jwks.json", SUPABASE_URL));
  } catch (e) {
    console.error("Failed to fetch JWKS from SUPABASE_URL:", e);
  }
}

/**
 * Extract JWT token from Authorization header
 *
 * Parses the Authorization header to extract the Bearer token.
 * Expects format: "Bearer <token>"
 *
 * @param req - The HTTP request object
 * @returns The JWT token string
 * @throws Error if Authorization header is missing or malformed
 */
function getAuthToken(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    throw new Error("Missing authorization header");
  }
  const [bearer, token] = authHeader.split(" ");
  if (bearer !== "Bearer") {
    throw new Error(`Auth header is not 'Bearer {token}'`);
  }
  return token;
}

async function isValidJWT(jwt: string): Promise<boolean> {
  if (!SUPABASE_JWT_KEYS) {
    console.error("JWKS not available for ES256/RS256 token verification");
    return false;
  }

  try {
    await jose.jwtVerify(jwt, SUPABASE_JWT_KEYS, { algorithms: ["ES256", "RS256"] });
  } catch (e) {
    console.error("Asymmetric JWT verification error", e);
    return false;
  }

  return true;
}

/**
 * Verify a JWT token against the project's asymmetric JWKS.
 *
 * @param jwt - The JWT token string to verify
 * @returns Promise resolving to true if verification succeeds, false otherwise
 */
Deno.serve(async (req: Request) => {
  if (req.method !== "OPTIONS" && VERIFY_JWT) {
    try {
      const token = getAuthToken(req);
      const valid = await isValidJWT(token);

      if (!valid) {
        return new Response(JSON.stringify({ msg: "Invalid JWT" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch (e) {
      console.error(e);
      return new Response(JSON.stringify({ msg: e.toString() }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const url = new URL(req.url);
  const { pathname } = url;
  const path_parts = pathname.split("/");
  const service_name = path_parts[1];

  if (!service_name || service_name === "") {
    const error = { msg: "missing function name in request" };
    return new Response(JSON.stringify(error), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const servicePath = `/home/deno/functions/${service_name}`;
  console.error(`serving the request with ${servicePath}`);

  const memoryLimitMb = 150;
  // Per-worker wall-clock budget. The board overrides this (EDGE_WORKER_TIMEOUT_MS) because the
  // board-sync proxy holds Electric long-polls open continuously: at the stock 60s a long-poll worker
  // accumulates wall-clock and is recycled mid-cycle (the "early termination" log + a read-path
  // reconnect) about once a minute. A larger budget makes that churn rare. Unset → stock 60s.
  const workerTimeoutMs = Number(Deno.env.get("EDGE_WORKER_TIMEOUT_MS")) || 1 * 60 * 1000;
  const noModuleCache = false;
  const importMapPath = null;
  const envVarsObj = Deno.env.toObject();
  const envVars = Object.keys(envVarsObj).map((k) => [k, envVarsObj[k]]);

  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb,
      workerTimeoutMs,
      noModuleCache,
      importMapPath,
      envVars,
    });
    return await worker.fetch(req);
  } catch (e) {
    const error = { msg: e.toString() };
    return new Response(JSON.stringify(error), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

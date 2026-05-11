import { demoJwtHasRole, type DemoJwtClaims } from "@pgxsinkit/schema";

const protectedTables = new Set(["authors", "todos"]);

export interface ElectricProxyOptions {
  electricUrl: string;
}

export async function proxyElectricShapeRequest(
  request: Request,
  claims: DemoJwtClaims | null,
  options: ElectricProxyOptions,
) {
  const targetUrl = buildProxyTargetUrl(request, claims, options.electricUrl);

  const response = await fetch(targetUrl, {
    method: "GET",
    signal: request.signal,
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}

function buildProxyTargetUrl(request: Request, claims: DemoJwtClaims | null, electricUrl: string): string {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(electricUrl);

  // Merge incoming request params into the electric URL, preserving
  // any pre-existing params (e.g. secret API token from electricUrl).
  requestUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  const table = targetUrl.searchParams.get("table");

  if (!table || !protectedTables.has(table)) {
    return targetUrl.toString();
  }

  if (claims && demoJwtHasRole(claims, "admin")) {
    return targetUrl.toString();
  }

  const ownershipFilter = claims?.sub ? `owner_id = '${escapeSqlLiteral(claims.sub)}'` : "1 = 0";
  const existingWhere = targetUrl.searchParams.get("where");

  if (!existingWhere) {
    targetUrl.searchParams.set("where", ownershipFilter);
    return targetUrl.toString();
  }

  targetUrl.searchParams.set("where", `(${existingWhere}) AND (${ownershipFilter})`);
  return targetUrl.toString();
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

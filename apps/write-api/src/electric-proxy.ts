import { demoJwtHasRole, type DemoJwtClaims } from "@pgxsinkit/demo";

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
    headers: buildForwardHeaders(request.headers),
    signal: request.signal,
  });

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("Vary", appendVaryHeader(headers.get("Vary"), "Authorization"));

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function buildProxyTargetUrl(request: Request, claims: DemoJwtClaims | null, electricUrl: string): string {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(electricUrl);

  targetUrl.search = requestUrl.search;

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

function buildForwardHeaders(headers: Headers): Headers {
  const next = new Headers();

  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();

    if (lower === "host" || lower === "authorization") {
      continue;
    }

    next.set(name, value);
  }

  return next;
}

function appendVaryHeader(existingValue: string | null, nextValue: string): string {
  if (!existingValue) {
    return nextValue;
  }

  const values = existingValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (values.includes(nextValue)) {
    return values.join(", ");
  }

  values.push(nextValue);
  return values.join(", ");
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

// Supabase Edge Functions route by a leading path segment: a request to
// `/functions/v1/board-write/mutations` arrives at the worker as `/board-write/mutations`. The
// toolkit's mutation route is registered at `/mutations` (and `/api/mutations`), with no knowledge of
// the deployment name, so the function name has to be stripped before handing the request to the
// `createSyncServer` fetch handler — exactly what a reverse proxy in front of the server would do.
//
// (The read proxy needs no rewrite: `proxyElectricShapeRequest` keys off the query string, not the
// path. The asymmetry is why only the write function uses this.)

/** Returns a copy of `request` with a leading `/<name>` path segment removed (no-op if absent). */
export function stripFunctionPrefix(request: Request, name: string): Request {
  const url = new URL(request.url);
  const prefix = `/${name}`;
  if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
    url.pathname = url.pathname.slice(prefix.length) || "/";
  }
  return new Request(url.toString(), request);
}

/**
 * The mutation route lives at `/mutations`. The board client posts to the bare function URL
 * (`/functions/v1/board-write`), which arrives as `/board-write` — so after stripping the name the
 * path is `/`, which matches nothing. Rewrite that bare path to `/mutations`; leave any explicit
 * sub-path (already stripped) untouched.
 */
export function routeToMutations(request: Request, name: string): Request {
  const stripped = stripFunctionPrefix(request, name);
  const url = new URL(stripped.url);
  if (url.pathname === "/" && request.method !== "OPTIONS") {
    url.pathname = "/mutations";
    return new Request(url.toString(), stripped);
  }
  return stripped;
}

/**
 * Resolve which origin (if any) a response's CORS headers should allow for this request.
 *
 * Entries are exact scheme+host[+port] strings (`https://app.example.com`, `http://localhost:5660`),
 * plus one special form: a literal `"*"` entry allows EVERY origin by reflecting the request's
 * `Origin` header back — never a literal `*` header value, which the Fetch spec rejects for
 * credentialed requests (the toolkit's requests carry `Authorization`). Reflection is sound here
 * because auth is a per-request bearer token, not ambient cookies: a hostile page cannot mint the
 * header, so the origin list is deployment hygiene rather than the security boundary. Use `"*"` for
 * dev/demo backends serving many local origins; enumerate exact origins for production.
 *
 * Returns `null` when the request has no `Origin` or it is not allowed — callers then omit CORS
 * headers entirely, and the browser blocks the read.
 */
export function resolveCorsOrigin(request: Request, origins: readonly string[]): string | null {
  const origin = request.headers.get("origin");
  if (!origin) {
    return null;
  }
  return origins.includes("*") || origins.includes(origin) ? origin : null;
}

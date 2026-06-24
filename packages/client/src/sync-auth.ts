import type { ExternalHeadersRecord } from "@electric-sql/client";

/**
 * Read-path identity (ADR-0013). The two ingress points must share **one** token lifecycle: the
 * write path already calls `getAuthToken` fresh on every flush, so the read path must too — never
 * freezing a JWT at boot, which wedges a long-lived offline-first session the instant the token
 * expires.
 *
 * `buildAuthShapeHeaders` returns the read-path `Authorization` header as an **async function**.
 * Electric resolves header-value functions on every request *and every retry*
 * (`ExternalHeadersRecord` allows `string | (() => string | Promise<string>)`), so each shape fetch
 * presents a fresh token. This is the client mirror of ADR-0003's server-side one-identity decision.
 *
 * The provider contract (documented in `docs/architecture.md`): `getAuthToken` is now called per
 * request by both paths and **must be refresh-deduping** — return the cached valid token and refresh
 * single-flight, so an N-shape consistency group does not trigger N refreshes.
 */
export function buildAuthShapeHeaders(getAuthToken: () => Promise<string | undefined>): ExternalHeadersRecord {
  return {
    // Resolved per request: a fresh token each time, never one captured at boot. An absent token
    // yields an empty value (unauthenticated) rather than the literal string `Bearer undefined`.
    Authorization: async () => {
      const token = await getAuthToken();
      return token ? `Bearer ${token}` : "";
    },
  };
}

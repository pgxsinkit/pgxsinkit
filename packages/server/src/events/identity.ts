import type { EventStreamIdentityField, JwtClaims } from "@pgxsinkit/contracts";

/**
 * Identity stamping (ADR-0053 decisions 1 and 5): resolve an Event stream's declared identity fields against
 * the **verified** claims of the ingesting request.
 *
 * This is the security-sensitive step of the lane — the point where a client-supplied event becomes an
 * attributed fact. The client's envelope carries no identity at all, so everything the consumer callback sees
 * under `identity` comes from here, and only from claims the server itself verified.
 */

/** A resolved stamp, or the first field that could not be resolved (which makes the event `rejected`). */
export type IdentityResolution =
  | { ok: true; identity: Record<string, string> }
  | { ok: false; field: string; claimPath: readonly string[]; detail: string };

/**
 * Walk a claim path the way the managed-field `authClaim` strategy does (`ManagedFieldSpec.claimPath`), so
 * the toolkit's two claim-stamping surfaces address claims identically: each segment is a plain key into a
 * plain object, `["sub"]` for the auth subject, `["app_metadata", "person_id"]` for an app-minted identity.
 *
 * Arrays are NOT indexed (the SQL twin's `#>> '{a,b}'` would, but an identity addressed by array position is
 * not a shape the registry validates or the toolkit wants to encourage), and the walk stops at the first
 * segment that is not a plain object.
 */
function readClaimAtPath(claims: JwtClaims, claimPath: readonly string[]): unknown {
  let current: unknown = claims;
  for (const segment of claimPath) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Coerce a resolved claim to the stamped string value, or `null` when it is not stampable.
 *
 * A JSON scalar (number/boolean) is coerced to its text form deliberately: that is exactly what the SQL twin
 * (`current_setting('request.jwt.claims')::jsonb #>> '{…}'`) does for a managed `authClaim` field, so an
 * issuer that mints `person_id` as a JSON number stamps the same value on both surfaces. Anything else —
 * absent, null, an object, an array, or an empty/whitespace string — is NOT stampable: an empty identity must
 * never be stamped silently.
 */
function toStampedValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/**
 * Resolve every declared identity field, or report the FIRST unresolvable one. Fail-closed by construction:
 * there is no partial stamp and no empty-string fallback — an event whose identity cannot be resolved gets a
 * `rejected` verdict naming the field and its claim path.
 */
export function resolveEventIdentity(
  claims: JwtClaims,
  identityFields: Record<string, EventStreamIdentityField>,
): IdentityResolution {
  const identity: Record<string, string> = {};

  for (const [field, spec] of Object.entries(identityFields)) {
    const claimPath = spec.claimPath;
    const raw = readClaimAtPath(claims, claimPath);
    const stamped = toStampedValue(raw);
    if (stamped === null) {
      return {
        ok: false,
        field,
        claimPath,
        detail: raw === undefined ? "the claim is absent" : `the claim is not a stampable scalar (${typeof raw})`,
      };
    }
    identity[field] = stamped;
  }

  return { ok: true, identity };
}

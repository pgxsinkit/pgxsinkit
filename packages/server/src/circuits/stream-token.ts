import type { PredicateValue } from "@pgxsinkit/contracts";

/**
 * One stream a token admits its bearer to.
 *
 * The grant is **self-describing**: it carries the durable-streams path together with the shape and
 * scope that path serves. That is what keeps the edge stateless. Shape creation happened on whichever
 * replica the client reached, and the edge is replica-scaled, so a path→scope map held in memory
 * would have to be shared between replicas — a second piece of distributed state on the read path,
 * to answer a question the token can simply carry.
 */
export interface StreamGrant {
  /** The durable-streams path, e.g. `shape/s1`. */
  path: string;
  /** The shape this path serves — the entitlement rule's binding key. */
  shapeKey: string;
  /**
   * The engine claim this grant acquired — one `POST /shapes` join — so the session that holds it can
   * release exactly what it acquired.
   *
   * Carried rather than looked up, for the same reason the path and scope are: the release route is
   * stateless, and the signed token is the only proof of what the control plane handed out. It is not
   * the same thing as {@link StreamGrant.path}: the engine's own id is what `DELETE /shapes/{id}`
   * takes, and two grants can legitimately name ONE shapeId when the engine deduplicated two
   * identical definitions (ADR-0055 decision 6) — which is precisely why release counts grants, not
   * distinct ids.
   */
  shapeId: string;
  /**
   * Scope values, positionally matching the shape's declared scope columns. Shared tier only; a
   * private-tier grant has none, and its authorization is the token itself.
   */
  scope?: readonly PredicateValue[];
  /**
   * PRIVATE TIER ONLY: the fingerprint of the compiled shape request this grant authorized.
   *
   * A re-mint recompiles the shape with the subject's CURRENT claims and admits the grant only if the
   * result fingerprints the same; a grant without one cannot be re-authorized and is revoked. That is
   * what keeps the re-mint stateless — the token carries the thing that was authorized, so nothing
   * server-side has to remember it.
   *
   * Shared-tier grants carry none, and deliberately: their predicate is generated from the scope
   * values alone, so it cannot drift with the subject's claims and the live entitlement re-check is
   * the whole question.
   */
  fp?: string;
}

/** The verified body of a stream token. */
export interface StreamTokenClaims {
  /** The subject the token was minted for. */
  sub: string;
  grants: StreamGrant[];
  /** Issued-at and expiry, seconds since the epoch. */
  iat: number;
  exp: number;
}

export interface MintStreamTokenOptions {
  sub: string;
  grants: readonly StreamGrant[];
  /**
   * Lifetime in seconds. The ADR-0055 default is 5 minutes, which is also the revocation bound when
   * a hit-serving third-party CDN sits in front: shorten it where that bound matters more than the
   * re-mint traffic, lengthen it where it does not.
   */
  ttlSeconds?: number;
  /** Seconds since the epoch. Injected so minting is testable and so a batch shares one issue time. */
  now: number;
}

export const DEFAULT_STREAM_TOKEN_TTL_SECONDS = 300;

export type StreamTokenVerification = { ok: true; claims: StreamTokenClaims } | { ok: false; reason: string };

/**
 * The signing key. HMAC-SHA256 over a compact JWS: the same process mints and verifies, so there is
 * one trust domain and no reason to pay for asymmetric keys — and no reason to take a JWT dependency
 * into a published library for what Web Crypto already does.
 *
 * The token still IS a JWT, so it stays readable by ordinary tooling when someone has to debug one.
 */
export async function importStreamTokenKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const HEADER = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));

/**
 * Mint one token for a whole batch of grants.
 *
 * Batched by design, not as an optimisation: a subject in K scopes holds K subscriptions, and
 * re-minting per subscription would put K requests on every TTL boundary for every subject. One
 * token covering all K collapses that to one request per subject per window.
 */
export async function mintStreamToken(key: CryptoKey, options: MintStreamTokenOptions): Promise<string> {
  const ttl = options.ttlSeconds ?? DEFAULT_STREAM_TOKEN_TTL_SECONDS;
  const claims: StreamTokenClaims = {
    sub: options.sub,
    grants: options.grants.map((grant) => ({
      path: grant.path,
      shapeKey: grant.shapeKey,
      shapeId: grant.shapeId,
      ...(grant.scope !== undefined ? { scope: [...grant.scope] } : {}),
      ...(grant.fp !== undefined ? { fp: grant.fp } : {}),
    })),
    iat: options.now,
    exp: options.now + ttl,
  };

  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${HEADER}.${body}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify a token and read its grants back.
 *
 * `now` is the request-start time, and is passed rather than read here so that a long-poll held open
 * across the expiry is judged by when it started — the alternative silently kills connections
 * mid-flight at the TTL boundary, which presents as a stall rather than as the re-auth it is.
 *
 * Signature verification goes through `crypto.subtle.verify`, so the comparison is the platform's
 * constant-time one rather than a string equality that leaks by how early it diverges.
 */
export interface VerifyStreamTokenOptions {
  /**
   * Accept a token past its expiry, for the **re-mint path only**.
   *
   * The signature is still verified, so the grants are still ones this control plane issued — that is
   * the whole claim being relied on. Expiry bounds how long a grant keeps *working*, and the re-mint
   * re-authorizes every grant before re-signing — the shared tier against the live entitlement set,
   * the private tier by recompiling its shape against the subject's current claims — so an expired
   * token buys its bearer nothing on its own. Never set this on a read.
   */
  allowExpired?: boolean;
}

export async function verifyStreamToken(
  key: CryptoKey,
  token: string,
  now: number,
  options?: VerifyStreamTokenOptions,
): Promise<StreamTokenVerification> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [header, body, signature] = parts as [string, string, string];
  if (header !== HEADER) return { ok: false, reason: "unexpected token header" };

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(signature),
      new TextEncoder().encode(`${header}.${body}`),
    );
  } catch {
    return { ok: false, reason: "malformed signature" };
  }
  if (!valid) return { ok: false, reason: "bad signature" };

  let claims: StreamTokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as StreamTokenClaims;
  } catch {
    return { ok: false, reason: "malformed payload" };
  }
  if (typeof claims.sub !== "string" || !Array.isArray(claims.grants) || typeof claims.exp !== "number") {
    return { ok: false, reason: "malformed payload" };
  }
  if (claims.exp <= now && options?.allowExpired !== true) return { ok: false, reason: "expired" };

  return { ok: true, claims };
}

/**
 * The grant covering a requested stream path, if the token carries one.
 *
 * Exact path match, deliberately: durable-streams paths are a monotonic counter (`shape/s1`,
 * `shape/s2`, …), so they are enumerable rather than capability-bearing, and any prefix or pattern
 * match over them would hand the bearer streams the control plane never granted.
 */
export function findGrant(claims: StreamTokenClaims, path: string): StreamGrant | undefined {
  return claims.grants.find((grant) => grant.path === path);
}

import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { DEMO_AUTH_SECRET, type DemoJwtClaims } from "@pgxsinkit/schema";

const bearerPrefix = /^Bearer\s+/i;

const jwtHeaderSchema = z
  .object({
    alg: z.literal("HS256"),
    typ: z.literal("JWT").optional(),
  })
  .strict();

const jwtClaimsSchema = z
  .object({
    sub: z.uuid(),
    role: z.literal("authenticated"),
    email: z.email(),
    aud: z.string().trim().min(1),
    iat: z.number().int(),
    app_metadata: z
      .object({
        roles: z.array(z.enum(["student", "admin"])),
      })
      .strict(),
  })
  .strict();

export function parseBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");

  if (!authorization) {
    return null;
  }

  return authorization.replace(bearerPrefix, "").trim() || null;
}

export function parseDemoAuthClaimsFromRequest(request: Request): DemoJwtClaims | null {
  const token = parseBearerToken(request);

  if (!token) {
    return null;
  }

  return verifyDemoJwt(token);
}

export function verifyDemoJwt(
  token: string,
  secret = process.env.DEMO_JWT_SECRET ?? DEMO_AUTH_SECRET,
): DemoJwtClaims | null {
  const parts = token.split(".");

  if (parts.length !== 3) {
    return null;
  }

  const [headerPart, payloadPart, signaturePart] = parts;

  if (!headerPart || !payloadPart || !signaturePart) {
    return null;
  }

  const encodedMessage = `${headerPart}.${payloadPart}`;
  const expectedSignature = base64UrlEncode(createHmac("sha256", secret).update(encodedMessage).digest());

  if (!timingSafeEqualStrings(expectedSignature, signaturePart)) {
    return null;
  }

  try {
    const header = JSON.parse(base64UrlDecodeToString(headerPart)) as unknown;
    jwtHeaderSchema.parse(header);

    const payload = JSON.parse(base64UrlDecodeToString(payloadPart)) as unknown;
    return jwtClaimsSchema.parse(payload);
  } catch {
    return null;
  }
}

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64url");
}

function base64UrlDecodeToString(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

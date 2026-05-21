/**
 * Stateless signed URL tokens for the player.
 *
 * Why HMAC instead of JWT or a session table?
 *  - The bot and the player are deployed independently. They share a secret
 *    via env (STREAM_SECRET); no database or auth backend needed.
 *  - Tokens encode the video URL + optional referer + expiry. If anyone tampers,
 *    the signature fails and the proxy refuses.
 *
 * Token format (URL-safe):
 *   sig.exp
 * where:
 *   sig = base64url(hmac-sha256(secret, "u=<u>&r=<r>&e=<exp>"))
 *   exp = unix seconds the link is valid until
 *
 * Both fields ride alongside the existing `url` and `ref` query params; we
 * don't smuggle them into one opaque blob, because that would force the bot
 * to URL-encode a JSON payload (uglier links and harder debugging).
 */

const ENCODER = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, ENCODER.encode(payload));
  return new Uint8Array(sig);
}

export interface SignedParams {
  url: string;
  ref?: string | null;
  exp: number; // unix seconds
}

export async function signParams(
  secret: string,
  params: SignedParams
): Promise<string> {
  const payload = canonicalPayload(params);
  const sig = await hmacSha256(secret, payload);
  return base64UrlEncode(sig);
}

export async function verifyParams(
  secret: string,
  params: SignedParams,
  providedSig: string
): Promise<boolean> {
  // Reject expired links up front (cheaper than the HMAC compute).
  if (!Number.isFinite(params.exp) || params.exp < nowSeconds()) {
    return false;
  }

  const expected = await signParams(secret, params);

  // Constant-time compare to avoid timing side channels.
  if (expected.length !== providedSig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ providedSig.charCodeAt(i);
  }
  return diff === 0;
}

function canonicalPayload({ url, ref, exp }: SignedParams): string {
  // Order matters; both signer and verifier must agree.
  return `u=${url}&r=${ref ?? ""}&e=${exp}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

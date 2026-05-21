import { NextRequest } from "next/server";
import { verifyParams } from "@/app/lib/sign";

// Node runtime so we can stream large bodies without timeout pressure.
// Edge runtime would be faster startup, but Vercel caps Edge response size.
export const runtime = "nodejs";
export const preferredRegion = ["sin1", "hkg1", "icn1"];
export const maxDuration = 300;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Streaming proxy for hotlink-protected videos.
 *
 * The Telegram bot signs (url + ref + exp) with STREAM_SECRET and embeds the
 * signature in the link. We verify here so this endpoint can't be used as a
 * free open proxy by random visitors — only links the bot generated work,
 * and only until they expire.
 *
 * Two response shapes:
 *   1. Direct media (mp4, webm, etc) → upstream body is piped 1:1 with Range
 *      forwarding so seek/scrub works.
 *   2. HLS manifest (m3u8) → text body is rewritten so every nested URL
 *      (segments, sub-playlists, encryption keys) routes back through this
 *      proxy. Otherwise the browser would request segments directly from the
 *      upstream CDN with no Referer, and they'd fail.
 *
 * Usage: /api/stream?url=<video>&ref=<source>&exp=<unix>&sig=<hmac>
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const videoUrl = searchParams.get("url");
  const ref = searchParams.get("ref");
  const expStr = searchParams.get("exp");
  const sig = searchParams.get("sig");
  const downloadMode = searchParams.get("download") === "1";

  if (!videoUrl) return badRequest("Missing url");
  if (!expStr || !sig) return forbidden("Missing signature");

  const exp = Number(expStr);
  const secret = process.env.STREAM_SECRET;
  if (!secret) {
    console.error("[stream] STREAM_SECRET env not set");
    return new Response("Server misconfigured", { status: 500 });
  }

  const valid = await verifyParams(secret, { url: videoUrl, ref, exp }, sig);
  if (!valid) return forbidden("Invalid or expired signature");

  let target: URL;
  try {
    target = new URL(videoUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return badRequest("Invalid protocol");
    }
  } catch {
    return badRequest("Invalid url");
  }

  // Fall back to the video's own origin if no Referer was provided.
  const referer = ref ? safeOrigin(ref) : `${target.origin}/`;

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Referer: referer,
    Origin: referer.replace(/\/$/, ""),
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const range = req.headers.get("range");
  if (range) headers["Range"] = range;

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), { headers, redirect: "follow" });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "fetch failed";
    return new Response(`Upstream fetch failed: ${message}`, { status: 502 });
  }

  if (!upstream.ok && upstream.status !== 206) {
    return new Response(
      `Upstream returned ${upstream.status} ${upstream.statusText}`,
      { status: upstream.status }
    );
  }

  const contentType = upstream.headers.get("content-type") || "";
  const isHls =
    /\.m3u8(\?|$)/i.test(target.pathname + target.search) ||
    /application\/(vnd\.apple\.)?(mpegurl|x-mpegurl)/i.test(contentType);

  if (isHls) {
    // download flag is meaningless for a playlist file; ignore it.
    return rewriteHlsManifest(upstream, target, ref, exp, sig, secret);
  }

  return passThrough(upstream, downloadMode ? deriveFilename(target) : null);
}

// ---------------------------------------------------------------------------

function passThrough(upstream: Response, downloadFilename: string | null): Response {
  const responseHeaders = new Headers();
  const passthrough = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "last-modified",
    "etag",
    "cache-control",
  ];
  for (const key of passthrough) {
    const value = upstream.headers.get(key);
    if (value) responseHeaders.set(key, value);
  }
  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "application/octet-stream");
  }
  if (!responseHeaders.has("accept-ranges")) {
    responseHeaders.set("accept-ranges", "bytes");
  }
  // Player on a different deployment URL needs CORS to consume Range responses.
  responseHeaders.set("access-control-allow-origin", "*");
  responseHeaders.set("access-control-expose-headers", "content-length,content-range");

  if (downloadFilename) {
    // RFC 5987 encoding handles non-ASCII characters; quote the ASCII fallback.
    const ascii = downloadFilename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
    const utf8 = encodeURIComponent(downloadFilename);
    responseHeaders.set(
      "content-disposition",
      `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

/**
 * Derive a friendly download filename from the upstream URL. Falls back to
 * "video.mp4" when the path contains nothing usable.
 */
function deriveFilename(target: URL): string {
  const last = target.pathname.split("/").filter(Boolean).pop() ?? "";
  const candidate = decodeURIComponent(last).split("?")[0];
  if (candidate && /\.[a-z0-9]{2,5}$/i.test(candidate)) {
    return candidate;
  }
  return "video.mp4";
}

/**
 * For HLS, every segment URL in the manifest must come back through us so the
 * Referer is preserved on each fetch. We re-sign each child URL with the SAME
 * exp/sig pair the parent used — a small abuse vector trade-off (one valid
 * playback session = many segment requests) versus the alternative of signing
 * every child individually, which would explode the manifest size.
 *
 * Actually, signatures are bound to the URL, so reusing the parent sig won't
 * verify against child URLs. We need to mint fresh signatures per child. Doing
 * that requires a sign function in the verifier module.
 */
async function rewriteHlsManifest(
  upstream: Response,
  manifestUrl: URL,
  ref: string | null,
  exp: number,
  _parentSig: string,
  secret: string
): Promise<Response> {
  const text = await upstream.text();
  const { signParams } = await import("@/app/lib/sign");

  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (line.length === 0 || line.startsWith("#")) {
      // Tags can also embed URIs (e.g. EXT-X-KEY:URI="...", EXT-X-MAP:URI="...").
      const rewritten = await rewriteTagUris(raw, manifestUrl, ref, exp, secret, signParams);
      out.push(rewritten);
      continue;
    }

    // Plain URI line (segment or variant playlist).
    const absolute = resolveUri(line, manifestUrl);
    out.push(await proxyUriFor(absolute, ref, exp, secret, signParams));
  }

  const headers = new Headers();
  headers.set("content-type", "application/vnd.apple.mpegurl");
  headers.set("cache-control", "no-store");
  headers.set("access-control-allow-origin", "*");

  return new Response(out.join("\n"), { status: 200, headers });
}

async function rewriteTagUris(
  raw: string,
  manifestUrl: URL,
  ref: string | null,
  exp: number,
  secret: string,
  signParams: typeof import("@/app/lib/sign").signParams
): Promise<string> {
  // Match URI="..." attributes and rewrite the inner URI.
  const uriPattern = /URI="([^"]+)"/g;
  let match: RegExpExecArray | null;
  let result = raw;
  const replacements: Array<{ from: string; to: string }> = [];

  while ((match = uriPattern.exec(raw)) !== null) {
    const original = match[1];
    const absolute = resolveUri(original, manifestUrl);
    const proxied = await proxyUriFor(absolute, ref, exp, secret, signParams);
    replacements.push({ from: match[0], to: `URI="${proxied}"` });
  }

  for (const { from, to } of replacements) {
    result = result.replace(from, to);
  }
  return result;
}

async function proxyUriFor(
  absolute: string,
  ref: string | null,
  exp: number,
  secret: string,
  signParams: typeof import("@/app/lib/sign").signParams
): Promise<string> {
  const sig = await signParams(secret, { url: absolute, ref, exp });
  const params = new URLSearchParams({
    url: absolute,
    exp: String(exp),
    sig,
  });
  if (ref) params.set("ref", ref);
  return `/api/stream?${params.toString()}`;
}

function resolveUri(raw: string, base: URL): string {
  try {
    return new URL(raw, base).toString();
  } catch {
    return raw;
  }
}

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin + "/";
  } catch {
    return value;
  }
}

function badRequest(msg: string) {
  return new Response(msg, { status: 400 });
}

function forbidden(msg: string) {
  return new Response(msg, { status: 403 });
}

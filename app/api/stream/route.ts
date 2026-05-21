import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const preferredRegion = ["sin1", "hkg1", "icn1"];
export const maxDuration = 300;

/**
 * Streaming proxy for hotlink-protected videos.
 *
 * Many video hosts check the Referer header and reject direct requests from
 * other origins. This endpoint fetches the video server-side with the correct
 * Referer (the original source page), then pipes the response back to the
 * browser. Range requests are forwarded for seek support.
 *
 * Usage: /api/stream?url=<video_url>&ref=<source_page_url>
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const videoUrl = searchParams.get("url");
  const ref = searchParams.get("ref");

  if (!videoUrl) {
    return new Response("Missing url parameter", { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(videoUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return new Response("Invalid protocol", { status: 400 });
    }
  } catch {
    return new Response("Invalid url", { status: 400 });
  }

  // Use ref origin as the Referer; fall back to the video's own origin
  let referer = target.origin + "/";
  if (ref) {
    try {
      referer = new URL(ref).origin + "/";
    } catch {}
  }

  // Forward Range header for video seeking
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: referer,
    Origin: referer.replace(/\/$/, ""),
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const range = req.headers.get("range");
  if (range) headers["Range"] = range;

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), { headers });
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

  // Forward the response headers needed for video playback
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

  // Default content type if upstream didn't provide one
  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "video/mp4");
  }
  if (!responseHeaders.has("accept-ranges")) {
    responseHeaders.set("accept-ranges", "bytes");
  }

  // Allow the video element to read the stream from any origin
  responseHeaders.set("access-control-allow-origin", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

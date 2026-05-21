"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  videoUrl: string;
  referer: string | null;
  exp: number;
  sig: string;
  direct: boolean;
}

/**
 * Picks the right source URL and playback strategy:
 *
 *  - Direct (no Referer needed): browser fetches the upstream URL itself.
 *    Saves bandwidth on Vercel and gives the lowest latency.
 *
 *  - Proxied (Referer required): point at /api/stream which signs the request
 *    upstream with the right header. For HLS, the manifest is rewritten so
 *    every segment also lands here.
 *
 *  - HLS in non-Safari browsers: native <video> can't parse .m3u8 on Chrome,
 *    Firefox, or Edge. We lazy-load hls.js and attach it to the element.
 */
export default function PlayerClient({
  videoUrl,
  referer,
  exp,
  sig,
  direct,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const src = buildSrc({ videoUrl, referer, exp, sig, direct });
  const isHls = looksLikeHls(videoUrl);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cleanup = () => {};

    // Native HLS works on Safari (desktop + iOS). Chrome/Firefox need hls.js.
    const canPlayHlsNatively =
      video.canPlayType("application/vnd.apple.mpegurl") !== "" ||
      video.canPlayType("application/x-mpegURL") !== "";

    if (isHls && !canPlayHlsNatively) {
      let cancelled = false;
      (async () => {
        try {
          const { default: Hls } = await import("hls.js");
          if (cancelled) return;

          if (!Hls.isSupported()) {
            setError("HLS playback not supported in this browser.");
            return;
          }

          const hls = new Hls({
            // Keep buffers modest so mobile browsers don't OOM on long videos.
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
          });
          hls.loadSource(src);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              setError(`Playback failed: ${data.details}`);
            }
          });

          cleanup = () => {
            hls.destroy();
          };
          setReady(true);
        } catch (e) {
          const message = e instanceof Error ? e.message : "unknown";
          setError(`Failed to load HLS engine: ${message}`);
        }
      })();
      return () => {
        cancelled = true;
        cleanup();
      };
    }

    // Native path: just set the src.
    video.src = src;
    setReady(true);
    return () => {
      video.removeAttribute("src");
      video.load();
    };
    // We intentionally exclude `src` from deps and recompute via primitives so
    // a brand-new src triggers re-attach without stale closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl, referer, exp, sig, direct, isHls]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-3 py-4 sm:px-6 sm:py-8">
      <div className="mb-4 flex items-center justify-between">
        <a
          href="/"
          className="inline-flex items-center gap-2 text-sm text-fg-muted transition-colors hover:text-white"
        >
          <span aria-hidden>←</span> Doomsday
        </a>

        <ExpiryBadge exp={exp} />
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)]">
        <video
          ref={videoRef}
          controls
          autoPlay
          playsInline
          // crossOrigin disabled on purpose: we serve same-origin via /api/stream
          // and direct upstreams may not have CORS, which would break playback.
          className="block w-full bg-black"
          style={{ aspectRatio: "16 / 9" }}
        />
        {!ready && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="size-10 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      <details className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-fg-muted">
        <summary className="cursor-pointer select-none text-white">
          Source details
        </summary>
        <div className="mt-3 space-y-1 break-all">
          <Row label="Video">{videoUrl}</Row>
          {referer && <Row label="Referer">{referer}</Row>}
          <Row label="Mode">
            {direct ? "Direct (no proxy)" : "Proxied via /api/stream"}
          </Row>
          <Row label="Format">{isHls ? "HLS (.m3u8)" : "Direct stream"}</Row>
        </div>
      </details>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <span className="w-20 shrink-0 text-xs uppercase tracking-wider text-fg-muted/70">
        {label}
      </span>
      <span className="font-mono text-xs text-white/80">{children}</span>
    </div>
  );
}

function ExpiryBadge({ exp }: { exp: number }) {
  const remaining = Math.max(0, exp - Math.floor(Date.now() / 1000));
  const expired = remaining <= 0;
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);

  return (
    <span
      className={`rounded-full border px-3 py-1 text-xs ${
        expired
          ? "border-red-500/30 bg-red-500/10 text-red-300"
          : "border-white/10 bg-white/5 text-fg-muted"
      }`}
    >
      {expired
        ? "Link expired"
        : `Expires in ${hours > 0 ? `${hours}h ` : ""}${minutes}m`}
    </span>
  );
}

function buildSrc({
  videoUrl,
  referer,
  exp,
  sig,
  direct,
}: Props): string {
  if (direct) return videoUrl;
  const params = new URLSearchParams({
    url: videoUrl,
    exp: String(exp),
    sig,
  });
  if (referer) params.set("ref", referer);
  return `/api/stream?${params.toString()}`;
}

function looksLikeHls(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\.m3u8(\?|$)/i.test(parsed.pathname + parsed.search);
  } catch {
    return /\.m3u8(\?|$)/i.test(url);
  }
}

import { NextResponse } from "next/server";

// Run in Singapore (closest Vercel region to Indonesian video hosts).
// Many SEA hosts geo-block US datacenter IPs, so US regions return blank pages.
export const runtime = "nodejs";
export const preferredRegion = ["sin1", "hkg1", "icn1"];
export const maxDuration = 60;

/**
 * Resolves a potentially relative URL against a base URL.
 */
function resolveUrl(src: string, base: URL): string {
  if (src.startsWith("http://") || src.startsWith("https://")) return src;
  if (src.startsWith("//")) return base.protocol + src;
  if (src.startsWith("/")) return base.origin + src;
  return base.origin + "/" + src;
}

/**
 * Static HTML extraction. Fetches a page, parses video/source/iframe tags,
 * resolves JavaScript variable concatenation in iframe URLs, and recursively
 * follows iframe chains until a direct video URL is found.
 *
 * No browser needed — bypasses ad scripts and anti-bot detection entirely.
 */
async function extractVideosFromHTML(
  pageUrl: string,
  depth = 0,
  referer?: string
): Promise<string[]> {
  if (depth > 3) return []; // Max 3 levels of iframe nesting

  const videos: string[] = [];
  const baseUrl = new URL(pageUrl);

  try {
    const response = await fetch(pageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: referer || baseUrl.origin + "/",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": depth === 0 ? "document" : "iframe",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": depth === 0 ? "none" : "same-origin",
      },
      redirect: "follow",
    });

    console.log(
      `[Phase 1] depth=${depth} fetch ${pageUrl} -> ${response.status} ${response.statusText} (final: ${response.url})`
    );

    if (!response.ok) {
      const snippet = await response.text().catch(() => "");
      console.log(
        `[Phase 1] non-ok body snippet (${snippet.length} chars):`,
        snippet.slice(0, 200)
      );
      return [];
    }
    const html = await response.text();

    if (html.length < 200) {
      console.log(
        `[Phase 1] suspiciously small body (${html.length} chars):`,
        html.slice(0, 200)
      );
    }

    let match: RegExpExecArray | null;

    // Build JS variable map FIRST so resolvers below can use it
    // Captures: var NAME = "VALUE" / let NAME = 'VALUE' / const NAME = `VALUE`
    const varMap: Record<string, string> = {};
    const varRegex = /(?:var|let|const)\s+(\w+)\s*=\s*["'`]([^"'`]+)["'`]/g;
    while ((match = varRegex.exec(html)) !== null) {
      varMap[match[1]] = match[2];
    }

    // Helper: resolve ${var} interpolations in a template body. Returns null if any var is unknown.
    const resolveTemplate = (template: string): string | null => {
      let resolved = template;
      const interpRegex = /\$\{(\w+)\}/g;
      let interp;
      while ((interp = interpRegex.exec(template)) !== null) {
        const varName = interp[1];
        if (!varMap[varName]) return null;
        resolved = resolved.replace(interp[0], varMap[varName]);
      }
      return resolved;
    };

    // <source src="..." type="video/...">
    const sourceRegex =
      /<source[^>]+src=["']([^"']+)["'][^>]*type=["']video\/[^"']+["']/gi;
    while ((match = sourceRegex.exec(html)) !== null) {
      videos.push(resolveUrl(match[1], baseUrl));
    }

    // <video src="...">
    const videoSrcRegex = /<video[^>]+src=["']([^"']+)["']/gi;
    while ((match = videoSrcRegex.exec(html)) !== null) {
      const src = match[1];
      if (!src.startsWith("blob:")) videos.push(resolveUrl(src, baseUrl));
    }

    // Direct video URLs in literal strings (skip unresolved templates with ${...})
    const directVideoRegex =
      /["'`](https?:\/\/[^"'`\s${}]+\.(?:mp4|webm|m3u8|mkv)(?:\?[^"'`\s${}]*)?)["'`]/gi;
    while ((match = directVideoRegex.exec(html)) !== null) {
      videos.push(match[1]);
    }

    // Resolve template literals: `https://.../${var}.mp4` or `/path/${var}?x=y`
    const templateRegex = /`([^`]*\$\{[^`]*)`/g;
    const iframeSrcs: string[] = [];
    while ((match = templateRegex.exec(html)) !== null) {
      const template = match[1];
      if (!template.includes("/") && !template.includes("http")) continue;

      const resolved = resolveTemplate(template);
      if (!resolved) continue;

      if (/\.(mp4|webm|m3u8|mkv)(\?|$)/i.test(resolved)) {
        videos.push(
          resolved.startsWith("http") ? resolved : resolveUrl(resolved, baseUrl)
        );
      } else if (resolved.startsWith("/") || resolved.startsWith("http")) {
        iframeSrcs.push(resolveUrl(resolved, baseUrl));
      }
    }

    if (videos.length > 0) return [...new Set(videos)];

    // No direct videos found — collect more iframe sources to follow

    // <iframe src="...">
    const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
    while ((match = iframeRegex.exec(html)) !== null) {
      iframeSrcs.push(resolveUrl(match[1], baseUrl));
    }

    // Resolve concatenation patterns:  'path' + varName  (e.g. iframe.src = '/ip129jk?id=' + iframeId)
    const concatRegex = /["']([^"']*\/[^"']*)["']\s*\+\s*(\w+)/g;
    while ((match = concatRegex.exec(html)) !== null) {
      const path = match[1];
      const varName = match[2];
      if (varMap[varName]) {
        const resolved = path + varMap[varName];
        if (resolved.startsWith("/") || resolved.startsWith("http")) {
          iframeSrcs.push(resolveUrl(resolved, baseUrl));
        }
      }
    }

    // Reversed: varName + 'path'
    const concatRegex2 = /(\w+)\s*\+\s*["']([^"']*\/[^"']*)["']/g;
    while ((match = concatRegex2.exec(html)) !== null) {
      const varName = match[1];
      const path = match[2];
      if (varMap[varName]) {
        const resolved = varMap[varName] + path;
        if (resolved.startsWith("/") || resolved.startsWith("http")) {
          iframeSrcs.push(resolveUrl(resolved, baseUrl));
        }
      }
    }

    // Literal iframe.src = '...' assignments
    const jsSrcRegex = /(?:iframe\.src|\.src)\s*=\s*['"]([^'"]+)['"]/gi;
    while ((match = jsSrcRegex.exec(html)) !== null) {
      const src = match[1];
      if (src.startsWith("/") || src.startsWith("http")) {
        iframeSrcs.push(resolveUrl(src, baseUrl));
      }
    }

    // Embed/player URLs in JS strings
    const embedRegex =
      /["']((?:https?:\/\/[^"']*)?\/embed[^"']*(?:\?[^"']*)?)["']/gi;
    while ((match = embedRegex.exec(html)) !== null) {
      iframeSrcs.push(resolveUrl(match[1], baseUrl));
    }

    // playerPath / fullURL / videoUrl / file = "..." patterns
    const playerPathRegex =
      /(?:playerPath|fullURL|videoUrl|video_url|file)\s*[:=]\s*["']([^"']+)["']/gi;
    while ((match = playerPathRegex.exec(html)) !== null) {
      const src = match[1];
      if (
        src.includes("embed") ||
        src.includes("video") ||
        src.includes("player")
      ) {
        iframeSrcs.push(resolveUrl(src, baseUrl));
      }
    }

    // Filter ad/tracking domains
    const uniqueIframes = [...new Set(iframeSrcs)].filter((src) => {
      return (
        !src.includes("googlesyndication") &&
        !src.includes("googletagmanager") &&
        !src.includes("cloudflareinsights") &&
        !src.includes("adsbygoogle") &&
        !src.includes("pinderecphory") &&
        !src.includes("wpadmngr")
      );
    });

    console.log(
      `[Phase 1] Depth ${depth}: Following ${uniqueIframes.length} iframe(s)`
    );

    for (const iframeSrc of uniqueIframes) {
      try {
        const iframeVideos = await extractVideosFromHTML(
          iframeSrc,
          depth + 1,
          pageUrl
        );
        videos.push(...iframeVideos);
        if (videos.length > 0) break;
      } catch {}
    }

    return [...new Set(videos)];
  } catch (e) {
    console.log(`[Phase 1] Fetch failed for ${pageUrl}:`, e);
    return [];
  }
}

export async function POST(req: Request) {
  try {
    const { url } = await req.json();

    if (!url) {
      return NextResponse.json(
        { success: false, message: "URL is required" },
        { status: 400 }
      );
    }

    console.log("Extracting videos from:", url);
    const videos = await extractVideosFromHTML(url);

    if (videos.length > 0) {
      console.log(`Found ${videos.length} video(s)`);
      return NextResponse.json({ success: true, videos });
    }

    return NextResponse.json({
      success: true,
      videos: [],
      message: "No video found on this page.",
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("Error:", message);
    return NextResponse.json(
      { success: false, message },
      { status: 500 }
    );
  }
}

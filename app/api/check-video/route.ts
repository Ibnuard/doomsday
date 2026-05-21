import { NextResponse } from "next/server";

// Run in Singapore (closest Vercel region to Indonesian video hosts).
// Many SEA hosts geo-block US datacenter IPs, so US regions return blank pages.
export const runtime = "nodejs";
export const preferredRegion = ["sin1", "hkg1", "icn1"];
export const maxDuration = 90;

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
 * Detects Cloudflare anti-bot challenge pages. These come back with 200 or 403
 * and contain telltale markers like "Just a moment..." or the cf-chl- script tag.
 */
function isCloudflareChallenge(html: string): boolean {
  if (!html || html.length < 1000) return false;
  const lower = html.toLowerCase();
  return (
    lower.includes("just a moment") ||
    lower.includes("cf-chl-bypass") ||
    lower.includes("__cf_chl_") ||
    lower.includes("cf_chl_opt") ||
    (lower.includes("challenge-platform") && lower.includes("cloudflare"))
  );
}

/**
 * Fetches HTML for a URL. Tries direct fetch first, then transparently retries
 * through ScraperAPI when Cloudflare blocks the request. Requires SCRAPERAPI_KEY
 * env var for the fallback to work — without it, only direct fetch is attempted.
 */
async function fetchHtml(
  pageUrl: string,
  depth: number,
  referer?: string
): Promise<string | null> {
  const baseUrl = new URL(pageUrl);
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: referer || baseUrl.origin + "/",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": depth === 0 ? "document" : "iframe",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": depth === 0 ? "none" : "same-origin",
  };

  // First attempt: direct fetch
  try {
    const response = await fetch(pageUrl, { headers, redirect: "follow" });
    console.log(
      `[Phase 1] direct depth=${depth} ${pageUrl} -> ${response.status} ${response.statusText}`
    );

    const blockedStatus =
      response.status === 403 ||
      response.status === 429 ||
      response.status === 503;

    if (response.ok || (!blockedStatus && response.status < 500)) {
      const html = await response.text();
      if (response.ok && !isCloudflareChallenge(html)) {
        return html;
      }
      console.log(
        `[Phase 1] direct hit Cloudflare challenge or non-ok (${html.length} chars), trying ScraperAPI...`
      );
    } else {
      console.log(`[Phase 1] direct blocked (${response.status}), trying ScraperAPI...`);
    }
  } catch (e) {
    console.log(`[Phase 1] direct fetch threw:`, e);
  }

  // Tier 2: ScraperAPI (residential IPs + JS rendering for Cloudflare challenges)
  // ScraperAPI rejects URLs ending in file extensions like .mp4 — we sidestep that
  // by appending a dummy query param so the URL no longer looks like a file.
  const looksLikeFile = /\.(mp4|webm|m3u8|mkv|jpg|jpeg|png|gif|pdf|zip)(\?|$)/i.test(
    pageUrl
  );
  const key = process.env.SCRAPERAPI_KEY;
  if (key) {
    try {
      const targetUrl = looksLikeFile
        ? pageUrl + (pageUrl.includes("?") ? "&" : "?") + "_h=1"
        : pageUrl;

      const proxyUrl = new URL("https://api.scraperapi.com/");
      proxyUrl.searchParams.set("api_key", key);
      proxyUrl.searchParams.set("url", targetUrl);
      // render=true executes JS — required to clear Cloudflare's "Just a moment..." challenge
      proxyUrl.searchParams.set("render", "true");
      proxyUrl.searchParams.set("keep_headers", "true");
      if (referer) proxyUrl.searchParams.set("referer", referer);

      const response = await fetch(proxyUrl.toString(), { headers });
      console.log(
        `[Phase 1] scraperapi depth=${depth} ${pageUrl} -> ${response.status} ${response.statusText}`
      );

      if (response.ok) {
        const html = await response.text();
        if (!isCloudflareChallenge(html)) return html;
        console.log("[Phase 1] scraperapi response still looks like Cloudflare challenge");
      } else {
        const snippet = await response.text().catch(() => "");
        console.log(`[Phase 1] scraperapi error body:`, snippet.slice(0, 200));
      }
    } catch (e) {
      console.log(`[Phase 1] scraperapi threw:`, e);
    }
  } else {
    console.log("[Phase 1] SCRAPERAPI_KEY not set — skipping tier 2");
  }

  // Tier 3: Headless Chromium (last resort, slow cold start but handles anything)
  try {
    const html = await fetchWithChromium(pageUrl, referer);
    if (html && !isCloudflareChallenge(html)) {
      console.log(`[Phase 1] chromium succeeded depth=${depth} (${html.length} chars)`);
      return html;
    }
    console.log("[Phase 1] chromium returned challenge or empty");
  } catch (e) {
    console.log("[Phase 1] chromium threw:", e);
  }

  return null;
}

/**
 * Cached chromium executable path so we don't re-download on every request.
 */
let cachedChromiumPath: string | null = null;
const CHROMIUM_PACK_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar";

async function getChromiumPath(): Promise<string> {
  if (cachedChromiumPath) return cachedChromiumPath;
  const chromium = (await import("@sparticuz/chromium-min")).default;
  cachedChromiumPath = await chromium.executablePath(CHROMIUM_PACK_URL);
  return cachedChromiumPath;
}

/**
 * Fetches a page using headless Chromium. Handles Cloudflare JS challenges
 * naturally because the browser executes them like a real client.
 */
async function fetchWithChromium(
  pageUrl: string,
  referer?: string
): Promise<string | null> {
  const isVercel = !!process.env.VERCEL_ENV;

  // Local dev: skip chromium (direct fetch usually works on residential IP)
  if (!isVercel) {
    console.log("[Phase 1] chromium tier disabled in local dev");
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;
  try {
    const chromium = (await import("@sparticuz/chromium-min")).default;
    const puppeteer = await import("puppeteer-core");
    const executablePath = await getChromiumPath();

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        // Stealth flags to reduce bot detection
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      defaultViewport: { width: 1280, height: 720 },
      executablePath,
      headless: true,
    });

    const page = await browser.newPage();

    // Stealth: hide automation indicators before any page script runs
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).chrome = { runtime: {} };
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    if (referer) {
      await page.setExtraHTTPHeaders({ Referer: referer });
    }

    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Poll for Cloudflare challenge to clear (up to 50s).
    // Check both title and body content — cleared pages have <video>, real titles, etc.
    const challengeTimeout = 50000;
    const pollInterval = 1500;
    const start = Date.now();
    let lastTitle = "";
    while (Date.now() - start < challengeTimeout) {
      const title = await page.title().catch(() => "");
      const titleChallenged =
        /just a moment|attention required|checking your browser|please wait/i.test(
          title
        );

      // Also check if page has actual content beyond Cloudflare's challenge
      const hasRealContent = await page
        .evaluate(() => {
          if (document.querySelector("video, iframe, source")) return true;
          const bodyText = document.body?.innerText || "";
          return bodyText.length > 200 && !bodyText.toLowerCase().includes("checking your browser");
        })
        .catch(() => false);

      if (!titleChallenged && hasRealContent) {
        console.log(
          `[Phase 1] chromium challenge cleared after ${Date.now() - start}ms (title: "${title}")`
        );
        // Give the rest of the page a beat to render
        await new Promise((r) => setTimeout(r, 2000));
        break;
      }
      if (title !== lastTitle) {
        console.log(`[Phase 1] chromium polling, title="${title}" hasContent=${hasRealContent}`);
        lastTitle = title;
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    const html = await page.content();
    console.log(
      `[Phase 1] chromium got ${html.length} chars (total time ${Date.now() - start}ms)`
    );
    return html;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
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
    const html = await fetchHtml(pageUrl, depth, referer);
    if (html === null) return [];

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

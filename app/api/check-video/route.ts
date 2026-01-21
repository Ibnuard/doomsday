/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";

// URL to the Chromium binary package hosted in /public
const CHROMIUM_PACK_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/chromium-pack.tar`
  : "https://github.com/nichanunez/puppeteer-on-vercel/raw/refs/heads/main/example/chromium-dont-use-in-prod.tar";

// Cache the Chromium executable path to avoid re-downloading on subsequent requests
let cachedExecutablePath: string | null = null;
let downloadPromise: Promise<string> | null = null;

/**
 * Downloads and caches the Chromium executable path.
 * Uses a download promise to prevent concurrent downloads.
 */
async function getChromiumPath(): Promise<string> {
  // Return cached path if available
  if (cachedExecutablePath) return cachedExecutablePath;

  // Prevent concurrent downloads by reusing the same promise
  if (!downloadPromise) {
    const chromium = (await import("@sparticuz/chromium-min")).default;
    downloadPromise = chromium
      .executablePath(CHROMIUM_PACK_URL)
      .then((path) => {
        cachedExecutablePath = path;
        console.log("Chromium path resolved:", path);
        return path;
      })
      .catch((error) => {
        console.error("Failed to get Chromium path:", error);
        downloadPromise = null; // Reset on error to allow retry
        throw error;
      });
  }

  return downloadPromise;
}

export async function POST(req: Request) {
  let browser = null;

  try {
    const { url } = await req.json();

    if (!url) {
      return NextResponse.json(
        { success: false, message: "URL is required" },
        { status: 400 }
      );
    }

    const videos = new Set<string>();

    // Configure browser based on environment
    const isVercel = !!process.env.VERCEL_ENV;
    let puppeteer: any;
    let launchOptions: any = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1920x1080",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    };

    if (isVercel) {
      // Vercel: Use puppeteer-core with downloaded Chromium binary
      const chromium = (await import("@sparticuz/chromium-min")).default;
      puppeteer = await import("puppeteer-core");
      const executablePath = await getChromiumPath();
      launchOptions = {
        ...launchOptions,
        args: [...chromium.args, ...launchOptions.args],
        executablePath,
      };
      console.log("Launching browser with executable path:", executablePath);
    } else {
      // Local: Use regular puppeteer with bundled Chromium
      puppeteer = await import("puppeteer");
    }

    // Launch browser
    browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();

    // Set user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Hide webdriver property
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
    });

    // Intercept network requests
    await page.setRequestInterception(true);

    page.on("request", (request: any) => {
      const reqUrl = request.url();
      if (
        reqUrl.match(/\.(mp4|webm|m3u8|mkv|avi|mov|flv)(\?|$)/i) ||
        reqUrl.includes("/video") ||
        reqUrl.includes("googlevideo.com") ||
        reqUrl.includes("videoplayback")
      ) {
        videos.add(reqUrl);
      }
      request.continue();
    });

    page.on("response", (response: any) => {
      const resUrl = response.url();
      const contentType = response.headers()["content-type"] || "";
      if (
        contentType.includes("video/") ||
        contentType.includes("application/vnd.apple.mpegurl") ||
        resUrl.match(/\.(mp4|webm|m3u8|mkv)(\?|$)/i)
      ) {
        videos.add(resUrl);
      }
    });

    // Retry logic
    let retries = 3;
    let success = false;

    while (retries > 0 && !success) {
      try {
        console.log(`Attempting to load URL (Retries left: ${retries})...`);

        // Navigate to page
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });

        // Wait for body selector
        try {
          await page.waitForSelector("body", { timeout: 10000 });
        } catch {
          console.log("Body selector not found, page might be blank.");
        }

        // Check if page is blank
        const bodyText = await page.evaluate(
          () => document.body.innerText.trim()
        );
        if (bodyText.length < 50) {
          console.log("Page seems blank or empty, reloading...");
          throw new Error("Page blank");
        }

        // Wait extra time for video scripts to load
        await new Promise((resolve) => setTimeout(resolve, 5000));

        success = true;
      } catch (e) {
        console.error(`Attempt failed: ${e}`);
        retries--;
        if (retries === 0) break;
        await page.reload({ waitUntil: "domcontentloaded" });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // Find video elements in DOM
    const domVideos = await page.evaluate(() => {
      const foundVideos: string[] = [];
      document.querySelectorAll("video").forEach((v) => {
        if (v.src) foundVideos.push(v.src);
        if (v.currentSrc) foundVideos.push(v.currentSrc);
      });
      document.querySelectorAll("source").forEach((s) => {
        if (s.src) foundVideos.push(s.src);
      });
      document.querySelectorAll("iframe").forEach((iframe) => {
        if (iframe.src) foundVideos.push(iframe.src);
      });
      return foundVideos;
    });

    domVideos.forEach((v: string) => videos.add(v));

    await browser.close();
    browser = null;

    const filteredVideos = [...videos].filter((v) => {
      try {
        new URL(v);
        return true;
      } catch {
        return false;
      }
    });

    return NextResponse.json({
      success: true,
      videos: filteredVideos,
    });
  } catch (e: any) {
    console.error("Error:", e);
    return NextResponse.json(
      { success: false, message: e.message },
      { status: 500 }
    );
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

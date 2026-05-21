import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native binary packages should not be bundled — they're loaded at runtime
  serverExternalPackages: [
    "puppeteer-core",
    "@sparticuz/chromium-min",
  ],
};

export default nextConfig;

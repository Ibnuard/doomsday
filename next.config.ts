import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // External packages that should not be bundled
  serverExternalPackages: [
    "puppeteer-core",
    "@sparticuz/chromium-min",
  ],
};

export default nextConfig;

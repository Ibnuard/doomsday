import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

async function main() {
  try {
    console.log("📦 Starting postinstall script...");

    // Try to resolve chromium package location
    let chromiumResolvedPath;
    try {
      chromiumResolvedPath = import.meta.resolve("@sparticuz/chromium");
    } catch {
      console.log("⚠️  @sparticuz/chromium not found (might be in devDependencies only)");
      console.log("   Skipping chromium archive creation - will use fallback URL in production");
      return;
    }

    // Convert file:// URL to regular path
    let chromiumPath = chromiumResolvedPath.replace(/^file:\/\/\//, "");
    
    // Handle Windows path format
    if (process.platform === "win32") {
      chromiumPath = chromiumPath.replace(/\//g, "\\");
    }

    // Get the package root directory (goes up from build/esm/index.js to package root)
    const chromiumDir = dirname(dirname(dirname(chromiumPath)));
    const binDir = join(chromiumDir, "bin");

    console.log("   Chromium package path:", chromiumPath);
    console.log("   Chromium dir:", chromiumDir);
    console.log("   Bin dir:", binDir);

    if (!existsSync(binDir)) {
      console.log(
        "⚠️  Chromium bin directory not found, skipping archive creation"
      );
      return;
    }

    // Create public folder if not exists
    const publicDir = join(projectRoot, "public");
    if (!existsSync(publicDir)) {
      mkdirSync(publicDir, { recursive: true });
    }

    const outputPath = join(publicDir, "chromium-pack.tar");

    console.log("📦 Creating chromium tar archive...");
    console.log("   Source:", binDir);
    console.log("   Output:", outputPath);

    // Use tar command (available in Windows 10+ and Unix)
    execSync(`tar -cf "${outputPath}" -C "${binDir}" .`, {
      stdio: "inherit",
      cwd: projectRoot,
    });

    console.log("✅ Chromium archive created successfully!");
  } catch (error) {
    console.error("❌ Failed to create chromium archive:", error.message);
    console.log("⚠️  This is not critical for local development");
    process.exit(0); // Don't fail the install
  }
}

main();
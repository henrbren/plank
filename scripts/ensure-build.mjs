// wrangler dev krever at dist/client finnes (statiske filer). Bygg én gang hvis den mangler.
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
if (!existsSync("dist/client/index.html")) {
  console.log("[plank] dist/client mangler – bygger frontend én gang …");
  execSync("npx vite build", { stdio: "inherit" });
}

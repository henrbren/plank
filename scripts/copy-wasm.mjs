// Kopierer web-ifc sin WASM-fil til public/wasm slik at IFC-vieweren kan laste den.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "web-ifc", "web-ifc.wasm");
const destDir = join(root, "public", "wasm");
if (!existsSync(src)) {
  console.warn("[plank] web-ifc.wasm ikke funnet – hopper over kopiering");
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, join(destDir, "web-ifc.wasm"));
console.log("[plank] Kopierte web-ifc.wasm til public/wasm/");

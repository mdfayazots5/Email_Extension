// Copies the built extension (extension/dist) into the project root so Chrome
// can "Load unpacked" directly from this folder.
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "extension", "dist");
if (!existsSync(path.join(dist, "manifest.json"))) {
  console.error("extension/dist/manifest.json not found; run the extension build first.");
  process.exit(1);
}
// Remove stale hashed bundles before copying the new ones.
rmSync(path.join(root, "assets"), { recursive: true, force: true });
for (const entry of readdirSync(dist)) {
  cpSync(path.join(dist, entry), path.join(root, entry), { recursive: true });
}
console.log(`Synced ${dist} -> ${root}`);

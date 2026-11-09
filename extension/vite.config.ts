import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

const manifestPlugin: Plugin = {
  name: "emit-extension-manifest",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "manifest.json",
      source: readFileSync(`${projectRoot}tracker.manifest.json`, "utf8")
    });
  }
};

export default defineConfig({
  plugins: [react(), manifestPlugin],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        index: `${projectRoot}index.html`,
        popup: `${projectRoot}popup.html`,
        "service-worker": `${projectRoot}service-worker.ts`,
        "content-script": `${projectRoot}src/search/content-script.ts`
      },
      output: {
        entryFileNames: "[name].js"
      }
    }
  }
});

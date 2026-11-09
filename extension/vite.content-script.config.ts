import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: `${projectRoot}src/search/content-script.ts`,
      output: {
        entryFileNames: "content-script.js",
        format: "iife",
        name: "JobPostEmailTrackerContent",
        inlineDynamicImports: true
      }
    }
  }
});

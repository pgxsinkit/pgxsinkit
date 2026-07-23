import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  optimizeDeps: { exclude: ["@electric-sql/pglite"] },
  build: {
    outDir: fileURLToPath(new URL("../../../tmp/opfs-repacked-browser", import.meta.url)),
    emptyOutDir: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4190,
    strictPort: true,
  },
});

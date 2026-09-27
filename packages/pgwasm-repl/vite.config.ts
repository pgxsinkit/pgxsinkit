import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const packageDir = dirname(fileURLToPath(import.meta.url));

// Vite library build, as for @pgxsinkit/react (ADR-0037): Vite's own transform emits the production
// automatic JSX runtime (`react/jsx-runtime`), where Bun.build would emit the development one. The
// stylesheet is a string in src/styles.ts, so the bundle imports no CSS.
export default defineConfig({
  // The production automatic JSX transform, whatever the ambient NODE_ENV.
  oxc: {
    jsx: {
      runtime: "automatic",
      development: false,
    },
  },
  build: {
    lib: {
      entry: resolve(packageDir, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    // scripts/build-public-packages.ts owns the dist lifecycle: it clears dist, runs this bundle, then
    // emits the declarations into the same directory.
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    target: "esnext",
    rolldownOptions: {
      // Every bare specifier stays external: react, its JSX runtime and the CodeMirror packages the
      // manifest declares. Only the package's own modules are bundled.
      external: (id) => !id.startsWith(".") && !isAbsolute(id),
    },
  },
});

import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const packageDir = dirname(fileURLToPath(import.meta.url));

// Vite library build for the browser-oriented React package (ADR-0037). The other public packages
// go through Bun.build (see scripts/build-public-packages.ts), but that path compiles the package's
// JSX against `react/jsx-dev-runtime` — a module downstream Vite PRODUCTION builds rewrite to
// `jsxDEV = undefined`, so rendering the published component threw at runtime. Vite's own transform
// emits the automatic production runtime (`react/jsx-runtime`); no @vitejs/plugin-react needed —
// that adds dev-server refresh/babel machinery a library bundle never runs.
//
// `tests/unit/react-package-build.test.ts` pins the artifact contract this config must keep:
// production JSX runtime only, every bare import left external (react un-duplicated, no inlined
// workspace/peer code), and an external source map.
export default defineConfig({
  // Pin the PRODUCTION automatic JSX transform unconditionally. Vite otherwise derives the dev
  // transform from the ambient NODE_ENV (a `bun test`-spawned build inherits NODE_ENV=test and
  // would silently emit `jsxDEV` again) — the exact failure this config exists to prevent.
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
    // scripts/build-public-packages.ts owns the dist lifecycle: it clears dist, runs this bundle,
    // then emits the tsc declarations into the same directory.
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    target: "esnext",
    rolldownOptions: {
      // Every bare specifier stays external — react (and its compiler-inserted jsx-runtime
      // subpath) plus the @pgxsinkit/* workspace dependencies the manifest declares. Only the
      // package's own relative modules are bundled.
      external: (id) => !id.startsWith(".") && !isAbsolute(id),
    },
  },
});

import path from "node:path";

// Build outside the test process: in-process Bun.build can affect later module resolution.
const built = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "pgwasm-c-iife-entry.ts")],
  target: "browser",
  format: "iife",
  external: ["node:*"],
  define: { "import.meta.url": "undefined" },
});
if (!built.success) throw new Error(built.logs.map(String).join("\n"));
const destination = process.argv[2];
if (destination === undefined) throw new Error("Expected the IIFE output path");
await Bun.write(destination, built.outputs[0]!);

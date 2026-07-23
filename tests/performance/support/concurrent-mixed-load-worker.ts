import { writeFile } from "node:fs/promises";

import { runConcurrentMixedLoadWorker } from "./concurrent-mixed-load";

const rawInput = process.env["PGXSINKIT_PERF_WORKER_INPUT"];
const outputFile = process.env["PGXSINKIT_PERF_WORKER_OUTPUT_FILE"];

if (!rawInput) {
  throw new Error("Missing PGXSINKIT_PERF_WORKER_INPUT");
}

if (!outputFile) {
  throw new Error("Missing PGXSINKIT_PERF_WORKER_OUTPUT_FILE");
}

const input = JSON.parse(Buffer.from(rawInput, "base64url").toString("utf8"));
const result = await runConcurrentMixedLoadWorker(input);
await writeFile(outputFile, JSON.stringify(result), "utf8");

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// PGlite datadir width probe: verifies the ADR claim that a Postgres datadir is
// roughly 970 files. Creates a PGlite instance backed by a `file://` dataDir under
// the repo's gitignored tmp/ tree, runs initdb + one trivial query + close, then
// recursively counts the regular files in the datadir. Cleans up afterward.
//
// Uses the root `@electric-sql/pglite` dependency, which package.json aliases to the
// @pgxsinkit fork.
import { PGlite } from "@electric-sql/pglite";

export interface DatadirCountResult {
  files: number;
  directories: number;
  dataDir: string;
}

async function countRegularFiles(dir: string): Promise<{ files: number; directories: number }> {
  let files = 0;
  let directories = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        directories += 1;
        stack.push(full);
      } else if (entry.isFile()) {
        files += 1;
      }
    }
  }
  return { files, directories };
}

export async function countDatadirFiles(): Promise<DatadirCountResult> {
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const scratchBase = path.join(repoRoot, "tmp", "results");
  mkdirSync(scratchBase, { recursive: true });
  let dir: string;
  try {
    dir = mkdtempSync(path.join(scratchBase, "pglite-datadir-"));
  } catch {
    // Fall back to the OS temp dir only if the repo scratch dir is unavailable.
    dir = mkdtempSync(path.join(tmpdir(), "pglite-datadir-"));
  }
  try {
    const pg = await PGlite.create({ dataDir: `file://${dir}` });
    await pg.query("SELECT 1");
    await pg.close();
    const counts = await countRegularFiles(dir);
    return { files: counts.files, directories: counts.directories, dataDir: dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await countDatadirFiles();
  console.log(JSON.stringify(result, null, 2));
  // Write the untracked measurement record under the repo's gitignored tmp/ tree.
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const resultsDir = path.join(repoRoot, "tmp", "results");
  mkdirSync(resultsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const outPath = path.join(resultsDir, `engine-capabilities-datadir-${date}.json`);
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${outPath} (untracked)`);
}

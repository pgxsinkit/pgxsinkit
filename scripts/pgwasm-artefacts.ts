#!/usr/bin/env bun
/**
 * Fetch and verify the C Postgres build's artefacts (`@pgxsinkit/pgwasm-c`, ADR-0062 decision 9).
 *
 * The artefacts are pinned by version and checksum in `packages/pgwasm-c/src/artefact-pins.ts` and
 * are never committed. This script, run as the root `postinstall`, makes
 * `packages/pgwasm-c/artefacts/` hold exactly the pinned files:
 *
 *   1. a file already there with the pinned size and sha256 is left alone (no network);
 *   2. otherwise the npm tarball is taken from `.buildcache/pgwasm-artefacts/`, or downloaded into
 *      it, and checked against its pinned sha512 integrity;
 *   3. the pinned members are extracted, each checked against its sha256 before it replaces the
 *      file in `artefacts/`.
 *
 * A file in `artefacts/` that fails its pin is deleted as soon as it is found, before anything is
 * fetched, so a run that then fails (no network, a bad tarball) leaves the file missing rather than
 * wrong: nothing that does not match a pin is kept. Extraction writes each file to a `.part` name and
 * renames it into place only once its content has matched the pin. Any mismatch fails the run with the
 * file, the expected and the actual digest. `--verify-only` checks `artefacts/` without fetching or
 * extracting, deleting mismatching files the same way (`build:public-packages` runs it before bundling
 * the package).
 */

import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { ARTEFACT_FILES, ARTEFACT_SOURCE, type ArtefactName } from "../packages/pgwasm-c/src/artefact-pins";
import { gunzip } from "../packages/pgwasm/src/tar/gzip";
import { readTar } from "../packages/pgwasm/src/tar/tar";

const repoRoot = path.resolve(import.meta.dir, "..");
export const ARTEFACT_DIR = path.join(repoRoot, "packages/pgwasm-c/artefacts");
const CACHE_DIR = path.join(repoRoot, ".buildcache/pgwasm-artefacts");
const TARBALL_CACHE = path.join(CACHE_DIR, `pglite-${ARTEFACT_SOURCE.version}.tgz`);
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const names = Object.keys(ARTEFACT_FILES) as ArtefactName[];

export interface ArtefactProblem {
  readonly name: ArtefactName;
  readonly problem: string;
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function sriSha512(bytes: Uint8Array): string {
  return `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
}

function describeMismatch(name: ArtefactName, bytes: Uint8Array): string | undefined {
  const pin = ARTEFACT_FILES[name];
  if (bytes.byteLength !== pin.bytes) return `size ${bytes.byteLength}, expected ${pin.bytes}`;
  const actual = sha256(bytes);
  return actual === pin.sha256 ? undefined : `sha256 ${actual}, expected ${pin.sha256}`;
}

/** Check every pinned file in `dir`; an empty result means all are present and correct. */
export async function verifyPgwasmArtefacts(dir: string = ARTEFACT_DIR): Promise<ArtefactProblem[]> {
  const problems: ArtefactProblem[] = [];
  for (const name of names) {
    const file = Bun.file(path.join(dir, name));
    if (!(await file.exists())) {
      problems.push({ name, problem: "missing" });
      continue;
    }
    const mismatch = describeMismatch(name, new Uint8Array(await file.arrayBuffer()));
    if (mismatch !== undefined) problems.push({ name, problem: mismatch });
  }
  return problems;
}

/** Delete every file `problems` reports as present but not matching its pin. */
export function discardMismatchedArtefacts(problems: readonly ArtefactProblem[], dir: string = ARTEFACT_DIR): void {
  for (const { name, problem } of problems) {
    if (problem !== "missing") rmSync(path.join(dir, name), { force: true });
  }
}

async function readCachedTarball(): Promise<Uint8Array | undefined> {
  const file = Bun.file(TARBALL_CACHE);
  if (!(await file.exists())) return undefined;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sriSha512(bytes) === ARTEFACT_SOURCE.integrity) return bytes;
  console.warn(`pgwasm-artefacts: the cached tarball ${TARBALL_CACHE} fails its integrity check; fetching it again.`);
  rmSync(TARBALL_CACHE, { force: true });
  return undefined;
}

async function downloadTarball(): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(ARTEFACT_SOURCE.tarball, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const integrity = sriSha512(bytes);
      if (integrity !== ARTEFACT_SOURCE.integrity) {
        throw new Error(`integrity ${integrity}, expected ${ARTEFACT_SOURCE.integrity}`);
      }
      mkdirSync(CACHE_DIR, { recursive: true });
      const partial = `${TARBALL_CACHE}.part`;
      await Bun.write(partial, bytes);
      renameSync(partial, TARBALL_CACHE);
      return bytes;
    } catch (error) {
      lastError = error;
      console.warn(`pgwasm-artefacts: download attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed: ${String(error)}`);
    }
  }
  throw new Error(
    `could not download ${ARTEFACT_SOURCE.tarball} (${String(lastError)}). The C Postgres build's artefacts are ` +
      `fetched once and then cached in ${path.relative(repoRoot, CACHE_DIR)}/; run \`bun install\` again with network ` +
      `access.`,
    { cause: lastError },
  );
}

async function extract(tarball: Uint8Array, wanted: readonly ArtefactName[]): Promise<void> {
  const members = new Map(readTar(await gunzip(tarball)).map((entry) => [entry.name, entry]));
  mkdirSync(ARTEFACT_DIR, { recursive: true });
  for (const name of wanted) {
    const pin = ARTEFACT_FILES[name];
    const member = members.get(pin.from);
    if (member === undefined || member.type !== "file") {
      throw new Error(`${ARTEFACT_SOURCE.tarball} has no member ${pin.from} (for artefacts/${name})`);
    }
    const mismatch = describeMismatch(name, member.data);
    if (mismatch !== undefined) {
      throw new Error(`${pin.from} in the verified tarball does not match the pin for ${name}: ${mismatch}`);
    }
    const target = path.join(ARTEFACT_DIR, name);
    const partial = `${target}.part`;
    try {
      await Bun.write(partial, member.data);
      renameSync(partial, target);
    } finally {
      rmSync(partial, { force: true });
    }
  }
}

/** Make `artefacts/` hold exactly the pinned files. Returns the names it had to (re)write. */
export async function ensurePgwasmArtefacts(): Promise<ArtefactName[]> {
  const problems = await verifyPgwasmArtefacts();
  if (problems.length === 0) return [];
  // Before any fetch that may fail: a wrong file must not outlive this run.
  discardMismatchedArtefacts(problems);
  const stale = problems.map((problem) => problem.name);
  const tarball = (await readCachedTarball()) ?? (await downloadTarball());
  await extract(tarball, stale);
  const remaining = await verifyPgwasmArtefacts();
  if (remaining.length > 0) {
    discardMismatchedArtefacts(remaining);
    throw new Error(`artefacts still fail verification after extraction: ${JSON.stringify(remaining)}`);
  }
  return stale;
}

if (import.meta.main) {
  const verifyOnly = process.argv.includes("--verify-only");
  try {
    if (verifyOnly) {
      const problems = await verifyPgwasmArtefacts();
      if (problems.length > 0) {
        discardMismatchedArtefacts(problems);
        console.error(
          `pgwasm-artefacts: packages/pgwasm-c/artefacts/ does not hold the pinned files ` +
            `(any that did not match were deleted):\n` +
            problems.map(({ name, problem }) => `  ${name}: ${problem}`).join("\n") +
            "\nRun `bun install` (its postinstall fetches and verifies them).",
        );
        process.exit(1);
      }
      console.log("pgwasm-artefacts: all pinned artefacts present and verified.");
    } else {
      const written = await ensurePgwasmArtefacts();
      console.log(
        written.length === 0
          ? "pgwasm-artefacts: all pinned artefacts present and verified."
          : `pgwasm-artefacts: fetched and verified ${written.join(", ")}.`,
      );
    }
  } catch (error) {
    console.error(`pgwasm-artefacts: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

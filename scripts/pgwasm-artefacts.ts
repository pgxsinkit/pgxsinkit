#!/usr/bin/env bun
/**
 * Fetch and verify the pinned artefacts of every build package (`@pgxsinkit/pgwasm-c`,
 * `@pgxsinkit/pgwasm-pg-dump`; ADR-0062 decision 9).
 *
 * Each package pins its artefacts by version and checksum in its own `src/artefact-pins.ts`; they are
 * never committed. This script, run as the root `postinstall`, makes each package's `artefacts/` hold
 * exactly the pinned files:
 *
 *   1. a file already there with the pinned size and sha256 is left alone (no network);
 *   2. otherwise the npm tarball it comes from is taken from `.buildcache/pgwasm-artefacts/`, or
 *      downloaded into it, and checked against its pinned sha512 integrity;
 *   3. the pinned file is extracted from the tarball (a member, or a member source map's
 *      `sourcesContent` entry) and checked against its sha256 before it replaces the file in
 *      `artefacts/`.
 *
 * A file in `artefacts/` that fails its pin is deleted as soon as it is found, before anything is
 * fetched, so a run that then fails (no network, a bad tarball) leaves the file missing rather than
 * wrong: nothing that does not match a pin is kept. Extraction writes each file to a `.part` name and
 * renames it into place only once its content has matched the pin. Any mismatch fails the run with the
 * file, the expected and the actual digest. `--verify-only [packageDir…]` checks `artefacts/` without
 * fetching or extracting, deleting mismatching files the same way (`build:public-packages` verifies each
 * package before bundling it).
 */

import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { ARTEFACT_FILES as C_BUILD_ARTEFACTS } from "../packages/pgwasm-c/src/artefact-pins";
import { ARTEFACT_FILES as PG_DUMP_ARTEFACTS } from "../packages/pgwasm-pg-dump/src/artefact-pins";
import { gunzip } from "../packages/pgwasm/src/tar/gzip";
import { readTar, type TarEntry } from "../packages/pgwasm/src/tar/tar";

/** An npm tarball artefacts are taken from, with its integrity as the registry reports it. */
export interface ArtefactSource {
  readonly package: string;
  readonly version: string;
  readonly tarball: string;
  readonly integrity: string;
}

/**
 * Where a pinned file sits in its tarball: a member, byte for byte, or the `sourcesContent` entry of
 * `source` in the source map `sourceMap`, UTF-8 encoded (a file the package ships only minified, whose
 * original the source map carries verbatim).
 */
export type ArtefactOrigin = { readonly member: string } | { readonly sourceMap: string; readonly source: string };

export interface ArtefactPin {
  readonly source: ArtefactSource;
  readonly from: ArtefactOrigin;
  readonly bytes: number;
  readonly sha256: string;
}

/** A build package and its pinned artefacts, by file name in its `artefacts/`. */
export interface ArtefactPackage {
  readonly packageDir: string;
  readonly files: Readonly<Record<string, ArtefactPin>>;
}

export const ARTEFACT_PACKAGES: readonly ArtefactPackage[] = [
  { packageDir: "packages/pgwasm-c", files: C_BUILD_ARTEFACTS },
  { packageDir: "packages/pgwasm-pg-dump", files: PG_DUMP_ARTEFACTS },
];

const repoRoot = path.resolve(import.meta.dir, "..");
const CACHE_DIR = path.join(repoRoot, ".buildcache/pgwasm-artefacts");
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface ArtefactProblem {
  readonly name: string;
  readonly problem: string;
}

/** The package whose directory is `packageDir` (repository-relative). */
export function artefactPackage(packageDir: string): ArtefactPackage {
  const found = ARTEFACT_PACKAGES.find((pkg) => pkg.packageDir === packageDir);
  if (found === undefined) throw new Error(`${packageDir} pins no artefacts`);
  return found;
}

export function artefactDir(pkg: ArtefactPackage): string {
  return path.join(repoRoot, pkg.packageDir, "artefacts");
}

/** Where a source's tarball is cached: its registry file name (unique across the pinned sources). */
export function cachedTarballPath(source: ArtefactSource): string {
  return path.join(CACHE_DIR, path.posix.basename(new URL(source.tarball).pathname));
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function sriSha512(bytes: Uint8Array): string {
  return `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
}

function describeMismatch(pin: ArtefactPin, bytes: Uint8Array): string | undefined {
  if (bytes.byteLength !== pin.bytes) return `size ${bytes.byteLength}, expected ${pin.bytes}`;
  const actual = sha256(bytes);
  return actual === pin.sha256 ? undefined : `sha256 ${actual}, expected ${pin.sha256}`;
}

/** Check every pinned file of `pkg` in `dir`; an empty result means all are present and correct. */
export async function verifyArtefacts(
  pkg: ArtefactPackage,
  dir: string = artefactDir(pkg),
): Promise<ArtefactProblem[]> {
  const problems: ArtefactProblem[] = [];
  for (const [name, pin] of Object.entries(pkg.files)) {
    const file = Bun.file(path.join(dir, name));
    if (!(await file.exists())) {
      problems.push({ name, problem: "missing" });
      continue;
    }
    const mismatch = describeMismatch(pin, new Uint8Array(await file.arrayBuffer()));
    if (mismatch !== undefined) problems.push({ name, problem: mismatch });
  }
  return problems;
}

/** Delete every file `problems` reports as present but not matching its pin. */
export function discardMismatchedArtefacts(problems: readonly ArtefactProblem[], dir: string): void {
  for (const { name, problem } of problems) {
    if (problem !== "missing") rmSync(path.join(dir, name), { force: true });
  }
}

/** Throw, naming every problem, unless `pkg`'s artefacts are all present and correct. */
export async function assertArtefactsVerified(pkg: ArtefactPackage): Promise<void> {
  const problems = await verifyArtefacts(pkg);
  if (problems.length > 0) {
    discardMismatchedArtefacts(problems, artefactDir(pkg));
    throw new Error(
      `${pkg.packageDir}/artefacts/ does not hold the pinned files; any that did not match were deleted ` +
        `(${problems.map(({ name, problem }) => `${name}: ${problem}`).join("; ")}). Run \`bun install\` (its ` +
        `postinstall fetches and verifies them).`,
    );
  }
}

/**
 * The bytes a pin names, taken from the members of its (verified) tarball. Throws when the member, the
 * source map or its source is missing.
 */
export function extractPinned(members: ReadonlyMap<string, TarEntry>, pin: ArtefactPin): Uint8Array {
  const memberName = "member" in pin.from ? pin.from.member : pin.from.sourceMap;
  const member = members.get(memberName);
  if (member === undefined || member.type !== "file") {
    throw new Error(`${pin.source.tarball} has no member ${memberName}`);
  }
  if ("member" in pin.from) return member.data;
  const { source } = pin.from;
  let map: unknown;
  try {
    map = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(member.data));
  } catch (error) {
    throw new Error(`${memberName} in ${pin.source.tarball} is not a JSON source map`, { cause: error });
  }
  const { sources, sourcesContent } = (map ?? {}) as { sources?: unknown; sourcesContent?: unknown };
  const index = Array.isArray(sources) ? sources.indexOf(source) : -1;
  if (index < 0 || !Array.isArray(sources) || sources.lastIndexOf(source) !== index) {
    throw new Error(`the source map ${memberName} does not name the source ${source} exactly once`);
  }
  const content: unknown = Array.isArray(sourcesContent) ? sourcesContent[index] : undefined;
  if (typeof content !== "string") {
    throw new Error(`the source map ${memberName} carries no content for ${source}`);
  }
  return new TextEncoder().encode(content);
}

async function readCachedTarball(source: ArtefactSource): Promise<Uint8Array | undefined> {
  const cached = cachedTarballPath(source);
  const file = Bun.file(cached);
  if (!(await file.exists())) return undefined;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sriSha512(bytes) === source.integrity) return bytes;
  console.warn(`pgwasm-artefacts: the cached tarball ${cached} fails its integrity check; fetching it again.`);
  rmSync(cached, { force: true });
  return undefined;
}

async function downloadTarball(source: ArtefactSource): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(source.tarball, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const integrity = sriSha512(bytes);
      if (integrity !== source.integrity) {
        throw new Error(`integrity ${integrity}, expected ${source.integrity}`);
      }
      mkdirSync(CACHE_DIR, { recursive: true });
      const cached = cachedTarballPath(source);
      const partial = `${cached}.part`;
      await Bun.write(partial, bytes);
      renameSync(partial, cached);
      return bytes;
    } catch (error) {
      lastError = error;
      console.warn(
        `pgwasm-artefacts: download attempt ${attempt}/${DOWNLOAD_ATTEMPTS} of ${source.tarball} failed: ${String(error)}`,
      );
    }
  }
  throw new Error(
    `could not download ${source.tarball} (${String(lastError)}). The build packages' artefacts are fetched ` +
      `once and then cached in ${path.relative(repoRoot, CACHE_DIR)}/; run \`bun install\` again with network ` +
      `access.`,
    { cause: lastError },
  );
}

/** Each source's tarball members, read once per run however many files come from it. */
const tarballMembers = new Map<string, Promise<ReadonlyMap<string, TarEntry>>>();

function membersOf(source: ArtefactSource): Promise<ReadonlyMap<string, TarEntry>> {
  let pending = tarballMembers.get(source.tarball);
  if (pending === undefined) {
    pending = (async () => {
      const tarball = (await readCachedTarball(source)) ?? (await downloadTarball(source));
      return new Map(readTar(await gunzip(tarball)).map((entry) => [entry.name, entry] as const));
    })();
    tarballMembers.set(source.tarball, pending);
  }
  return pending;
}

async function extract(pkg: ArtefactPackage, wanted: readonly string[]): Promise<void> {
  const dir = artefactDir(pkg);
  mkdirSync(dir, { recursive: true });
  for (const name of wanted) {
    const pin = pkg.files[name];
    if (pin === undefined) throw new Error(`${pkg.packageDir} pins no artefact ${name}`);
    const bytes = extractPinned(await membersOf(pin.source), pin);
    const mismatch = describeMismatch(pin, bytes);
    if (mismatch !== undefined) {
      throw new Error(`the verified ${pin.source.tarball} does not hold the pinned ${name}: ${mismatch}`);
    }
    const target = path.join(dir, name);
    const partial = `${target}.part`;
    try {
      await Bun.write(partial, bytes);
      renameSync(partial, target);
    } finally {
      rmSync(partial, { force: true });
    }
  }
}

/** Make `pkg`'s `artefacts/` hold exactly the pinned files. Returns the names it had to (re)write. */
export async function ensureArtefacts(pkg: ArtefactPackage): Promise<string[]> {
  const dir = artefactDir(pkg);
  const problems = await verifyArtefacts(pkg);
  if (problems.length === 0) return [];
  // Before any fetch that may fail: a wrong file must not outlive this run.
  discardMismatchedArtefacts(problems, dir);
  const stale = problems.map((problem) => problem.name);
  await extract(pkg, stale);
  const remaining = await verifyArtefacts(pkg);
  if (remaining.length > 0) {
    discardMismatchedArtefacts(remaining, dir);
    throw new Error(`artefacts still fail verification after extraction: ${JSON.stringify(remaining)}`);
  }
  return stale;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify-only");
  const requested = args.filter((arg) => arg !== "--verify-only");
  try {
    const packages = requested.length > 0 ? requested.map(artefactPackage) : ARTEFACT_PACKAGES;
    for (const pkg of packages) {
      if (verifyOnly) {
        await assertArtefactsVerified(pkg);
        console.log(`pgwasm-artefacts: ${pkg.packageDir}: all pinned artefacts present and verified.`);
        continue;
      }
      const written = await ensureArtefacts(pkg);
      console.log(
        written.length === 0
          ? `pgwasm-artefacts: ${pkg.packageDir}: all pinned artefacts present and verified.`
          : `pgwasm-artefacts: ${pkg.packageDir}: fetched and verified ${written.join(", ")}.`,
      );
    }
  } catch (error) {
    console.error(`pgwasm-artefacts: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

#!/usr/bin/env bun
/**
 * Fetch and verify the pinned artefacts of every build package (`@pgxsinkit/pgwasm-c`,
 * `@pgxsinkit/pgwasm-pg-dump`; ADR-0062 decision 9, ADR-0064).
 *
 * Each package pins its artefacts, by size and sha256, to one pgwasm-postgres GitHub release in its own
 * `src/artefact-pins.ts` (written by `bun run pgwasm:pin <tag>`); they are never committed. This script,
 * run as the root `postinstall`, makes each package's `artefacts/` hold exactly the pinned files:
 *
 *   1. a file already there with the pinned size and sha256 is left alone (no network);
 *   2. otherwise the release asset of the same name is taken from `.buildcache/pgwasm-artefacts/`, or
 *      downloaded into it, and checked against its pinned size and sha256;
 *   3. the checked asset then replaces the file in `artefacts/`.
 *
 * Every package's `artefacts/` is verified, and every file failing its pin deleted, before anything is
 * fetched for any package, so a run that then fails (no network, a bad asset) leaves each such file
 * missing rather than wrong, in every package: nothing that does not match a pin is kept. Every write
 * (the cache's and `artefacts/`') goes to a `.part` name and is renamed into place only once its content
 * has matched the pin. Any mismatch fails the run with the file, the expected and the actual digest.
 * `--verify-only [packageDir…]` checks `artefacts/` without fetching, deleting mismatching files the same
 * way and failing with every package's problems (`build:public-packages` verifies each package before
 * bundling it).
 */

import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import {
  ARTEFACT_FILES as C_BUILD_ARTEFACTS,
  ARTEFACT_RELEASE as C_BUILD_RELEASE,
} from "../packages/pgwasm-c/src/artefact-pins";
import {
  ARTEFACT_FILES as PG_DUMP_ARTEFACTS,
  ARTEFACT_RELEASE as PG_DUMP_RELEASE,
} from "../packages/pgwasm-pg-dump/src/artefact-pins";

/** The GitHub release a package's artefacts are assets of. */
export interface ArtefactRelease {
  /** `owner/name` on GitHub. */
  readonly repository: string;
  readonly tag: string;
}

/** A pinned file: the release asset of the same name, byte for byte. */
export interface ArtefactPin {
  readonly bytes: number;
  readonly sha256: string;
}

/** A build package and its pinned artefacts, by file name in its `artefacts/`. */
export interface ArtefactPackage {
  readonly packageDir: string;
  readonly release: ArtefactRelease;
  readonly files: Readonly<Record<string, ArtefactPin>>;
}

export const ARTEFACT_PACKAGES: readonly ArtefactPackage[] = [
  { packageDir: "packages/pgwasm-c", release: C_BUILD_RELEASE, files: C_BUILD_ARTEFACTS },
  { packageDir: "packages/pgwasm-pg-dump", release: PG_DUMP_RELEASE, files: PG_DUMP_ARTEFACTS },
];

const repoRoot = path.resolve(import.meta.dir, "..");
const CACHE_DIR = path.join(repoRoot, ".buildcache/pgwasm-artefacts");
const DOWNLOAD_ATTEMPTS = 3;
/**
 * A download fails when no data arrives for this long. It bounds a stall, not the whole transfer: GitHub
 * serves release assets from a CDN whose throughput varies widely, and a slow link that keeps delivering
 * must still finish the 10 MB server.
 */
const DOWNLOAD_STALL_MS = 60_000;

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

/** Where GitHub serves a release's asset. */
export function releaseAssetUrl(release: ArtefactRelease, name: string): string {
  return `https://github.com/${release.repository}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(name)}`;
}

/** Where a release's asset is cached: by repository, tag and name, so no two releases share a file. */
export function cachedAssetPath(release: ArtefactRelease, name: string, cacheDir: string = CACHE_DIR): string {
  return path.join(cacheDir, ...release.repository.split("/"), release.tag, name);
}

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Write `bytes` to a `.part` name beside `target`, then rename it into place; no `.part` survives. */
async function writeAtomically(target: string, bytes: Uint8Array): Promise<void> {
  mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  try {
    await Bun.write(partial, bytes);
    renameSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }
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

export interface ArtefactRunOptions {
  /** Where a package's artefacts are: its own `artefacts/` unless given (a test's scratch directory). */
  readonly dirOf?: (pkg: ArtefactPackage) => string;
  /** Fetch the named pinned files of `pkg` into `dir`: from its release unless given. */
  readonly fetchPinned?: (pkg: ArtefactPackage, dir: string, names: readonly string[]) => Promise<void>;
}

/**
 * Verify every package, deleting each file that fails its pin, before anything is fetched for any of
 * them: a later failure (one package's fetch, offline) leaves no wrong file behind in another. Returns
 * each package's problems, in order.
 */
async function verifyAndDiscard(
  packages: readonly ArtefactPackage[],
  dirOf: (pkg: ArtefactPackage) => string,
): Promise<ArtefactProblem[][]> {
  const found: ArtefactProblem[][] = [];
  for (const pkg of packages) {
    const dir = dirOf(pkg);
    const problems = await verifyArtefacts(pkg, dir);
    discardMismatchedArtefacts(problems, dir);
    found.push(problems);
  }
  return found;
}

/** Throw, naming every package's problems, unless all of `packages`' artefacts are present and correct. */
export async function assertArtefactsVerified(
  packages: readonly ArtefactPackage[],
  { dirOf = artefactDir }: ArtefactRunOptions = {},
): Promise<void> {
  const found = await verifyAndDiscard(packages, dirOf);
  const failing = packages.flatMap((pkg, index) => {
    const problems = found[index] ?? [];
    return problems.length === 0
      ? []
      : [`${pkg.packageDir}/artefacts/: ${problems.map(({ name, problem }) => `${name}: ${problem}`).join("; ")}`];
  });
  if (failing.length > 0) {
    throw new Error(
      `the build packages' artefacts/ do not hold the pinned files; any that did not match were deleted ` +
        `(${failing.join(" | ")}). Run \`bun install\` (its postinstall fetches and verifies them).`,
    );
  }
}

export interface ReleaseFetchOptions {
  /** Where assets are cached: `.buildcache/pgwasm-artefacts/` unless given (a test's scratch directory). */
  readonly cacheDir?: string;
  /** Download one asset: from GitHub unless given (a test's stand-in for the network). */
  readonly download?: (url: string) => Promise<Uint8Array>;
}

async function downloadAsset(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  let stall: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    clearTimeout(stall);
    stall = setTimeout(
      () => controller.abort(new Error(`no data arrived for ${DOWNLOAD_STALL_MS / 1000} s`)),
      DOWNLOAD_STALL_MS,
    );
  };
  armStall();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    if (response.body === null) throw new Error("the response has no body");
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) {
      chunks.push(chunk);
      armStall();
    }
    return new Uint8Array(Bun.concatArrayBuffers(chunks));
  } finally {
    clearTimeout(stall);
  }
}

/** A cached asset that still matches its pin; one that does not is deleted. */
async function readCachedAsset(cached: string, pin: ArtefactPin): Promise<Uint8Array | undefined> {
  const file = Bun.file(cached);
  if (!(await file.exists())) return undefined;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mismatch = describeMismatch(pin, bytes);
  if (mismatch === undefined) return bytes;
  console.warn(`pgwasm-artefacts: the cached ${cached} fails its pin (${mismatch}); fetching it again.`);
  rmSync(cached, { force: true });
  return undefined;
}

/** The asset's bytes, downloaded and checked against its pin (retried), then cached. */
async function fetchAsset(
  release: ArtefactRelease,
  name: string,
  pin: ArtefactPin,
  cacheDir: string,
  download: (url: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const cached = cachedAssetPath(release, name, cacheDir);
  const url = releaseAssetUrl(release, name);
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const bytes = await download(url);
      const mismatch = describeMismatch(pin, bytes);
      if (mismatch !== undefined) throw new Error(`the asset does not match its pin: ${mismatch}`);
      await writeAtomically(cached, bytes);
      return bytes;
    } catch (error) {
      lastError = error;
      console.warn(
        `pgwasm-artefacts: download attempt ${attempt}/${DOWNLOAD_ATTEMPTS} of ${url} failed: ${String(error)}`,
      );
    }
  }
  throw new Error(
    `could not download ${url} (${String(lastError)}). The build packages' artefacts are fetched once and then ` +
      `cached in ${path.relative(repoRoot, cacheDir)}/; run \`bun install\` ` +
      `again with network access.`,
    { cause: lastError },
  );
}

/**
 * Fetch the named pinned files of `pkg` into `dir`: each is its release's asset of the same name, taken
 * from the cache or downloaded into it, and checked against its pinned size and sha256 before it
 * replaces the file in `dir`.
 */
export async function fetchReleaseAssets(
  pkg: ArtefactPackage,
  dir: string,
  names: readonly string[],
  { cacheDir = CACHE_DIR, download = downloadAsset }: ReleaseFetchOptions = {},
): Promise<void> {
  for (const name of names) {
    const pin = pkg.files[name];
    if (pin === undefined) throw new Error(`${pkg.packageDir} pins no artefact ${name}`);
    const cached = cachedAssetPath(pkg.release, name, cacheDir);
    const bytes =
      (await readCachedAsset(cached, pin)) ?? (await fetchAsset(pkg.release, name, pin, cacheDir, download));
    await writeAtomically(path.join(dir, name), bytes);
  }
}

/**
 * Make every package's artefacts hold exactly its pinned files. Every package is verified, and every
 * mismatching file deleted, before anything is fetched. Returns, per package in order, the names it had
 * to (re)write.
 */
export async function ensureArtefacts(
  packages: readonly ArtefactPackage[],
  { dirOf = artefactDir, fetchPinned = fetchReleaseAssets }: ArtefactRunOptions = {},
): Promise<string[][]> {
  // Before any fetch that may fail: no wrong file, in any package, may outlive this run.
  const found = await verifyAndDiscard(packages, dirOf);
  const written: string[][] = [];
  for (const [index, pkg] of packages.entries()) {
    const stale = (found[index] ?? []).map((problem) => problem.name);
    if (stale.length > 0) {
      const dir = dirOf(pkg);
      await fetchPinned(pkg, dir, stale);
      const remaining = await verifyArtefacts(pkg, dir);
      if (remaining.length > 0) {
        discardMismatchedArtefacts(remaining, dir);
        throw new Error(
          `${pkg.packageDir}: artefacts still fail verification after fetching: ${JSON.stringify(remaining)}`,
        );
      }
    }
    written.push(stale);
  }
  return written;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify-only");
  const requested = args.filter((arg) => arg !== "--verify-only");
  try {
    const packages = requested.length > 0 ? requested.map(artefactPackage) : ARTEFACT_PACKAGES;
    // Verify-only fails naming every package's problems; nothing is written either way when it passes.
    const written: readonly string[][] = verifyOnly
      ? await assertArtefactsVerified(packages).then(() => [])
      : await ensureArtefacts(packages);
    for (const [index, pkg] of packages.entries()) {
      const names = written[index] ?? [];
      console.log(
        names.length === 0
          ? `pgwasm-artefacts: ${pkg.packageDir}: all pinned artefacts present and verified.`
          : `pgwasm-artefacts: ${pkg.packageDir}: fetched and verified ${names.join(", ")}.`,
      );
    }
  } catch (error) {
    console.error(`pgwasm-artefacts: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

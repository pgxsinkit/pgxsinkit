#!/usr/bin/env bun
/**
 * `bun run pgwasm:pin <tag>`: pin both build packages to one pgwasm-postgres release (ADR-0064).
 *
 * It downloads the release's `manifest.json` and `SHA256SUMS`, checks that they agree (SHA256SUMS lists
 * the manifest's own sha256 and exactly the files the manifest does, with the same digests), and rewrites
 * `packages/pgwasm-c/src/artefact-pins.ts` and `packages/pgwasm-pg-dump/src/artefact-pins.ts` from that
 * one release: pg_dump always ships with its server, since it refuses a newer one. The C build's identity
 * (`C_BUILD_IDENTITY`) takes its `release` ("pgwasm-postgres <tag>") and `dataFormat` from the C build's
 * pins, so the pin carries both. It refuses a release whose data format differs from the current one.
 *
 * It only writes the pins; the root `postinstall` (`scripts/pgwasm-artefacts.ts`) then fetches and
 * verifies the files. There is no cross-repository automation: adopting a release is this command, the
 * fetch, and the contract gate on the resulting change.
 */

import path from "node:path";

import { ARTEFACT_RELEASE as CURRENT_RELEASE } from "../packages/pgwasm-c/src/artefact-pins";
import { releaseAssetUrl, sha256, type ArtefactPin } from "./pgwasm-artefacts";

export const RELEASE_REPOSITORY = "pgxsinkit/pgwasm-postgres";

/** The assets each build package takes from a release, by package directory. */
export const PINNED_ASSETS: Readonly<Record<string, readonly string[]>> = {
  "packages/pgwasm-c": [
    "amcheck.tar.gz",
    "initdb.js",
    "initdb.wasm",
    "pglite.data",
    "pglite.js",
    "pglite.wasm",
    "prepopulated.tar.gz",
  ],
  "packages/pgwasm-pg-dump": ["pg_dump.js", "pg_dump.wasm"],
};

/** What the pins record of the release they come from. */
export interface PinnedRelease {
  readonly repository: string;
  readonly tag: string;
  /** The build's name, as version() and `C_BUILD_IDENTITY.release` carry it. */
  readonly name: string;
  readonly commit: string;
  readonly upstream: { readonly tag: string; readonly commit: string };
  readonly dataFormat: number;
  readonly builderImage: string;
  readonly manifestSha256: string;
}

export interface CheckedRelease {
  readonly release: PinnedRelease;
  readonly files: ReadonlyMap<string, ArtefactPin>;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const HEX_COMMIT = /^[0-9a-f]{40}$/;

/** `SHA256SUMS` (`sha256sum` output: `<hex>  <name>` per line), by name. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{64}) [ *](\S.*)$/.exec(line);
    if (match === null) throw new Error(`SHA256SUMS has a malformed line: ${JSON.stringify(line)}`);
    const [, digest = "", name = ""] = match;
    if (sums.has(name)) throw new Error(`SHA256SUMS lists ${name} twice`);
    sums.set(name, digest);
  }
  return sums;
}

function field<T>(value: unknown, what: string, check: (value: unknown) => value is T): T {
  if (!check(value)) throw new Error(`manifest.json: ${what} is missing or malformed (${JSON.stringify(value)})`);
  return value;
}

const isString = (value: unknown): value is string => typeof value === "string" && value !== "";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const matching =
  (pattern: RegExp) =>
  (value: unknown): value is string =>
    typeof value === "string" && pattern.test(value);
const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/**
 * Check a release's manifest against its SHA256SUMS and the tag it was fetched by, and return what the pins
 * take from it. Throws, naming the disagreement, unless the two list the same files with the same digests,
 * SHA256SUMS holds the manifest's own digest, and the release has every asset a build package pins.
 */
export function checkRelease(tag: string, manifestBytes: Uint8Array, sumsText: string): CheckedRelease {
  const sums = parseSha256Sums(sumsText);
  const manifestSha256 = sha256(manifestBytes);
  if (sums.get("manifest.json") !== manifestSha256) {
    throw new Error(
      `SHA256SUMS gives manifest.json as ${sums.get("manifest.json") ?? "(absent)"}, but its sha256 is ${manifestSha256}`,
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch (error) {
    throw new Error("manifest.json is not JSON", { cause: error });
  }
  const root = field(manifest, "the manifest", isRecord);
  const version = field(root["version"], "version", isString);
  if (version !== tag) throw new Error(`manifest.json is for release ${version}, not ${tag}`);
  const upstream = field(root["upstream"], "upstream", isRecord);
  const builder = field(root["builder"], "builder", isRecord);
  const dataFormat = field(root["dataFormat"], "dataFormat", isPositiveInteger);

  const files = new Map<string, ArtefactPin>();
  for (const [index, entry] of field(root["files"], "files", Array.isArray).entries()) {
    const file = field(entry, `files[${index}]`, isRecord);
    const name = field(file["name"], `files[${index}].name`, isString);
    if (files.has(name) || name === "manifest.json") throw new Error(`manifest.json lists ${name} twice`);
    files.set(name, {
      bytes: field(file["bytes"], `${name}'s bytes`, isPositiveInteger),
      sha256: field(file["sha256"], `${name}'s sha256`, matching(HEX_SHA256)),
    });
  }
  for (const [name, pin] of files) {
    const listed = sums.get(name);
    if (listed !== pin.sha256) {
      throw new Error(`manifest.json gives ${name} as ${pin.sha256}, SHA256SUMS as ${listed ?? "(absent)"}`);
    }
  }
  const unlisted = [...sums.keys()].filter((name) => name !== "manifest.json" && !files.has(name));
  if (unlisted.length > 0) throw new Error(`SHA256SUMS lists files manifest.json does not: ${unlisted.join(", ")}`);
  const missing = Object.values(PINNED_ASSETS)
    .flat()
    .filter((name) => !files.has(name));
  if (missing.length > 0) throw new Error(`release ${tag} has no ${missing.join(", ")}`);

  return {
    release: {
      repository: RELEASE_REPOSITORY,
      tag,
      name: `pgwasm-postgres ${tag}`,
      commit: field(root["commit"], "commit", matching(HEX_COMMIT)),
      upstream: {
        tag: field(upstream["tag"], "upstream.tag", isString),
        commit: field(upstream["commit"], "upstream.commit", matching(HEX_COMMIT)),
      },
      dataFormat,
      builderImage: field(builder["image"], "builder.image", isString),
      manifestSha256,
    },
    files,
  };
}

/**
 * Refuse a release whose data format is not the current one: a data directory is only ever opened by a
 * build of its own format (ADR-0063), and how existing stores cross a format change is still open.
 */
export function assertSameDataFormat(release: PinnedRelease, currentDataFormat: number): void {
  if (release.dataFormat === currentDataFormat) return;
  throw new Error(
    `release ${release.tag} declares dataFormat ${release.dataFormat}, but the C build's identity is dataFormat ` +
      `${currentDataFormat}. Every existing store was written in dataFormat ${currentDataFormat} and would no ` +
      `longer open. Crossing a data format is ADR-0064's open question (destroy and re-sync gated on a drained ` +
      `Outbox, or an in-browser dump/restore that loads both builds once); it must be decided, and implemented, ` +
      `before a release of another data format can be pinned.`,
  );
}

const HEADERS: Readonly<Record<string, string>> = {
  "packages/pgwasm-c": `/**
 * The C build's artefacts, pinned by release and checksum (ADR-0062 decision 9, ADR-0064).
 *
 * Written by \`bun run pgwasm:pin <tag>\`; never edit it by hand. The files are the assets of one
 * pgxsinkit/pgwasm-postgres GitHub release, built from PostgreSQL plus patches derived from ElectricSQL's
 * postgres-pglite (PostgreSQL License). They are not in git: \`scripts/pgwasm-artefacts.ts\` (the root
 * \`postinstall\`) downloads each asset into \`packages/pgwasm-c/artefacts/\` and checks it against its bytes
 * and sha256 below. The published package carries the files themselves. \`C_BUILD_IDENTITY\` takes its
 * \`release\` and \`dataFormat\` from \`ARTEFACT_RELEASE\`.
 */
`,
  "packages/pgwasm-pg-dump": `/**
 * \`pg_dump\`'s artefacts, pinned by release and checksum (ADR-0062 decision 9, ADR-0064).
 *
 * Written by \`bun run pgwasm:pin <tag>\`, from the same pgxsinkit/pgwasm-postgres release as the C build's
 * (pg_dump refuses a server newer than itself, so it always ships with its server); never edit it by hand.
 * They are not in git: \`scripts/pgwasm-artefacts.ts\` (the root \`postinstall\`) downloads each asset into
 * \`packages/pgwasm-pg-dump/artefacts/\` and checks it against its bytes and sha256 below. The published
 * package carries the files.
 */
`,
};

/** The formatter's line width (`.oxfmtrc.jsonc`): the rendered pins are already formatted. */
const PRINT_WIDTH = 120;

/** `key: value,` at `indent`, on one line when it fits, else with the value on the next (as oxfmt breaks it). */
function property(indent: string, key: string, value: string): string[] {
  const line = `${indent}${key}: ${value},`;
  return line.length <= PRINT_WIDTH ? [line] : [`${indent}${key}:`, `${indent}  ${value},`];
}

/** A file's pin on one line when it fits, else expanded (as oxfmt breaks it). */
function filePin(name: string, pin: ArtefactPin): string[] {
  const key = JSON.stringify(name);
  const line = `  ${key}: { bytes: ${pin.bytes}, sha256: ${JSON.stringify(pin.sha256)} },`;
  if (line.length <= PRINT_WIDTH) return [line];
  return [`  ${key}: {`, `    bytes: ${pin.bytes},`, `    sha256: ${JSON.stringify(pin.sha256)},`, "  },"];
}

/** The text of `packageDir`'s `src/artefact-pins.ts` for a checked release. */
export function renderPins(packageDir: string, { release, files }: CheckedRelease): string {
  const header = HEADERS[packageDir];
  const names = PINNED_ASSETS[packageDir];
  if (header === undefined || names === undefined) throw new Error(`${packageDir} pins no artefacts`);
  const fileLines = [...names].sort().flatMap((name) => {
    const pin = files.get(name);
    if (pin === undefined) throw new Error(`release ${release.tag} has no ${name}`);
    return filePin(name, pin);
  });
  const upstream = `{ tag: ${JSON.stringify(release.upstream.tag)}, commit: ${JSON.stringify(release.upstream.commit)} }`;
  return [
    header,
    "/** The release the files are assets of. */",
    "export const ARTEFACT_RELEASE = {",
    ...property("  ", "repository", JSON.stringify(release.repository)),
    ...property("  ", "tag", JSON.stringify(release.tag)),
    ...property("  ", "name", JSON.stringify(release.name)),
    ...property("  ", "commit", JSON.stringify(release.commit)),
    ...property("  ", "upstream", upstream),
    ...property("  ", "dataFormat", String(release.dataFormat)),
    ...property("  ", "builderImage", JSON.stringify(release.builderImage)),
    ...property("  ", "manifestSha256", JSON.stringify(release.manifestSha256)),
    "} as const;",
    "",
    "/** Every pinned file, by its name in `artefacts/` (the release asset of the same name). */",
    "export const ARTEFACT_FILES = {",
    ...fileLines,
    "} as const;",
    "",
    "export type ArtefactName = keyof typeof ARTEFACT_FILES;",
    "",
  ].join("\n");
}

export interface PinOptions {
  /** Download one release file: from GitHub unless given. */
  readonly download?: (url: string) => Promise<Uint8Array>;
  /** The current data format: the C build's identity's unless given. */
  readonly currentDataFormat?: number;
  /** Write one pins file: to the repository unless given. */
  readonly write?: (packageDir: string, text: string) => Promise<void>;
}

async function downloadReleaseFile(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`could not download ${url}: HTTP ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}

const repoRoot = path.resolve(import.meta.dir, "..");

/** Pin both build packages to release `tag`. Nothing is written unless every check passes. */
export async function pinRelease(
  tag: string,
  {
    download = downloadReleaseFile,
    currentDataFormat = CURRENT_RELEASE.dataFormat,
    write = (packageDir, text) =>
      Bun.write(path.join(repoRoot, packageDir, "src/artefact-pins.ts"), text).then(() => {}),
  }: PinOptions = {},
): Promise<CheckedRelease> {
  const location = { repository: RELEASE_REPOSITORY, tag };
  const manifest = await download(releaseAssetUrl(location, "manifest.json"));
  const sums = new TextDecoder().decode(await download(releaseAssetUrl(location, "SHA256SUMS")));
  const checked = checkRelease(tag, manifest, sums);
  assertSameDataFormat(checked.release, currentDataFormat);
  const rendered = Object.keys(PINNED_ASSETS).map(
    (packageDir) => [packageDir, renderPins(packageDir, checked)] as const,
  );
  for (const [packageDir, text] of rendered) await write(packageDir, text);
  return checked;
}

if (import.meta.main) {
  const [tag, ...rest] = process.argv.slice(2);
  if (tag === undefined || rest.length > 0 || !/^\d+\.\d+\.\d+$/.test(tag)) {
    console.error("usage: bun run pgwasm:pin <tag>   (a pgxsinkit/pgwasm-postgres release, e.g. 18.3.0)");
    process.exit(2);
  }
  try {
    const { release } = await pinRelease(tag);
    console.log(
      `pgwasm:pin: pinned packages/pgwasm-c and packages/pgwasm-pg-dump to ${release.name} ` +
        `(PostgreSQL ${release.upstream.tag}, dataFormat ${release.dataFormat}). Run \`bun run postinstall\` to fetch.`,
    );
  } catch (error) {
    console.error(`pgwasm:pin: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

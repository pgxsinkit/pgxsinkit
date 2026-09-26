/**
 * The build marker (ADR-0063 decision 1, build permanence).
 *
 * pgwasm records the Postgres build in every data directory it creates, as the file `PGWASM_BUILD` in
 * the data directory itself (next to `PG_VERSION`), so it works on every storage and travels inside
 * every Store backup. Its content is one line of JSON:
 *
 *     {"pgwasm":1,"build":"c","dataFormat":1}
 *
 * `pgwasm` is the marker's own format version; a newer one than this release knows is unreadable
 * (fail closed). A directory without a marker predates marking: it is the C build's, which the build
 * says through `claimsUnmarkedDirectories` rather than shared code naming a build. Existing unmarked
 * directories are never backfilled; only a directory pgwasm creates gets a marker.
 */

import type { BuildIdentity, DataDirEntry } from "../build/seam";
import { BuildMarkerUnreadableError, BuildMismatchError, DataFormatMismatchError, type RecordedBuild } from "../errors";

/** The marker's path inside the data directory. */
export const BUILD_MARKER_PATH = "/PGWASM_BUILD";
/** Postgres' own version file: its presence means the directory holds a cluster. */
export const PG_VERSION_PATH = "/PG_VERSION";

const MARKER_FORMAT = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The marker's bytes for a build. */
export function encodeBuildMarker(build: BuildIdentity): Uint8Array {
  return encoder.encode(
    `${JSON.stringify({ pgwasm: MARKER_FORMAT, build: build.name, dataFormat: build.dataFormat })}\n`,
  );
}

/** Parse a marker; throws {@link BuildMarkerUnreadableError} for anything but a valid one. */
export function decodeBuildMarker(bytes: Uint8Array): { build: string; dataFormat: number } {
  const raw = decoder.decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BuildMarkerUnreadableError(raw, "not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BuildMarkerUnreadableError(raw, "not a JSON object");
  }
  const { pgwasm, build, dataFormat } = parsed as Record<string, unknown>;
  if (typeof pgwasm !== "number" || !Number.isInteger(pgwasm) || pgwasm < 1) {
    throw new BuildMarkerUnreadableError(raw, "no marker format version");
  }
  if (pgwasm > MARKER_FORMAT) {
    throw new BuildMarkerUnreadableError(raw, `marker format ${pgwasm} is newer than this pgwasm reads`);
  }
  if (typeof build !== "string" || build === "") {
    throw new BuildMarkerUnreadableError(raw, "no build name");
  }
  if (typeof dataFormat !== "number" || !Number.isInteger(dataFormat) || dataFormat < 1) {
    throw new BuildMarkerUnreadableError(raw, "no data format");
  }
  return { build, dataFormat };
}

/**
 * Check what a data directory or backup records against the build about to open it. `marker` is the
 * marker's bytes (absent when there is none); `hasCluster` is whether `PG_VERSION` exists. Throws the
 * typed refusal when the build may not open it.
 */
export function checkBuildMarker(
  build: BuildIdentity,
  marker: Uint8Array | undefined,
  hasCluster: boolean,
  source: "data-directory" | "backup",
): void {
  if (marker === undefined) {
    if (hasCluster && !build.claimsUnmarkedDirectories) {
      throw new BuildMismatchError(build, "unmarked", source);
    }
    return;
  }
  const recorded = decodeBuildMarker(marker);
  if (recorded.build !== build.name) {
    const found: RecordedBuild = recorded;
    throw new BuildMismatchError(build, found, source);
  }
  if (recorded.dataFormat !== build.dataFormat) {
    throw new DataFormatMismatchError(build, recorded.dataFormat, source);
  }
}

/** The marker entry of a data-directory image, if it has one. */
export function findEntry(entries: readonly DataDirEntry[], path: string): DataDirEntry | undefined {
  return entries.find((entry) => entry.path === path && entry.type === "file");
}

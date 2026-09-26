/**
 * Store backups: a data directory as a tarball (ADR-0035). pgwasm owns the format so every build
 * produces the same artefact: ustar, entry names relative to the data directory with a leading `/`,
 * a directory before its contents, optionally gzipped. Backups written by earlier releases restore.
 */

import type { DataDirEntry } from "../build/seam";
import { BackupFormatError } from "../errors";
import type { DumpCompression } from "../interface";
import { gunzipIfCompressed, gzip } from "../tar/gzip";
import { readTar, TarFormatError, writeTar, type TarEntry } from "../tar/tar";

/**
 * Normalize a backup member's name to a data-directory path: a leading `/`, no trailing `/`, no empty,
 * `.` or `..` segments. A name that would leave the data directory is refused.
 */
export function normalizeDataDirPath(name: string): string {
  const segments = name.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new BackupFormatError(`the backup member "${name}" points outside the data directory`);
  }
  return `/${segments.join("/")}`;
}

/** Read a Store backup (gzipped or not, whatever its MIME type or name says) into entries. */
export async function readDataDirArchive(archive: Blob): Promise<DataDirEntry[]> {
  const bytes = await gunzipIfCompressed(new Uint8Array(await archive.arrayBuffer()));
  let members: TarEntry[];
  try {
    members = readTar(bytes);
  } catch (error) {
    if (error instanceof TarFormatError) {
      throw new BackupFormatError(`the Store backup is not a readable tarball: ${error.message}`, { cause: error });
    }
    throw error;
  }
  const entries: DataDirEntry[] = [];
  for (const entry of members) {
    const path = normalizeDataDirPath(entry.name);
    if (path === "/") continue;
    entries.push({ path, type: entry.type, mode: entry.mode, mtimeSeconds: entry.mtimeSeconds, data: entry.data });
  }
  return entries;
}

/** Write entries as a Store backup `File`, named `<baseName>.tar` or `<baseName>.tar.gz`. */
export async function writeDataDirArchive(
  entries: readonly DataDirEntry[],
  baseName: string,
  compression: DumpCompression = "auto",
): Promise<File> {
  const tarball = writeTar(
    entries.map((entry) => ({
      name: entry.path,
      type: entry.type,
      mode: entry.mode,
      mtimeSeconds: entry.mtimeSeconds,
      data: entry.data,
    })),
  );
  if (compression === "none") {
    return new File([tarball.slice()], `${baseName}.tar`, { type: "application/x-tar" });
  }
  return new File([await gzip(tarball)], `${baseName}.tar.gz`, { type: "application/x-gzip" });
}

import { describe, expect, it } from "bun:test";

import {
  BackupFormatError,
  BuildMarkerUnreadableError,
  BuildMismatchError,
  createPgwasm,
  CrossOriginIsolationRequiredError,
  DataFormatMismatchError,
  ExtensionBuildMismatchError,
  OpfsAhpRemovedError,
  UnsupportedDataDirError,
  UnsupportedFilesystemError,
} from "../../packages/pgwasm/src";
import { writeDataDirArchive } from "../../packages/pgwasm/src/core/data-dir-archive";
import { decodeBuildMarker, encodeBuildMarker } from "../../packages/pgwasm/src/core/marker";
import { createSpyBuild, SpyStartReachedError } from "./support/pgwasm-spy-build";
import { rejectionOf } from "./support/rejection";

const encoder = new TextEncoder();
const PG_VERSION = encoder.encode("18\n");

function marker(build: string, dataFormat = 1): Uint8Array {
  return encoder.encode(`${JSON.stringify({ pgwasm: 1, build, dataFormat })}\n`);
}

/** Every seam call that writes to the data directory or starts Postgres. */
const WRITES = ["createCluster", "writeEntries", "writeFile /PGWASM_BUILD", "persist", "start"];

describe("createPgwasm option checks, before anything boots", () => {
  it("refuses opfs-ahp:// with a typed error naming the replacement", async () => {
    const build = createSpyBuild();
    const error = await createPgwasm({ build, dataDir: "opfs-ahp://store" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OpfsAhpRemovedError);
    expect(error).toBeInstanceOf(UnsupportedDataDirError);
    expect((error as Error).message).toContain("@pgxsinkit/pgwasm/opfs");
    expect((error as OpfsAhpRemovedError).replacement).toBe("@pgxsinkit/pgwasm/opfs");
    expect(build.calls).toEqual([]);
  });

  it("requires a scheme and refuses unknown ones", async () => {
    const build = createSpyBuild();
    expect((await rejectionOf(createPgwasm({ build, dataDir: "./pgdata" }))).message).toMatch(/a scheme is required/);
    expect((await rejectionOf(createPgwasm({ build, dataDir: "opfs://store" }))).message).toMatch(
      /unknown scheme "opfs:\/\/"/,
    );
    expect(await rejectionOf(createPgwasm({ build, dataDir: "idb://" }))).toBeInstanceOf(UnsupportedDataDirError);
    expect(build.calls).toEqual([]);
  });

  it("refuses dataDir together with fs", async () => {
    const build = createSpyBuild();
    const fs = {} as never;
    expect((await rejectionOf(createPgwasm({ build, dataDir: "memory://", fs }))).message).toMatch(/exclusive/);
  });

  it("refuses storage the build does not mount", async () => {
    const build = createSpyBuild({ capabilities: { filesystems: ["memory"] } });
    const error = await createPgwasm({ build, dataDir: "idb://store" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UnsupportedFilesystemError);
    expect((error as Error).message).toContain('"spy" Postgres build does not support idb storage');
    expect(build.calls).toEqual([]);
  });

  it("refuses a build that needs cross-origin isolation in a context without it", async () => {
    const build = createSpyBuild({ capabilities: { requiresCrossOriginIsolation: true } });
    const scope = globalThis as { crossOriginIsolated?: boolean };
    const before = scope.crossOriginIsolated;
    scope.crossOriginIsolated = false;
    try {
      expect(await rejectionOf(createPgwasm({ build }))).toBeInstanceOf(CrossOriginIsolationRequiredError);
    } finally {
      if (before === undefined) delete scope.crossOriginIsolated;
      else scope.crossOriginIsolated = before;
    }
    expect(build.calls).toEqual([]);
  });

  it("refuses a server extension compiled for another build", async () => {
    const build = createSpyBuild();
    const extension = { kind: "server", name: "amcheck", build: "c", bundle: new URL("file:///x.tar.gz") } as const;
    expect(await rejectionOf(createPgwasm({ build, extensions: { extension } }))).toBeInstanceOf(
      ExtensionBuildMismatchError,
    );
    expect(build.calls).toEqual([]);
  });

  it("refuses a value that is not a build", async () => {
    expect((await rejectionOf(createPgwasm({ build: {} as never }))).message).toMatch(/needs a Postgres build/);
  });

  it("passes a server extension's preload libraries to the build as settings, merged", async () => {
    const build = createSpyBuild({ files: { "/PG_VERSION": PG_VERSION, "/PGWASM_BUILD": marker("spy") } });
    const extension = {
      kind: "server",
      name: "ext",
      build: "spy",
      bundle: new URL("file:///x.tar.gz"),
      sharedPreloadLibraries: ["ext"],
    } as const;
    expect(
      await rejectionOf(
        createPgwasm({ build, extensions: { extension }, settings: { shared_preload_libraries: "other, ext" } }),
      ),
    ).toBeInstanceOf(SpyStartReachedError);
    expect(build.bootRequests[0]?.extensions).toEqual([extension]);
  });
});

describe("build permanence before anything is written (ADR-0063)", () => {
  it("refuses a directory marked by another build, then releases it", async () => {
    const build = createSpyBuild({ files: { "/PG_VERSION": PG_VERSION, "/PGWASM_BUILD": marker("pgrust") } });
    const error = await createPgwasm({ build, dataDir: "idb://store" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BuildMismatchError);
    expect((error as BuildMismatchError).found).toEqual({ build: "pgrust", dataFormat: 1 });
    expect((error as BuildMismatchError).source).toBe("data-directory");
    expect(build.calls).toContain("release");
    expect(build.calls.filter((call) => WRITES.includes(call))).toEqual([]);
  });

  it("refuses an unmarked cluster when the build does not claim unmarked directories", async () => {
    const build = createSpyBuild({ files: { "/PG_VERSION": PG_VERSION } });
    const error = await createPgwasm({ build }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BuildMismatchError);
    expect((error as BuildMismatchError).found).toBe("unmarked");
    expect(build.calls.filter((call) => WRITES.includes(call))).toEqual([]);
  });

  it("opens an unmarked cluster when the build claims them, and writes nothing to it", async () => {
    const build = createSpyBuild({
      identity: { claimsUnmarkedDirectories: true },
      files: { "/PG_VERSION": PG_VERSION },
    });
    expect(await rejectionOf(createPgwasm({ build }))).toBeInstanceOf(SpyStartReachedError);
    expect(build.calls.filter((call) => WRITES.includes(call))).toEqual(["start"]);
  });

  it("refuses the same build in another data format", async () => {
    const build = createSpyBuild({ files: { "/PG_VERSION": PG_VERSION, "/PGWASM_BUILD": marker("spy", 2) } });
    expect(await rejectionOf(createPgwasm({ build }))).toBeInstanceOf(DataFormatMismatchError);
    expect(build.calls.filter((call) => WRITES.includes(call))).toEqual([]);
  });

  it("refuses a corrupt marker and a marker from a newer pgwasm", async () => {
    for (const bytes of [encoder.encode("not json"), encoder.encode('{"pgwasm":2,"build":"spy","dataFormat":1}')]) {
      const build = createSpyBuild({ files: { "/PG_VERSION": PG_VERSION, "/PGWASM_BUILD": bytes } });
      expect(await rejectionOf(createPgwasm({ build }))).toBeInstanceOf(BuildMarkerUnreadableError);
      expect(build.calls.filter((call) => WRITES.includes(call))).toEqual([]);
    }
  });

  it("creates and marks a new data directory before starting", async () => {
    const build = createSpyBuild();
    expect(await rejectionOf(createPgwasm({ build }))).toBeInstanceOf(SpyStartReachedError);
    expect(build.calls.filter((call) => WRITES.includes(call))).toEqual([
      "createCluster",
      "writeFile /PGWASM_BUILD",
      "persist",
      "start",
    ]);
  });

  it("refuses another build's Store backup before booting at all", async () => {
    const build = createSpyBuild();
    const backup = await writeDataDirArchive(
      [
        { path: "/PG_VERSION", type: "file", mode: 0o600, mtimeSeconds: 0, data: PG_VERSION },
        { path: "/PGWASM_BUILD", type: "file", mode: 0o600, mtimeSeconds: 0, data: marker("pgrust") },
      ],
      "store",
    );
    const error = await createPgwasm({ build, loadDataDir: backup }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BuildMismatchError);
    expect((error as BuildMismatchError).source).toBe("backup");
    expect(build.calls).toEqual([]);
  });

  it("marks a restored unmarked backup when the build claims unmarked directories", async () => {
    const build = createSpyBuild({ identity: { claimsUnmarkedDirectories: true } });
    const backup = await writeDataDirArchive(
      [{ path: "/PG_VERSION", type: "file", mode: 0o600, mtimeSeconds: 0, data: PG_VERSION }],
      "store",
      "none",
    );
    expect(await rejectionOf(createPgwasm({ build, loadDataDir: backup }))).toBeInstanceOf(SpyStartReachedError);
    const written = build.writtenEntries[0] ?? [];
    expect(written.map((entry) => entry.path)).toEqual(["/PG_VERSION", "/PGWASM_BUILD"]);
    expect(decodeBuildMarker(written[1]?.data ?? new Uint8Array())).toEqual({ build: "spy", dataFormat: 1 });
  });

  it("refuses a backup without a data directory, and one that escapes it", async () => {
    const build = createSpyBuild({ identity: { claimsUnmarkedDirectories: true } });
    const empty = await writeDataDirArchive([], "store");
    expect(await rejectionOf(createPgwasm({ build, loadDataDir: empty }))).toBeInstanceOf(BackupFormatError);
    const escaping = await writeDataDirArchive(
      [
        { path: "/PG_VERSION", type: "file", mode: 0o600, mtimeSeconds: 0, data: PG_VERSION },
        { path: "/../bin/postgres", type: "file", mode: 0o600, mtimeSeconds: 0, data: PG_VERSION },
      ],
      "store",
    );
    expect((await rejectionOf(createPgwasm({ build, loadDataDir: escaping }))).message).toMatch(
      /outside the data directory/,
    );
    expect(await rejectionOf(createPgwasm({ build, loadDataDir: new Blob(["not a tarball, at all"]) }))).toBeInstanceOf(
      BackupFormatError,
    );
    expect(build.calls).toEqual([]);
  });

  it("encodes the marker as one line of JSON", () => {
    const bytes = encodeBuildMarker({ name: "c", dataFormat: 1, claimsUnmarkedDirectories: true, release: "x" });
    expect(new TextDecoder().decode(bytes)).toBe('{"pgwasm":1,"build":"c","dataFormat":1}\n');
    expect(decodeBuildMarker(bytes)).toEqual({ build: "c", dataFormat: 1 });
  });
});

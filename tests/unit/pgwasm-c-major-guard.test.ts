import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

import { cBuild } from "../../packages/pgwasm-c/src";
import { DataFormatMismatchError } from "../../packages/pgwasm/src";
import type { DataDirEntry } from "../../packages/pgwasm/src/build";
import { writeDataDirArchive } from "../../packages/pgwasm/src/core/data-dir-archive";
import { closeTestPgwasms, createTestPgwasm, scratchDir } from "./support/pgwasm";
import { rejectionOf } from "./support/rejection";

afterEach(closeTestPgwasms);

const encoder = new TextEncoder();
const legacyMarker = '{"pgwasm":1,"build":"c","dataFormat":1}\n';
const claimedCurrentMarker = '{"pgwasm":1,"build":"c","dataFormat":2}\n';
const file = (path: string, text: string): DataDirEntry => ({
  path,
  type: "file",
  mode: 0o600,
  mtimeSeconds: 1,
  data: encoder.encode(text),
});

describe("the PG19 C build's legacy-store refusal", () => {
  for (const { kind, marker } of [
    { kind: "unmarked", marker: undefined },
    { kind: "marked format-1", marker: legacyMarker },
    { kind: "marked as format-2", marker: claimedCurrentMarker },
  ]) {
    it(`leaves an existing ${kind} PG18 directory intact`, async () => {
      const dir = scratchDir("pgwasm-pg18-refusal");
      try {
        const target = `${dir.path}/pg18`;
        mkdirSync(target);
        writeFileSync(`${target}/PG_VERSION`, "18\n");
        writeFileSync(`${target}/keep`, "PG18 content");
        if (marker !== undefined) writeFileSync(`${target}/PGWASM_BUILD`, marker);

        const error = await rejectionOf(createTestPgwasm({ dataDir: `file://${target}` }));
        expect(cBuild.identity.dataFormat).toBe(2);
        if (marker === legacyMarker) {
          expect(error).toBeInstanceOf(DataFormatMismatchError);
          expect((error as DataFormatMismatchError).found).toBe(1);
        } else {
          expect(error.message).toContain("requires PostgreSQL 19");
          expect(error.message).toContain('PG_VERSION is "18"');
        }
        expect(readFileSync(`${target}/PG_VERSION`, "utf8")).toBe("18\n");
        expect(readFileSync(`${target}/keep`, "utf8")).toBe("PG18 content");
        if (marker !== undefined) expect(readFileSync(`${target}/PGWASM_BUILD`, "utf8")).toBe(marker);
        expect(readdirSync(target).sort()).toEqual(
          marker === undefined ? ["PG_VERSION", "keep"] : ["PGWASM_BUILD", "PG_VERSION", "keep"],
        );
      } finally {
        dir.cleanup();
      }
    });

    it(`refuses a ${kind} PG18 backup before writing its first member`, async () => {
      const dir = scratchDir("pgwasm-pg18-backup-refusal");
      try {
        const target = `${dir.path}/fresh-pg19`;
        mkdirSync(target);
        writeFileSync(`${target}/keep`, "untouched destination");
        // Put an overwriting member first: startup-time validation would already be too late for NODEFS.
        const backup = await writeDataDirArchive(
          [
            file("/keep", "overwritten"),
            file("/PG_VERSION", "18\n"),
            ...(marker === undefined ? [] : [file("/PGWASM_BUILD", marker)]),
          ],
          "pg18",
          "none",
        );

        const error = await rejectionOf(createTestPgwasm({ dataDir: `file://${target}`, loadDataDir: backup }));
        if (marker === legacyMarker) {
          expect(error).toBeInstanceOf(DataFormatMismatchError);
          expect((error as DataFormatMismatchError).source).toBe("backup");
        } else {
          expect(error.message).toContain("requires PostgreSQL 19");
          expect(error.message).toContain('PG_VERSION is "18"');
        }
        expect(readFileSync(`${target}/keep`, "utf8")).toBe("untouched destination");
        expect(readdirSync(target)).toEqual(["keep"]);
      } finally {
        dir.cleanup();
      }
    });
  }

  it("checks every PG_VERSION member before restoring an archive with duplicate paths", async () => {
    const dir = scratchDir("pgwasm-pg18-duplicate-version");
    try {
      const target = `${dir.path}/fresh-pg19`;
      mkdirSync(target);
      const backup = await writeDataDirArchive(
        [file("/keep", "must not be written"), file("/PG_VERSION", "19\n"), file("/PG_VERSION", "18\n")],
        "mixed-versions",
        "none",
      );
      const error = await rejectionOf(createTestPgwasm({ dataDir: `file://${target}`, loadDataDir: backup }));
      expect(error.message).toContain('PG_VERSION is "18"');
      expect(readdirSync(target)).toEqual([]);
    } finally {
      dir.cleanup();
    }
  });
});

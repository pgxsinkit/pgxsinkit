import { describe, expect, it } from "bun:test";

import * as amcheck from "../../packages/pgwasm-c/src/contrib/amcheck";
import * as cBuildMain from "../../packages/pgwasm-c/src/index";
import * as prepopulated from "../../packages/pgwasm-c/src/prepopulated";
import * as pgDump from "../../packages/pgwasm-pg-dump/src/index";
import * as build from "../../packages/pgwasm/src/build";
import * as drizzle from "../../packages/pgwasm/src/drizzle";
import * as fs from "../../packages/pgwasm/src/fs";
import * as main from "../../packages/pgwasm/src/index";
import * as live from "../../packages/pgwasm/src/live";
import * as protocol from "../../packages/pgwasm/src/protocol";

// ADR-0062 decision 5 keeps pgwasm's surface small, and every runtime export is a promise each build
// must honour. A change to any list below is a change to that promise: make it deliberately.

const surfaces: [entry: string, module: object, exports: string[]][] = [
  [
    "@pgxsinkit/pgwasm",
    main,
    [
      "BackupFormatError",
      "BuildMarkerUnreadableError",
      "BuildMismatchError",
      "CrossOriginIsolationRequiredError",
      "DataDirExistsError",
      "DataFormatMismatchError",
      "DatabaseError",
      "ExtensionBuildMismatchError",
      "OpfsAhpRemovedError",
      "PgwasmClosedError",
      "PgwasmError",
      "PgwasmFailedError",
      "StorageInUseError",
      "UnsupportedDataDirError",
      "UnsupportedFeatureError",
      "UnsupportedFilesystemError",
      "createPgwasm",
      "identifier",
      "raw",
      "types",
    ],
  ],
  ["@pgxsinkit/pgwasm/live", live, ["live"]],
  ["@pgxsinkit/pgwasm/protocol", protocol, ["Modes", "Parser", "messages", "protocol", "serialize"]],
  [
    "@pgxsinkit/pgwasm/drizzle",
    drizzle,
    ["PgwasmDatabase", "PgwasmSession", "PgwasmTransaction", "drizzle", "drizzleParsers", "pgwasmCodecs"],
  ],
  ["@pgxsinkit/pgwasm/fs", fs, ["BaseFilesystem", "ERRNO_CODES"]],
  [
    "@pgxsinkit/pgwasm/build",
    build,
    ["TarFormatError", "gunzip", "gunzipIfCompressed", "gzip", "isGzip", "readTar", "writeTar"],
  ],
  ["@pgxsinkit/pgwasm-c", cBuildMain, ["C_BUILD_IDENTITY", "cBuild", "cBuildArtefacts", "createCBuild"]],
  ["@pgxsinkit/pgwasm-c/contrib/amcheck", amcheck, ["amcheck"]],
  ["@pgxsinkit/pgwasm-c/prepopulated", prepopulated, ["prepopulatedDataDir"]],
  ["@pgxsinkit/pgwasm-pg-dump", pgDump, ["PgDumpError", "PgDumpSessionError", "PgDumpUnsupportedBuildError", "pgDump"]],
];

describe("the runtime exports of every entry point", () => {
  for (const [entry, module, exports] of surfaces) {
    it(entry, () => {
      expect(Object.keys(module).sort()).toEqual([...exports].sort());
    });
  }
});

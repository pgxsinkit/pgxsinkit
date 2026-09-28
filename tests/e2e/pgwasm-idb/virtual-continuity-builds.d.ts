// The lane's Vite plugin (vite.config.ts) generates this module from continuity-builds.ts.
declare module "virtual:pgwasm-continuity-builds" {
  /** One earlier C build: its glue factories and the URLs of the files they load. */
  export interface ContinuityBuildFiles {
    readonly tag: string;
    readonly dataFormat: number;
    /** The size of the filesystem bundle its Postgres glue was packaged with. */
    readonly fsBundleBytes: number;
    /** The default exports of its `postgres.js` and `initdb.js`: Emscripten module factories. */
    readonly createPostgresModule: unknown;
    readonly createInitdbModule: unknown;
    readonly postgresWasm: string;
    readonly initdbWasm: string;
    readonly fsBundle: string;
  }

  export const continuityBuilds: readonly ContinuityBuildFiles[];
}

import { type StorageBuild, StorageBuildMismatchError, type StoreBuildCheckSite } from "@pgxsinkit/contracts";
import type { BuildIdentity } from "@pgxsinkit/pgwasm";

/**
 * The supplied-build check (ADR-0063). A store's Postgres build is code — a `PostgresBuild` a site supplies,
 * or the build an adopted instance reports as `pg.build` — never the declared string. The registry's
 * `storage.build` (default `"c"`) must name it:
 *
 * - before any mint, against the build the site supplies (the `createSyncClient` boot, the worker's
 *   provision and spare mints, a `createPgwasmClient` with a declaration threaded to it);
 * - on every adopted instance, against `pg.build` (`pgwasmInstance`, `precreatedPgwasm`, a worker
 *   `createStore` result).
 *
 * A mismatch throws {@link StorageBuildMismatchError} before any store is touched. Declaring `pgrust` and
 * supplying no build is a mismatch too: the default build is `cBuild`.
 */
export function assertStoreBuild(declared: StorageBuild, supplied: BuildIdentity, site: StoreBuildCheckSite): void {
  if (supplied.name !== declared) throw new StorageBuildMismatchError(declared, supplied.name, site);
}

/**
 * The typed build refusals (ADR-0063): the declared build is not the supplied one, or the data directory or
 * backup was made by another build or data format, or its marker is unreadable. Matched by `name`, which is
 * stable across bundle copies and the worker bridge. None of them is transient, so an open that failed with
 * one is never retried.
 */
const STORE_BUILD_REFUSALS: ReadonlySet<string> = new Set([
  "StorageBuildMismatchError",
  "BuildMismatchError",
  "DataFormatMismatchError",
  "BuildMarkerUnreadableError",
]);

/** Is `error` a typed build refusal ({@link STORE_BUILD_REFUSALS}), which a retry cannot change? */
export function isStoreBuildRefusal(error: unknown): boolean {
  return error instanceof Error && STORE_BUILD_REFUSALS.has(error.name);
}

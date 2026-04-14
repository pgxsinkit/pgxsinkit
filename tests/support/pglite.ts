import { PGlite, type PGliteOptions, type PGliteInterfaceExtensions } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";

export async function createFreshTestPGlite<TOptions extends PGliteOptions>(options?: TOptions) {
  const pg = await PGlite.create({
    ...(options as any),
    loadDataDir: await prepopulatedDataDir(),
  });
  return pg as PGlite &
    PGliteInterfaceExtensions<TOptions extends { extensions: infer TExtensions } ? TExtensions : Record<string, never>>;
}

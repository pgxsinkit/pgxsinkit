// The Emscripten-generated glue for the Postgres module (pglite.js, a pinned artefact): an ES module whose
// default export is the module factory.
import type { ModuleFactory, PostgresModule } from "../src/host/emscripten";

declare const createPostgresModule: ModuleFactory<PostgresModule>;
export default createPostgresModule;

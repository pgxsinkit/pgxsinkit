// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

// The C build's filesystem layout. These are facts of the compiled artefacts and of existing stores,
// not choices: the wasm and its filesystem bundle hardcode `/pglite` (bin/, share/, lib/), and an
// IndexedDB store's database is named after its mount point `/pglite/<name>`, so renaming any of them
// would orphan every existing IndexedDB store.

export const PG_ROOT = "/pglite";
export const PGDATA = `${PG_ROOT}/data`;
export const ICU_DATA_PATH = `${PG_ROOT}/icu`;
export const INITDB_EXE_PATH = `${PG_ROOT}/bin/initdb`;
export const POSTGRES_EXE_PATH = `${PG_ROOT}/bin/postgres`;
export const PG_STDOUT_PATH = `${PG_ROOT}/pgstdout`;
export const PG_STDIN_PATH = `${PG_ROOT}/pgstdin`;
/** The file `locale -a` output is served from. */
export const LOCALE_LIST_PATH = `${PG_ROOT}/locale-a`;

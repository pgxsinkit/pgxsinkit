// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

// The C build's filesystem layout. The root is a fact of the compiled artefacts, not a choice: the wasm
// and its filesystem bundle hardcode `/pgwasm` as the filesystem root and install prefix (bin/, share/,
// lib/, icu/) since pgwasm-postgres 18.6.2, so PG_ROOT must match the release it runs. An IndexedDB
// store's database is named after its mount point `/pgwasm/<name>` (see mounts/idb.ts), so the root is
// also part of every IndexedDB store's identity: changing it leaves the stores under the old root behind.

export const PG_ROOT = "/pgwasm";
export const PGDATA = `${PG_ROOT}/data`;
export const ICU_DATA_PATH = `${PG_ROOT}/icu`;
export const INITDB_EXE_PATH = `${PG_ROOT}/bin/initdb`;
export const POSTGRES_EXE_PATH = `${PG_ROOT}/bin/postgres`;
export const PG_STDOUT_PATH = `${PG_ROOT}/pgstdout`;
export const PG_STDIN_PATH = `${PG_ROOT}/pgstdin`;
/** The file `locale -a` output is served from. */
export const LOCALE_LIST_PATH = `${PG_ROOT}/locale-a`;

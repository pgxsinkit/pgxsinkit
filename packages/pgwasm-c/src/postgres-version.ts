import { ARTEFACT_RELEASE } from "./artefact-pins";

/** PostgreSQL's major data-directory version, independent of pgwasm's build-marker format. */
export const C_POSTGRES_MAJOR = /^REL_(\d+)_/.exec(ARTEFACT_RELEASE.upstream.tag)?.[1];

/** Refuse another major before the C host writes a restored image or starts a mounted cluster. */
export function checkPostgresVersion(bytes: Uint8Array | undefined): void {
  if (C_POSTGRES_MAJOR === undefined) throw new Error("The pinned C build has no PostgreSQL major version.");
  const found = bytes === undefined ? undefined : new TextDecoder().decode(bytes).trim();
  if (found === C_POSTGRES_MAJOR) return;
  throw new Error(
    `This C build requires PostgreSQL ${C_POSTGRES_MAJOR}, but the data directory's PG_VERSION is ` +
      `${found === undefined ? "missing" : JSON.stringify(found)}. Use a separately named fresh PostgreSQL ${C_POSTGRES_MAJOR} store; ` +
      "the existing directory is not migrated or replaced.",
  );
}

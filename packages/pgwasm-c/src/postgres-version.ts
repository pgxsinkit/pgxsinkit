import { PgwasmError } from "@pgxsinkit/pgwasm";

import { ARTEFACT_RELEASE } from "./artefact-pins";

/** PostgreSQL's major data-directory version, independent of pgwasm's build-marker format. */
export const C_POSTGRES_MAJOR = /^REL_(\d+)_/.exec(ARTEFACT_RELEASE.upstream.tag)?.[1];

/** The C host cannot open this PostgreSQL major; retrying cannot make the directory compatible. */
export class PostgresVersionMismatchError extends PgwasmError {
  override name = "PostgresVersionMismatchError";
  readonly expected: string;
  readonly found: string | undefined;
  /** Structured fields retained alongside the stable error name by the worker bridge. */
  readonly detail: { readonly expected: string; readonly found: string | undefined };

  constructor(expected: string, found: string | undefined) {
    super(
      `This C build requires PostgreSQL ${expected}, but the data directory's PG_VERSION is ` +
        `${found === undefined ? "missing" : JSON.stringify(found)}. Use a separately named fresh PostgreSQL ${expected} store; ` +
        "the existing directory is not migrated or replaced.",
    );
    this.expected = expected;
    this.found = found;
    this.detail = { expected, found };
  }
}

/** Refuse another major before the C host writes a restored image or starts a mounted cluster. */
export function checkPostgresVersion(bytes: Uint8Array | undefined): void {
  if (C_POSTGRES_MAJOR === undefined) throw new Error("The pinned C build has no PostgreSQL major version.");
  const found = bytes === undefined ? undefined : new TextDecoder().decode(bytes).trim();
  if (found === C_POSTGRES_MAJOR) return;
  throw new PostgresVersionMismatchError(C_POSTGRES_MAJOR, found);
}

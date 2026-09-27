// Began as a copy of `@electric-sql/pglite-repl` (taken under PGlite's PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

/** The rows and fields of one statement's result, as the REPL reads them. */
export interface ReplResults {
  readonly rows: readonly unknown[];
  readonly fields: readonly { readonly name: string; readonly dataTypeID: number }[];
}

/** How a statement's rows come back: as arrays, or as objects keyed by field name. */
export interface ReplQueryOptions {
  readonly rowMode?: "array" | "object";
}

/**
 * The database the REPL runs statements on: anything with `query` and `exec` in pgwasm's shapes. A
 * `Pgwasm` is one, and so is `@pgxsinkit/client`'s `replAdapter(client)`. The REPL waits for
 * `waitReady` when there is one.
 */
export interface ReplDatabase {
  query(sql: string, params?: unknown[], options?: ReplQueryOptions): Promise<ReplResults>;
  exec(sql: string, options?: ReplQueryOptions): Promise<readonly ReplResults[]>;
  readonly waitReady?: Promise<void>;
}

/** One table to show: each row an array of field values (the REPL asks for `rowMode: "array"`). */
export interface ReplRows {
  readonly rows: readonly (readonly unknown[])[];
  readonly fields: readonly { readonly name: string; readonly dataTypeID: number }[];
  /** A describe command's caption above the table (`Table "public.notes"`). */
  readonly title?: string;
  /** A describe command's lines below the table (`Indexes:` and the indexes). */
  readonly footers?: readonly string[];
}

/** What the REPL shows for one input. */
export interface ReplResponse {
  readonly query: string;
  readonly text?: string;
  readonly error?: string;
  readonly results?: readonly ReplRows[];
  /** Milliseconds. */
  readonly time: number;
}

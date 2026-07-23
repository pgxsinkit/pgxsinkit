/**
 * pgxsinkit brand tokens
 * Postgres blue + Supabase green. The green `x` is the sync pivot in the wordmark.
 * Use the light values on light backgrounds, the *-light / *-bright values on dark.
 */
export const pgxsinkitBrand = {
  ink: "#11181C", // wordmark "sinkit", dark backgrounds
  paper: "#F8F9FA", // marks on dark surfaces
  mute: "#8A94A0", // secondary text / captions
  pg: "#336791", // Postgres blue — "pg" on light backgrounds
  pgLight: "#008BB9", // Postgres light blue — "pg" on dark backgrounds
  pgDeep: "#0064A5",
  green: "#249361", // Supabase green (deep) — the "x" on light backgrounds
  greenBright: "#3ECF8E", // Supabase green — the "x" on dark backgrounds
} as const;

export type PgxsinkitBrandToken = keyof typeof pgxsinkitBrand;

// Board client configuration. Defaults target the local matched self-hosted stack (`bun run
// infra:up`): the caddy HTTP/2 + HTTP/3 front (board-compose.yml) over GoTrue + the two edge functions.
// The browser holds one Electric long-poll PER synced shape (6 for the board); over plain HTTP/1.1 the
// ~6-connections-per-origin cap is consumed by those long-polls and writes starve, so the demo's
// browser origin is the multiplexed h2/h3 front, not kong's HTTP/1.1 port (54331, which tests + seed
// scripts still use directly). Override the `VITE_BOARD_*` vars (read from the workspace-root .env, see
// vite.config) to point the same client at a cloud Supabase project + Electric Cloud — which already
// serve h2 over TLS — instead; the board code does not change.

const supabaseUrl = import.meta.env["VITE_BOARD_SUPABASE_URL"] ?? "https://localhost:54343";

// The published Supabase demo anon key (signed with the demo JWT secret). Local demo only — never a
// secret; a real project supplies its own anon key via VITE_BOARD_ANON_KEY.
const anonKey =
  import.meta.env["VITE_BOARD_ANON_KEY"] ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE";

export const boardConfig = {
  supabaseUrl,
  anonKey,
  // board-sync (Electric shape proxy) + board-write (mutation ingress), both behind the gateway.
  electricUrl: `${supabaseUrl}/functions/v1/board-sync`,
  writeUrl: `${supabaseUrl}/functions/v1/board-write`,
  // The shared dev password every seeded identity uses (scripts/seed-board.ts). Demo only.
  seedPassword: import.meta.env["VITE_BOARD_SEED_PASSWORD"] ?? "board-demo-password",
} as const;

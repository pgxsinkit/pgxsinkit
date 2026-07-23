// Board client configuration. Defaults target the local matched self-hosted stack (`bun run
// infra:up`): the caddy HTTP/2 + HTTP/3 front (board-compose.yml) over GoTrue + the two edge functions.
// The browser holds one Electric long-poll PER synced shape (6 for the board); over plain HTTP/1.1 the
// ~6-connections-per-origin cap is consumed by those long-polls and writes starve, so the demo's
// browser origin is the multiplexed h2/h3 front, not the gateway's HTTP/1.1 port (54331, which tests +
// seed scripts still use directly). Override the `VITE_BOARD_*` vars (read from the workspace-root
// .env, see vite.config) to point the same client at a cloud Supabase project + Electric Cloud — which
// already serve h2 over TLS — instead; the board code does not change.

const supabaseUrl = import.meta.env["VITE_BOARD_SUPABASE_URL"] ?? "https://localhost:54343";

// The new opaque PUBLISHABLE key (board ADR-0007). Sent as the `apikey` header on every request; the
// gateway (Envoy locally, the platform on Cloud) validates it and, for an unauthenticated request,
// swaps it for the internal anon JWT. Local demo only — never a secret; a real project supplies its
// own `sb_publishable_…` key via VITE_BOARD_PUBLISHABLE_KEY.
const publishableKey =
  import.meta.env["VITE_BOARD_PUBLISHABLE_KEY"] ?? "sb_publishable_boarddemoLOCALxxxxxxxxx_demo0000";

// Regional invocation pin (Supabase `x-region` header). Edge functions execute NEAR THE CALLER by
// default while the database lives in ONE region — so every function→DB statement crosses regions
// (measured: SG↔eu-central-1 = 162ms/statement, ~3s per write). Pinning execution to the DATABASE's
// region pays the long hop once, on the client→function leg, instead of per statement. Applied to the
// WRITE function ONLY (board-client wires it via `writeRequestHeaders`): board-write is DB-bound, so it
// wins from the pin. The read proxy (board-sync) is left UNPINNED — its upstream is Electric Cloud's
// global CDN, so pinning reads away from the caller would ADD intercontinental hops per catch-up.
// Set to the project's region (e.g. "eu-central-1") for cloud runs; leave unset locally (nothing to pin).
const functionsRegion = import.meta.env["VITE_BOARD_FUNCTIONS_REGION"] ?? "";

export const boardConfig = {
  supabaseUrl,
  publishableKey,
  functionsRegion,
  // board-sync (Electric shape proxy) + board-write (mutation ingress), both behind the gateway.
  electricUrl: `${supabaseUrl}/functions/v1/board-sync`,
  batchWriteUrl: `${supabaseUrl}/functions/v1/board-write/api/mutations`,
  // The shared dev password every seeded identity uses (scripts/seed-board.ts). Demo only.
  seedPassword: import.meta.env["VITE_BOARD_SEED_PASSWORD"] ?? "board-demo-password",
} as const;

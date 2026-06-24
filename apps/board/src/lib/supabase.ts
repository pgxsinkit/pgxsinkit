import { createClient } from "@supabase/supabase-js";

import { boardConfig } from "../config";

// The board uses Supabase for **auth only** — GoTrue sign-in + a persisted, auto-refreshed session.
// Reads go through Electric (`board-sync`) and writes through `board-write`; the auto-CRUD data API
// (PostgREST) is intentionally not part of this stack, so nothing here calls `.from()`.
export const supabase = createClient(boardConfig.supabaseUrl, boardConfig.anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "pgxsinkit-board-auth",
  },
});

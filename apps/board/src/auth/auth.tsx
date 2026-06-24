import type { Session } from "@supabase/supabase-js";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import { boardConfig } from "../config";
import { supabase } from "../lib/supabase";

interface AuthState {
  session: Session | null;
  /** True until the initial `getSession()` settles, so the app does not flash the login screen. */
  loading: boolean;
  /** One-click sign-in: every seeded identity shares the demo password (scripts/seed-board.ts). */
  signInAs: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      loading,
      signInAs: async (email: string) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password: boardConfig.seedPassword });
        if (error) throw error;
      },
      signOut: async () => {
        // Hard-reload to /login rather than tearing the client down in place. Signing out unmounts
        // BoardClientProvider, whose cleanup calls `pglite.close()`; doing that while a route's live
        // query is still subscribed to the same handle deadlocks the PGlite WASM thread. A full
        // navigation lets the browser release PGlite/IndexedDB cleanly, and the next sign-in boots a
        // fresh store. (React batches the session→null update, so the reload wins before any in-place
        // unmount/teardown commits.)
        await supabase.auth.signOut();
        window.location.assign("/login");
      },
    }),
    [session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (context == null) {
    throw new Error("useAuth must be used within <AuthProvider>");
  }
  return context;
}

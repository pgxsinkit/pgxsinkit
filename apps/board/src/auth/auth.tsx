import type { Session } from "@supabase/supabase-js";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";

import { timeAsync } from "@pgxsinkit/client";

import { boardConfig } from "../config";
import { supabase } from "../lib/supabase";
import { createAuthTransitionCoordinator } from "./auth-transition";

interface AuthState {
  session: Session | null;
  /** True until the initial `getSession()` settles, so the app does not flash the login screen. */
  loading: boolean;
  /** True while a signed-out auth event is navigating away from authenticated routes. */
  signingOut: boolean;
  /** `app_metadata.roles` contains `admin` — the global bypass identity (board ADR-0005). */
  isAdmin: boolean;
  /** One-click sign-in: every seeded identity shares the demo password (scripts/seed-board.ts). */
  signInAs: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({
  children,
  navigateToLogin,
}: {
  children: ReactNode;
  navigateToLogin: () => Promise<void> | void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const transitionRef = useRef<ReturnType<typeof createAuthTransitionCoordinator> | null>(null);
  const transition = transitionRef.current ?? createAuthTransitionCoordinator();
  transitionRef.current = transition;

  useEffect(() => {
    let active = true;
    // Stamp only the INITIAL session restore on page load (the boot rail's app-side head); later
    // `onAuthStateChange` events are not part of first paint and are left un-stamped.
    void timeAsync("boot auth session restore", () => supabase.auth.getSession()).then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      if (next != null) {
        // A newer authenticated event wins over an older navigation still completing. Its epoch makes
        // that pending transition's `finish` a no-op instead of clearing the newer identity.
        transition.acceptAuthenticated();
        setSigningOut(false);
        setSession(next);
        return;
      }

      // Route away from authenticated components BEFORE removing their sync provider. The provider cleanup
      // then detaches/stops the old store while the same page realm remains alive; a different identity can
      // immediately attach its own separately named worker/store without waiting for the old worker to retire.
      const transitionEpoch = transition.beginSignedOut();
      if (transitionEpoch == null) return;
      setSigningOut(true);
      const finish = () => {
        if (!active || !transition.completeSignedOut(transitionEpoch)) return;
        setSession(null);
        setSigningOut(false);
      };
      void Promise.resolve(navigateToLogin()).then(finish, finish);
    });
    return () => {
      active = false;
      transition.invalidate();
      subscription.subscription.unsubscribe();
    };
  }, [navigateToLogin, transition]);

  const value = useMemo<AuthState>(
    () => ({
      session,
      loading,
      signingOut,
      isAdmin: Boolean((session?.user.app_metadata?.["roles"] as string[] | undefined)?.includes("admin")),
      signInAs: async (email: string) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password: boardConfig.seedPassword });
        if (error) throw error;
      },
      signOut: async () => {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
      },
    }),
    [session, loading, signingOut],
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

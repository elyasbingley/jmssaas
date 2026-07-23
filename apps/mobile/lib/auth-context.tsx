import React, { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { useQuery, useStatus } from "@powersync/react";
import type { Profile } from "@jmssaas/shared";
import { supabase } from "./supabase";
import { connectPowerSync, disconnectPowerSync } from "./powersync";

interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  isLoading: boolean;
  /**
   * True while a signed-in session has no local profile row yet and this
   * device has never completed a full PowerSync sync. A brand-new install
   * that loses signal moments after login would otherwise sit with
   * `profile: null` forever - screens guard writes on `if (!profile)
   * return`, which would silently no-op with no explanation to the tech.
   * `hasSynced` is persisted in local SQLite and, once true, stays true
   * across restarts - so this only ever gates the one-time initial sync,
   * never normal offline use on a device that's synced before.
   */
  isWaitingForFirstSync: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Supabase restores the persisted session from AsyncStorage without a
    // network round trip, so this resolves even with no reception.
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  // Deliberately keyed on the user id, not the `session` object itself.
  // Supabase hands out a new session object on more than just sign-in/out -
  // notably the immediate INITIAL_SESSION emission right after subscribing,
  // and periodic TOKEN_REFRESHED events - so depending on `session` directly
  // re-ran this effect (and re-called connect()) far more often than the
  // user's sign-in state actually changed. PowerSync's ConnectionManager
  // treats every connect() call as "abort whatever's in flight and restart",
  // so repeated calls here meant the sync connection kept getting aborted
  // before it could ever finish - it never crashed, just never completed,
  // which is why the device sat on "Setting up your account" forever with
  // nothing but repeated "Trying to close for the second time" warnings
  // (PowerSync's own transport layer closing an already-closing stream).
  // Token refresh doesn't need a reconnect anyway - fetchCredentials() in
  // connector.ts fetches a fresh Supabase token on every call, which is what
  // PowerSync's SDK uses whenever it needs a new one internally.
  useEffect(() => {
    if (session) {
      connectPowerSync().catch((error) => console.error("[PowerSync] connect failed", error));
    } else {
      disconnectPowerSync().catch((error) => console.error("[PowerSync] disconnect failed", error));
    }
  }, [session?.user.id]);

  // Read the signed-in user's profile from the local PowerSync copy so role
  // and tenant_id are available offline, not just when the network is up.
  const { data: profiles } = useQuery<Profile>("SELECT * FROM profiles WHERE id = ?", [session?.user.id ?? ""]);
  const profile = session ? (profiles[0] ?? null) : null;

  const status = useStatus();
  const isWaitingForFirstSync = session != null && !profile && status.hasSynced !== true;

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, profile, isLoading, isWaitingForFirstSync, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

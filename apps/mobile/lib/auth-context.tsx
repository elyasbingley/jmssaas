import React, { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { useQuery } from "@powersync/react";
import type { Profile } from "@jmssaas/shared";
import { supabase } from "./supabase";
import { connectPowerSync, disconnectPowerSync } from "./powersync";

interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  isLoading: boolean;
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

  useEffect(() => {
    if (session) {
      connectPowerSync().catch((error) => console.error("[PowerSync] connect failed", error));
    } else {
      disconnectPowerSync().catch((error) => console.error("[PowerSync] disconnect failed", error));
    }
  }, [session]);

  // Read the signed-in user's profile from the local PowerSync copy so role
  // and tenant_id are available offline, not just when the network is up.
  const { data: profiles } = useQuery<Profile>("SELECT * FROM profiles WHERE id = ?", [session?.user.id ?? ""]);
  const profile = session ? (profiles[0] ?? null) : null;

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, profile, isLoading, signIn, signOut }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

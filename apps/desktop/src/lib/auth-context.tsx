import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import type { Profile } from "@jmssaas/shared";
import { supabase } from "./supabase";

interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  isLoading: boolean;
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  // Re-reads this user's own profile row without a full session reload -
  // needed after a screen updates a profile column directly (e.g.
  // DashboardSettings writing dashboard_widgets), since profile here is a
  // one-shot fetch keyed on session?.user.id, not a live query.
  refetchProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  // No PowerSync here (see lib/supabase.ts) - profile is just a plain
  // fetch, re-run whenever the signed-in user actually changes. Deliberately
  // keyed on session?.user.id, not the session object itself - Supabase
  // hands out a new session object on more than sign-in/out (notably token
  // refresh), and re-fetching the profile on every one of those would be
  // wasted work. See apps/mobile/lib/auth-context.tsx's own comment - the
  // same distinction mattered a lot more there (a PowerSync reconnect loop),
  // but the underlying gotcha is identical.
  const loadProfile = async (userId: string) => {
    const { data } = await supabase.from("profiles").select("*").eq("id", userId).single();
    setProfile((data as Profile | null) ?? null);
  };

  useEffect(() => {
    if (!session) {
      setProfile(null);
      return;
    }
    loadProfile(session.user.id);
  }, [session?.user.id]);

  const refetchProfile = async () => {
    if (session) await loadProfile(session.user.id);
  };

  const isAdmin = profile?.role === "admin";

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, profile, isLoading, isAdmin, signIn, signOut, refetchProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

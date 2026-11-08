import "react-native-url-polyfill/auto";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to apps/mobile/.env and fill in your Supabase project's values - see docs/SETUP.md."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Supabase's own documented React Native requirement
// (supabase.com/docs/reference/javascript/initializing - "Session
// management with React Native") - autoRefreshToken alone isn't enough:
// its refresh timer runs on the JS thread, which Android/iOS freezes while
// the app is backgrounded (phone locked, a call comes in, switching to
// another app - all routine for a technician in the field). A technician
// opening the app after any such gap could easily be carrying an access
// token that's already expired, with no refresh having happened while
// backgrounded to catch it.
//
// Without this listener, the very first request after resuming (whichever
// screen's query fires first) is the one that discovers the stale token,
// fails, triggers a refresh, and only then retries - one extra full
// request-fail-refresh-retry round trip stacked on top of normal latency,
// on top of a cellular connection's own higher RTT than wifi/desktop. That
// matches exactly the "opens blank, fills in several seconds later -
// happens on quotes, company settings, anything" report: whichever screen
// happens to be open when the app was last backgrounded is the one that
// eats this cost on resume, not because that screen is slow.
//
// startAutoRefresh()/stopAutoRefresh() on every foreground/background
// transition refreshes proactively on resume (before any screen's own
// queries even run) and stops burning battery on a refresh timer the OS
// would just freeze anyway while backgrounded.
AppState.addEventListener("change", (state) => {
  if (state === "active") {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
});

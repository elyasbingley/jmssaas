import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to apps/desktop/.env and fill in your Supabase project's values - see docs/SETUP.md."
  );
}

// No offline PowerSync layer here (see docs/SETUP.md's desktop section for
// why) - every screen in this app reads/writes straight through this
// client, same tables and RLS policies mobile uses, just without the
// local-SQLite indirection. The default session storage (browser
// localStorage) is exactly what a normal always-online web app wants.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

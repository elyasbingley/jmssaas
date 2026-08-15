// Step 1 of the per-profile Google Calendar OAuth2 connect flow - called
// from Settings (desktop) / the equivalent mobile screen with the
// signed-in user's own bearer token. Unlike xero-oauth-start, this is NOT
// admin-gated: any tenant member (admin or technician) connects their own
// Google account, one shared business Xero connection vs. one Google
// Calendar connection per person. Builds the Google authorize URL and
// hands back a one-time `state` value (stored in google_oauth_states)
// that google-oauth-callback uses to recover which PROFILE initiated the
// connection - Google's redirect back to the callback carries no
// session/auth header of its own, so this is the only way the callback
// knows whose tokens these are.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";

// Must exactly match an Authorized redirect URI configured on this OAuth
// client in Google Cloud Console (APIs & Services -> Credentials).
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/google-oauth-callback`;

// `calendar` (not the narrower calendar.events) - also need to resolve the
// connected account's real primary-calendar ID (their email) via
// calendars.get, which calendar.events alone doesn't cover; requesting the
// broader scope is one request instead of two and is no less "sensitive"
// in Google's OAuth verification process either way. `openid email` - lets
// the callback call Google's userinfo endpoint with the resulting access
// token to get the connected account's email for display (simpler and
// safer than decoding/verifying the ID token JWT by hand with no JWT
// library available in this Edge Function).
const SCOPES = "openid email https://www.googleapis.com/auth/calendar";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: new Headers(CORS_HEADERS) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!GOOGLE_CLIENT_ID) return json({ error: "google_not_configured" }, 400);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await callerClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);

  const { data: callerProfile } = await callerClient
    .from("profiles")
    .select("tenant_id")
    .eq("id", authData.user.id)
    .single();
  if (!callerProfile) return json({ error: "unauthorized" }, 401);

  const state = crypto.randomUUID();
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { error: insertError } = await admin
    .from("google_oauth_states")
    .insert({ state, tenant_id: callerProfile.tenant_id, profile_id: authData.user.id });
  if (insertError) return json({ error: "server_error" }, 500);

  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", SCOPES);
  authorizeUrl.searchParams.set("state", state);
  // offline: guarantees a refresh_token comes back (without it we'd only
  // ever get a 1-hour access token). consent: forces the consent screen
  // every time rather than only on the very first authorization, so a
  // reconnect after a lost/revoked token still yields a fresh
  // refresh_token instead of silently omitting it.
  authorizeUrl.searchParams.set("access_type", "offline");
  authorizeUrl.searchParams.set("prompt", "consent");

  return json({ ok: true, url: authorizeUrl.toString() });
});

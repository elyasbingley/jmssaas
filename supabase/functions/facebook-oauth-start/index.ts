// Step 1 of the Facebook Messenger OAuth connect flow - a direct port of
// xero-oauth-start's own pattern (see that function's comment for the
// overall shape). Called from Settings' "Connect to Facebook" button with
// the signed-in admin's own bearer token. Builds Facebook's Login dialog
// URL and hands back a one-time `state` value (stored in
// facebook_oauth_states) that facebook-oauth-callback uses to recover
// which tenant initiated the connection - Facebook's redirect back to the
// callback carries no session/auth header of its own, so this is the only
// way the callback knows who to attach the resulting Page token to.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FACEBOOK_APP_ID = Deno.env.get("FACEBOOK_APP_ID") ?? "";

// Bump when Meta deprecates this version - see
// developers.facebook.com/docs/graph-api/changelog for current/sunset
// versions. Shared with facebook-oauth-callback (must request the same
// version the token was issued against isn't actually required by Meta,
// but keeping both functions on one pinned version avoids surprises).
const GRAPH_API_VERSION = "v21.0";

// Must exactly match a Valid OAuth Redirect URI configured in the Meta App
// (developers.facebook.com -> this app -> Facebook Login -> Settings).
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/facebook-oauth-callback`;

// pages_show_list - list the Pages the user manages (to find the one to
// connect). pages_messaging - send/receive messages through that Page.
// pages_manage_metadata - subscribe the Page to this app's webhook
// (required for the messages webhook to actually fire for that Page).
// All three are Advanced Access permissions requiring Meta App Review
// before this works for a Page the app owner doesn't personally admin -
// see docs/SETUP.md's Channels section for the Standard-Access testing
// path available before that review completes.
const SCOPES = "pages_show_list,pages_messaging,pages_manage_metadata";

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
  if (!FACEBOOK_APP_ID) return json({ error: "facebook_not_configured" }, 400);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await callerClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);

  const { data: callerProfile } = await callerClient
    .from("profiles")
    .select("tenant_id, role")
    .eq("id", authData.user.id)
    .single();
  if (!callerProfile) return json({ error: "unauthorized" }, 401);
  if (callerProfile.role !== "admin") return json({ error: "forbidden" }, 403);

  const state = crypto.randomUUID();
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { error: insertError } = await admin
    .from("facebook_oauth_states")
    .insert({ state, tenant_id: callerProfile.tenant_id, created_by: authData.user.id });
  if (insertError) return json({ error: "server_error" }, 500);

  const authorizeUrl = new URL(`https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", FACEBOOK_APP_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", SCOPES);
  authorizeUrl.searchParams.set("state", state);

  return json({ ok: true, url: authorizeUrl.toString() });
});

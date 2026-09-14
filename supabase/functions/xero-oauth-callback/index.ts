// Step 2 of the Xero OAuth2 connect flow - Xero redirects the user's own
// browser here (GET, with ?code=...&state=...) after they approve the
// connection on Xero's own consent screen. No Supabase session/auth
// header exists on this request at all (it's the browser being redirected
// by Xero, not an app fetch() call) - `state` (created by xero-oauth-start,
// looked up and burned here) is what recovers which tenant this belongs
// to, standard OAuth2 CSRF-protection pattern.
//
// Ends with an HTTP redirect (302) back to the desktop app's Settings
// page, not an HTML response body - Supabase force-downgrades HTML
// responses from Edge Functions on the shared *.supabase.co domain to
// inert text/plain (see the "approve" function's own comment for why),
// but a redirect's Location header still works regardless of that, since
// the browser navigates off the status code, not the body.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const XERO_CLIENT_ID = Deno.env.get("XERO_CLIENT_ID") ?? "";
const XERO_CLIENT_SECRET = Deno.env.get("XERO_CLIENT_SECRET") ?? "";
// Where to send the browser back to once the connection is resolved (with
// or without success) - the desktop app's own Settings screen, e.g.
// https://jmssaas.vercel.app/settings. Set as an Edge Function secret
// since it's server-side redirect logic, not client-bundled config.
const XERO_APP_REDIRECT_URL = Deno.env.get("XERO_APP_REDIRECT_URL") ?? "";

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/xero-oauth-callback`;

function redirect(status: "connected" | "error", message?: string): Response {
  if (!XERO_APP_REDIRECT_URL) {
    // No configured place to send the browser back to - fall back to a
    // plain JSON response rather than a broken redirect. Not pretty, but
    // tells whoever's looking exactly what's missing.
    return new Response(JSON.stringify({ error: "xero_app_redirect_url_not_configured", status, message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const url = new URL(XERO_APP_REDIRECT_URL);
  url.searchParams.set("xero", status);
  if (message) url.searchParams.set("xero_message", message);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const xeroError = url.searchParams.get("error");

  if (xeroError) return redirect("error", xeroError);
  if (!code || !state) return redirect("error", "missing_code_or_state");
  if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET) return redirect("error", "xero_not_configured");
  if (!SUPABASE_SERVICE_ROLE_KEY) return redirect("error", "server_error");

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Single-use: look up and immediately delete, so a replayed/leaked
  // callback URL can't be used twice.
  const { data: stateRow } = await admin.from("xero_oauth_states").select("*").eq("state", state).maybeSingle();
  if (!stateRow) return redirect("error", "invalid_or_expired_state");
  await admin.from("xero_oauth_states").delete().eq("state", state);

  const tokenRes = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }).toString(),
  });
  const tokenBody = await tokenRes.json();
  if (!tokenRes.ok) {
    console.error("[xero-oauth-callback] Token exchange failed", tokenBody);
    return redirect("error", "token_exchange_failed");
  }

  const { access_token, refresh_token, expires_in } = tokenBody;

  // Which Xero organisation(s) this user just authorised - takes the
  // first one. A user with multiple Xero organisations who picks the
  // "wrong" one on Xero's consent screen needs to disconnect and
  // reconnect, picking correctly - Phase 1 doesn't build an org picker.
  const connectionsRes = await fetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const connections = await connectionsRes.json();
  if (!connectionsRes.ok || !Array.isArray(connections) || connections.length === 0) {
    console.error("[xero-oauth-callback] Failed to fetch Xero connections", connections);
    return redirect("error", "no_xero_organisation_authorised");
  }
  const xeroOrg = connections[0];

  const { error: upsertError } = await admin.from("xero_connections").upsert(
    {
      tenant_id: stateRow.tenant_id,
      xero_tenant_id: xeroOrg.tenantId,
      xero_org_name: xeroOrg.tenantName ?? null,
      access_token,
      refresh_token,
      token_expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
      connected_by: stateRow.created_by,
      connected_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id" }
  );
  if (upsertError) {
    console.error("[xero-oauth-callback] Failed to store Xero connection", upsertError.message);
    return redirect("error", "server_error");
  }

  return redirect("connected");
});

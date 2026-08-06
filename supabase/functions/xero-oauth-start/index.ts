// Step 1 of the Xero OAuth2 connect flow - called from Settings.tsx's
// "Connect to Xero" button with the signed-in admin's own bearer token.
// Builds the Xero authorize URL and hands back a one-time `state` value
// (stored in xero_oauth_states) that xero-oauth-callback uses to recover
// which tenant initiated the connection - Xero's redirect back to the
// callback carries no session/auth header of its own, so this is the only
// way the callback knows who to attach the resulting tokens to.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const XERO_CLIENT_ID = Deno.env.get("XERO_CLIENT_ID") ?? "";

// Must exactly match the Redirect URI configured in the Xero Developer
// app (developer.xero.com -> My Apps -> this app -> Configuration).
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/xero-oauth-callback`;

// offline_access - required for a refresh_token (without it the access
// token, valid 30 minutes, would be all we ever get). accounting.contacts/
// accounting.invoices - create/update Contacts and Invoices, Phase 1's
// entire scope. Two rounds of "invalid_scope" from Xero's own authorize
// endpoint got this to exactly what this Xero app is actually configured
// with (checked against the app's own Configuration -> scopes list in the
// Xero Developer Portal): accounting.transactions - the older, coarser
// scope name that used to cover invoices/bank transactions/etc together -
// isn't in this app's available scopes at all; Xero's replaced it with
// granular per-object scopes (accounting.invoices, accounting.payments,
// accounting.banktransactions, ...) for newer apps, so accounting.invoices
// is the correct one for what xero-sync actually does (create/update
// Invoices). If a scope ever needs adding back, it must also be turned on
// for the app in the Xero Developer Portal, not just requested here - see
// docs/SETUP.md section 35.
const SCOPES = "offline_access accounting.contacts accounting.invoices";

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
  if (!XERO_CLIENT_ID) return json({ error: "xero_not_configured" }, 400);
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
    .from("xero_oauth_states")
    .insert({ state, tenant_id: callerProfile.tenant_id, created_by: authData.user.id });
  if (insertError) return json({ error: "server_error" }, 500);

  const authorizeUrl = new URL("https://login.xero.com/identity/connect/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", XERO_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", SCOPES);
  authorizeUrl.searchParams.set("state", state);

  return json({ ok: true, url: authorizeUrl.toString() });
});

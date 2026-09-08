// Step 2 of the Facebook Messenger OAuth connect flow - Facebook redirects
// the user's own browser here (GET, with ?code=...&state=...) after they
// approve the connection on Facebook's own consent screen. No Supabase
// session/auth header exists on this request at all - `state` (created by
// facebook-oauth-start, looked up and burned here) is what recovers which
// tenant this belongs to. See xero-oauth-callback's own comment for the
// overall shape this is ported from, including why this ends with a 302
// redirect rather than an HTML response body.
//
// Facebook's token exchange is a three-step dance Xero's isn't:
//   1. Exchange the auth code for a short-lived (~1-2 hour) USER token.
//   2. Exchange that for a long-lived (~60 day) USER token.
//   3. Call /me/accounts with the long-lived user token to list the Pages
//      this user manages - a Page Access Token obtained this way is itself
//      long-lived/non-expiring (it only breaks if the granting user changes
//      their Facebook password or revokes the app), which is what actually
//      gets stored and used to send/receive messages.
// Then the Page has to be explicitly subscribed to this app's webhook
// (POST /{page-id}/subscribed_apps) - simply having a Page Access Token
// does NOT make Facebook start calling facebook-messenger-webhook for it.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FACEBOOK_APP_ID = Deno.env.get("FACEBOOK_APP_ID") ?? "";
const FACEBOOK_APP_SECRET = Deno.env.get("FACEBOOK_APP_SECRET") ?? "";
// Where to send the browser back to once the connection is resolved (with
// or without success) - the desktop app's own Settings screen, e.g.
// https://jmssaas.vercel.app/settings/company. Set as an Edge Function
// secret since it's server-side redirect logic, not client-bundled config.
const FACEBOOK_APP_REDIRECT_URL = Deno.env.get("FACEBOOK_APP_REDIRECT_URL") ?? "";

const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/facebook-oauth-callback`;

function redirect(status: "connected" | "error", message?: string): Response {
  if (!FACEBOOK_APP_REDIRECT_URL) {
    return new Response(JSON.stringify({ error: "facebook_app_redirect_url_not_configured", status, message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const url = new URL(FACEBOOK_APP_REDIRECT_URL);
  url.searchParams.set("facebook", status);
  if (message) url.searchParams.set("facebook_message", message);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const facebookError = url.searchParams.get("error");
  const facebookErrorDescription = url.searchParams.get("error_description");

  // Logged unconditionally, before any early return - a failure here
  // previously showed nothing at all in Supabase's own logs (just the
  // runtime's own Boot/Shutdown lines), making it indistinguishable from
  // "never called" the same way the Twilio webhooks were before they got
  // this same fix. Query params only - `code`/`state` are single-use and
  // about to be burned anyway, not worth redacting further here.
  console.log("[facebook-oauth-callback] received request", {
    hasCode: !!code,
    hasState: !!state,
    facebookError,
    facebookErrorDescription,
  });

  if (facebookError) return redirect("error", facebookError);
  if (!code || !state) return redirect("error", "missing_code_or_state");
  if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) return redirect("error", "facebook_not_configured");
  if (!SUPABASE_SERVICE_ROLE_KEY) return redirect("error", "server_error");

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Single-use: look up and immediately delete, so a replayed/leaked
  // callback URL can't be used twice.
  const { data: stateRow } = await admin.from("facebook_oauth_states").select("*").eq("state", state).maybeSingle();
  if (!stateRow) return redirect("error", "invalid_or_expired_state");
  await admin.from("facebook_oauth_states").delete().eq("state", state);

  const codeExchangeUrl = new URL(`${GRAPH_API_BASE}/oauth/access_token`);
  codeExchangeUrl.searchParams.set("client_id", FACEBOOK_APP_ID);
  codeExchangeUrl.searchParams.set("client_secret", FACEBOOK_APP_SECRET);
  codeExchangeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  codeExchangeUrl.searchParams.set("code", code);
  let shortLivedBody: Record<string, unknown>;
  try {
    const shortLivedRes = await fetch(codeExchangeUrl.toString());
    shortLivedBody = await shortLivedRes.json();
    console.log("[facebook-oauth-callback] short-lived token exchange", { ok: shortLivedRes.ok, status: shortLivedRes.status, body: shortLivedBody });
    if (!shortLivedRes.ok || !shortLivedBody.access_token) {
      console.error("[facebook-oauth-callback] Code exchange failed", shortLivedBody);
      return redirect("error", "token_exchange_failed");
    }
  } catch (e) {
    console.error("[facebook-oauth-callback] Code exchange threw", e);
    return redirect("error", "token_exchange_failed");
  }

  const longLivedUrl = new URL(`${GRAPH_API_BASE}/oauth/access_token`);
  longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
  longLivedUrl.searchParams.set("client_id", FACEBOOK_APP_ID);
  longLivedUrl.searchParams.set("client_secret", FACEBOOK_APP_SECRET);
  longLivedUrl.searchParams.set("fb_exchange_token", shortLivedBody.access_token as string);
  let longLivedBody: Record<string, unknown>;
  try {
    const longLivedRes = await fetch(longLivedUrl.toString());
    longLivedBody = await longLivedRes.json();
    console.log("[facebook-oauth-callback] long-lived token exchange", { ok: longLivedRes.ok, status: longLivedRes.status, body: longLivedBody });
    if (!longLivedRes.ok || !longLivedBody.access_token) {
      console.error("[facebook-oauth-callback] Long-lived token exchange failed", longLivedBody);
      return redirect("error", "token_exchange_failed");
    }
  } catch (e) {
    console.error("[facebook-oauth-callback] Long-lived token exchange threw", e);
    return redirect("error", "token_exchange_failed");
  }

  // Which Page(s) this user just authorised - takes the first one. A user
  // who manages multiple Pages should only grant this app access to the
  // one this tenant should connect on Facebook's own consent screen; if
  // the wrong one ends up connected, disconnect and reconnect, granting
  // only the correct Page next time - same "no org/Page picker in Phase 1"
  // limitation xero-oauth-callback already documents for Xero.
  const pagesRes = await fetch(`${GRAPH_API_BASE}/me/accounts?access_token=${encodeURIComponent(longLivedBody.access_token as string)}`);
  const pagesBody = await pagesRes.json();
  const pages = pagesBody?.data;
  console.log("[facebook-oauth-callback] managed Pages lookup", { ok: pagesRes.ok, status: pagesRes.status, body: pagesBody });
  if (!pagesRes.ok || !Array.isArray(pages) || pages.length === 0) {
    console.error("[facebook-oauth-callback] Failed to fetch managed Pages", pagesBody);
    return redirect("error", "no_facebook_page_authorised");
  }
  const page = pages[0];

  // Subscribing this app to the Page's messaging events is a separate
  // step from getting the Page token - without this, Facebook never calls
  // facebook-messenger-webhook for messages sent to this Page at all.
  const subscribeUrl = new URL(`${GRAPH_API_BASE}/${page.id}/subscribed_apps`);
  subscribeUrl.searchParams.set("subscribed_fields", "messages,messaging_postbacks");
  subscribeUrl.searchParams.set("access_token", page.access_token);
  const subscribeRes = await fetch(subscribeUrl.toString(), { method: "POST" });
  const subscribeBody = await subscribeRes.json();
  console.log("[facebook-oauth-callback] Page webhook subscription", { ok: subscribeRes.ok, status: subscribeRes.status, body: subscribeBody });
  if (!subscribeRes.ok || !subscribeBody.success) {
    console.error("[facebook-oauth-callback] Failed to subscribe Page to webhook", subscribeBody);
    return redirect("error", "webhook_subscription_failed");
  }

  const { error: upsertError } = await admin.from("facebook_connections").upsert(
    {
      tenant_id: stateRow.tenant_id,
      page_id: page.id,
      page_name: page.name ?? null,
      page_access_token: page.access_token,
      connected_by: stateRow.created_by,
      connected_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id" }
  );
  if (upsertError) {
    console.error("[facebook-oauth-callback] Failed to store Facebook connection", upsertError.message);
    return redirect("error", "server_error");
  }

  // Mirrors the connection into channel_connections too - see that table's
  // own comment in the channels migration for why it exists (a light,
  // provider-agnostic status/config row Channels' own UI can read without
  // needing to know each provider's specific connections table).
  await admin.from("channel_connections").upsert(
    {
      tenant_id: stateRow.tenant_id,
      channel_type: "messenger",
      status: "connected",
      config: { page_id: page.id, page_name: page.name ?? null },
      connected_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,channel_type" }
  );

  return redirect("connected");
});

// Stripe Connect onboarding start/resume for a tenant's own membership
// payouts - each tenant is a separate business, so membership payments must
// land in THEIR OWN bank account, not a shared platform account. This is a
// genuinely new mechanism, separate from the existing invoice-payment
// Stripe code (supabase/functions/approve + stripe-webhook), which uses its
// own STRIPE_SECRET_KEY for that account's Checkout Sessions.
//
// Uses a SEPARATE secret, STRIPE_CONNECT_SECRET_KEY, for the platform
// account that manages Connect - Stripe does not allow an existing
// merchant account (one that already accepts payments for its own
// business, like the invoice-payment feature's account) to also become a
// Connect platform; it requires a distinct account created specifically
// for that role ("Connect is not available for this account... create a
// new account to build a Connect integration" is Stripe's own wording for
// this). That new platform account's own secret key is
// STRIPE_CONNECT_SECRET_KEY - Connect account creation/account links are
// made WITH it (Stripe's own design: the platform manages connected
// accounts using its own credentials), and the later
// create-membership-checkout/membership-stripe-webhook functions reuse the
// same key to act "as" a connected account, via the Stripe-Account header.
//
// Express (not Standard) accounts - Standard hands the tenant a fully
// independent Stripe dashboard with your platform as a mere "partner" they
// manage separately; Express keeps onboarding embedded in this app's own
// Settings page (an Account Link the tenant is redirected to and returns
// from) and is the normal choice for a vertical SaaS charging on the
// tenant's behalf, which is what this is. business_type is deliberately
// left unset at creation time - Stripe's own Express onboarding flow asks
// for it interactively, rather than this app guessing "company" for what
// might really be a sole trader.
//
// No stripe-node SDK - same "one small piece of protocol, not worth a
// whole dependency" call as every other Stripe integration in this repo,
// raw REST calls over fetch.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STRIPE_CONNECT_SECRET_KEY = Deno.env.get("STRIPE_CONNECT_SECRET_KEY") ?? "";

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

async function stripePost(path: string, form: URLSearchParams, stripeAccount?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_CONNECT_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (stripeAccount) headers["Stripe-Account"] = stripeAccount;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { method: "POST", headers, body: form.toString() });
  return { ok: res.ok, status: res.status, body: await res.json() };
}

async function stripeGet(path: string, stripeAccount?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${STRIPE_CONNECT_SECRET_KEY}` };
  if (stripeAccount) headers["Stripe-Account"] = stripeAccount;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { headers });
  return { ok: res.ok, status: res.status, body: await res.json() };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: new Headers(CORS_HEADERS) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!STRIPE_CONNECT_SECRET_KEY) return json({ error: "stripe_not_configured" }, 400);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  let body: { return_url?: string; refresh_url?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await callerClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);
  const { data: callerProfile } = await callerClient.from("profiles").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!callerProfile || callerProfile.role !== "admin") return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: tenant } = await admin.from("tenants").select("*").eq("id", callerProfile.tenant_id).single();
  if (!tenant) return json({ error: "not_found" }, 404);

  let accountId: string | null = tenant.stripe_connect_account_id;

  if (!accountId) {
    const form = new URLSearchParams();
    form.set("type", "express");
    form.set("country", "AU");
    form.set("capabilities[card_payments][requested]", "true");
    form.set("capabilities[transfers][requested]", "true");
    if (tenant.email) form.set("email", tenant.email);

    const created = await stripePost("accounts", form);
    if (!created.ok) {
      console.error("[stripe-connect-onboard] Failed to create connected account", created.body);
      return json({ error: "stripe_error", detail: created.body?.error?.message }, 500);
    }
    accountId = created.body.id;

    const { error: updateError } = await admin.from("tenants").update({ stripe_connect_account_id: accountId }).eq("id", tenant.id);
    if (updateError) return json({ error: "server_error" }, 500);
  } else {
    // Already has a connected account - check its current state so
    // stripe_connect_onboarded reflects reality even if onboarding was
    // finished in a browser tab this app never saw return (e.g. the
    // tenant closed the tab before the return_url page loaded).
    const existing = await stripeGet(`accounts/${accountId}`);
    if (existing.ok && existing.body.details_submitted && existing.body.charges_enabled) {
      await admin.from("tenants").update({ stripe_connect_onboarded: true }).eq("id", tenant.id);
      return json({ ok: true, already_onboarded: true });
    }
  }

  const linkForm = new URLSearchParams();
  linkForm.set("account", accountId!);
  linkForm.set("type", "account_onboarding");
  linkForm.set("refresh_url", body.refresh_url || "https://example.com/stripe/refresh");
  linkForm.set("return_url", body.return_url || "https://example.com/stripe/return");

  const link = await stripePost("account_links", linkForm);
  if (!link.ok) {
    console.error("[stripe-connect-onboard] Failed to create account link", link.body);
    return json({ error: "stripe_error", detail: link.body?.error?.message }, 500);
  }

  return json({ ok: true, onboarding_url: link.body.url });
});

// Creates (or reuses) a Stripe Checkout Session in subscription mode on
// the tenant's own Stripe Connect account, given a client_id - this is
// what "Enrol in Membership" on a client calls. Reuses an existing Stripe
// customer for that client if one already exists (from a past enrollment,
// even a cancelled one), otherwise creates one. Also lazily creates the
// Stripe Product/Price for the tenant's one active membership plan the
// first time it's needed, persisting membership_plans.stripe_price_id so
// every subsequent enrollment reuses the same Price object.
//
// Every Stripe call here passes the Stripe-Account header - this makes
// Stripe treat the request as if made directly by the connected account
// (its own customers/products/prices/checkout sessions), which is what
// makes membership payments actually land in that tenant's own Stripe
// balance rather than the platform's. Same raw-fetch, no-SDK style as
// every other Stripe integration in this repo.
//
// Admin-only, same auth pattern as the "approve" function's
// createPaymentLinkForAdmin - a bearer token from a signed-in user,
// scoped to their own tenant, checked against profiles.role directly
// (rather than relying on RLS alone) since this function uses the service
// role key for its own reads/writes.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

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

async function stripePost(path: string, form: URLSearchParams, stripeAccount: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Stripe-Account": stripeAccount,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  return { ok: res.ok, status: res.status, body: await res.json() };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: new Headers(CORS_HEADERS) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!STRIPE_SECRET_KEY) return json({ error: "stripe_not_configured" }, 400);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  let body: { client_id?: string; success_url?: string; cancel_url?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!body.client_id) return json({ error: "bad_request" }, 400);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await callerClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);
  const { data: callerProfile } = await callerClient.from("profiles").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!callerProfile || callerProfile.role !== "admin") return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: tenant } = await admin.from("tenants").select("*").eq("id", callerProfile.tenant_id).single();
  if (!tenant?.stripe_connect_account_id || !tenant.stripe_connect_onboarded) {
    return json({ error: "stripe_not_connected" }, 400);
  }
  const accountId = tenant.stripe_connect_account_id as string;

  const { data: client } = await admin.from("clients").select("*").eq("id", body.client_id).eq("tenant_id", tenant.id).maybeSingle();
  if (!client) return json({ error: "not_found" }, 404);

  const { data: plan } = await admin.from("membership_plans").select("*").eq("tenant_id", tenant.id).eq("is_active", true).maybeSingle();
  if (!plan) return json({ error: "no_active_plan" }, 400);

  // Lazily create the Stripe Product/Price for this plan the first time
  // it's needed - membership_plans is "one row per tenant for now" (see
  // the schema migration's own comment), so this only runs once per tenant
  // until they change the price, at which point stripe_price_id would need
  // to be cleared for a new one to be created (not automated here - a
  // price change is a deliberate admin action, not a side effect of the
  // next enrollment).
  let priceId = plan.stripe_price_id as string | null;
  if (!priceId) {
    const productForm = new URLSearchParams();
    productForm.set("name", plan.name);
    const product = await stripePost("products", productForm, accountId);
    if (!product.ok) {
      console.error("[create-membership-checkout] Failed to create Stripe product", product.body);
      return json({ error: "stripe_error", detail: product.body?.error?.message }, 500);
    }

    const priceForm = new URLSearchParams();
    priceForm.set("product", product.body.id);
    priceForm.set("currency", "aud");
    priceForm.set("unit_amount", String(plan.annual_price_cents));
    priceForm.set("recurring[interval]", "year");
    const price = await stripePost("prices", priceForm, accountId);
    if (!price.ok) {
      console.error("[create-membership-checkout] Failed to create Stripe price", price.body);
      return json({ error: "stripe_error", detail: price.body?.error?.message }, 500);
    }
    priceId = price.body.id;

    const { error: updateError } = await admin.from("membership_plans").update({ stripe_price_id: priceId }).eq("id", plan.id);
    if (updateError) return json({ error: "server_error" }, 500);
  }

  // Reuse an existing Stripe customer for this client if one already
  // exists (from a past enrollment, even a cancelled one) - otherwise
  // create one now.
  const { data: priorMembership } = await admin
    .from("client_memberships")
    .select("stripe_customer_id")
    .eq("client_id", client.id)
    .eq("tenant_id", tenant.id)
    .not("stripe_customer_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let customerId = priorMembership?.stripe_customer_id as string | undefined;
  if (!customerId) {
    const customerForm = new URLSearchParams();
    customerForm.set("name", client.name);
    if (client.email) customerForm.set("email", client.email);
    if (client.phone) customerForm.set("phone", client.phone);
    const customer = await stripePost("customers", customerForm, accountId);
    if (!customer.ok) {
      console.error("[create-membership-checkout] Failed to create Stripe customer", customer.body);
      return json({ error: "stripe_error", detail: customer.body?.error?.message }, 500);
    }
    customerId = customer.body.id;
  }

  const sessionForm = new URLSearchParams();
  sessionForm.set("mode", "subscription");
  sessionForm.set("customer", customerId);
  sessionForm.set("line_items[0][price]", priceId!);
  sessionForm.set("line_items[0][quantity]", "1");
  sessionForm.set("success_url", body.success_url || "https://example.com/membership/success");
  sessionForm.set("cancel_url", body.cancel_url || "https://example.com/membership/cancel");
  sessionForm.set("metadata[client_id]", client.id);
  sessionForm.set("metadata[tenant_id]", tenant.id);
  sessionForm.set("metadata[membership_plan_id]", plan.id);

  const session = await stripePost("checkout/sessions", sessionForm, accountId);
  if (!session.ok) {
    console.error("[create-membership-checkout] Failed to create checkout session", session.body);
    return json({ error: "stripe_error", detail: session.body?.error?.message }, 500);
  }

  return json({ ok: true, checkout_url: session.body.url });
});

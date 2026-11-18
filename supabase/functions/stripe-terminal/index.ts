// Tap to Pay on Android (Stripe Terminal) - the server side of the phone
// app's "Take payment" screen.
//
// The phone never holds the Stripe secret key. It calls this function (as
// the signed-in user) for:
//   connection_token  - what the Terminal SDK asks for to talk to Stripe
//   location          - the Stripe Terminal "location" Tap to Pay registers
//                       the phone under (made once from the company
//                       address, saved on tenants.stripe_terminal_location_id)
//   create_intent     - a card_present PaymentIntent for an invoice (any
//                       amount up to the balance - part payments) or a
//                       quote (deposit), at exactly that amount: no card
//                       surcharge (not allowed in Australia)
//   confirm           - after the tap, checks with Stripe that the charge
//                       succeeded and records it as a payment. The
//                       stripe-webhook does the same on
//                       payment_intent.succeeded in case the phone drops
//                       out before this call - both are no-ops the
//                       second time (one row per payment intent).
//
// Uses the same STRIPE_SECRET_KEY as the online Checkout links, so card
// payments taken either way land in the same Stripe account. Deployed
// WITH the usual JWT check (only signed-in staff can call it).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

// Stripe's REST API with a form body - one small call each, not worth
// the SDK (same choice as the approve function).
async function stripe(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = await res.json();
  if (!res.ok) console.error(`[stripe-terminal] Stripe ${method} ${path} failed`, res.status, body?.error?.message);
  return { ok: res.ok, status: res.status, body };
}

function stripeError(result: { body: any }): Response {
  return json({ error: "stripe_error", detail: result.body?.error?.message ?? "Stripe didn't accept that" }, 502);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!STRIPE_SECRET_KEY) return json({ error: "stripe_not_configured" }, 400);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await caller.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);
  const { data: profile } = await caller.from("profiles").select("id, tenant_id").eq("id", authData.user.id).single();
  if (!profile) return json({ error: "unauthorized" }, 401);

  let body: { action?: string; invoice_id?: string; quote_id?: string; amount_cents?: number; payment_intent_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if (body.action === "connection_token") {
    const result = await stripe("POST", "terminal/connection_tokens");
    if (!result.ok) return stripeError(result);
    return json({ secret: result.body.secret });
  }

  if (body.action === "location") {
    const { data: tenant } = await admin
      .from("tenants")
      .select("id, name, stripe_terminal_location_id, business_address_line1, business_address_line2, business_suburb, business_state, business_postcode")
      .eq("id", profile.tenant_id)
      .single();
    if (!tenant) return json({ error: "not_found" }, 404);

    // Still there? (It won't be if the Stripe key was swapped, e.g. test
    // keys for live ones - locations belong to one mode.)
    if (tenant.stripe_terminal_location_id) {
      const existing = await stripe("GET", `terminal/locations/${encodeURIComponent(tenant.stripe_terminal_location_id)}`);
      if (existing.ok && !existing.body.deleted) {
        return json({ location_id: existing.body.id, livemode: existing.body.livemode === true, merchant_display_name: tenant.name });
      }
    }

    if (!tenant.business_address_line1 || !tenant.business_suburb || !tenant.business_state || !tenant.business_postcode) {
      return json({ error: "address_missing", detail: "Add the business address in Settings > Company Details first - Stripe needs it to set up Tap to Pay." }, 400);
    }
    const form: Record<string, string> = {
      display_name: tenant.name || "Business",
      "address[line1]": tenant.business_address_line1,
      "address[city]": tenant.business_suburb,
      "address[state]": tenant.business_state,
      "address[postal_code]": tenant.business_postcode,
      "address[country]": "AU",
    };
    if (tenant.business_address_line2) form["address[line2]"] = tenant.business_address_line2;
    const created = await stripe("POST", "terminal/locations", form);
    if (!created.ok) return stripeError(created);
    await admin.from("tenants").update({ stripe_terminal_location_id: created.body.id }).eq("id", tenant.id);
    return json({ location_id: created.body.id, livemode: created.body.livemode === true, merchant_display_name: tenant.name });
  }

  if (body.action === "create_intent") {
    const amountCents = Math.round(Number(body.amount_cents));
    if (!Number.isFinite(amountCents) || amountCents < 50) return json({ error: "bad_amount", detail: "Card payments must be at least $0.50." }, 400);
    if (!!body.invoice_id === !!body.quote_id) return json({ error: "bad_request" }, 400);

    let description: string;
    let clientEmail: string | null = null;
    let balanceCents: number;
    const metadata: Record<string, string> = { jms_source: "terminal", tenant_id: profile.tenant_id, recorded_by: profile.id };

    if (body.invoice_id) {
      const { data: invoice } = await admin
        .from("invoices")
        .select("id, invoice_number, status, total_cents, amount_paid_cents, clients(email)")
        .eq("id", body.invoice_id)
        .eq("tenant_id", profile.tenant_id)
        .maybeSingle();
      if (!invoice) return json({ error: "not_found" }, 404);
      if (invoice.status === "void") return json({ error: "void", detail: "This invoice is void." }, 400);
      balanceCents = Math.max(Number(invoice.total_cents) - Number(invoice.amount_paid_cents), 0);
      description = `Invoice ${invoice.invoice_number}`;
      clientEmail = (invoice as any).clients?.email ?? null;
      metadata.invoice_id = invoice.id;
      metadata.kind = "payment";
    } else {
      const { data: quote } = await admin
        .from("quotes")
        .select("id, quote_number, status, total_cents, deposit_paid_cents, clients(email)")
        .eq("id", body.quote_id!)
        .eq("tenant_id", profile.tenant_id)
        .maybeSingle();
      if (!quote) return json({ error: "not_found" }, 404);
      if (quote.status === "draft") return json({ error: "draft", detail: "Send the quote before taking a deposit on it." }, 400);
      if (quote.status === "declined" || quote.status === "expired") return json({ error: "closed", detail: `This quote is ${quote.status}.` }, 400);
      balanceCents = Math.max(Number(quote.total_cents) - Number(quote.deposit_paid_cents), 0);
      description = `Deposit for quote ${quote.quote_number}`;
      clientEmail = (quote as any).clients?.email ?? null;
      metadata.quote_id = quote.id;
      metadata.kind = "deposit";
    }
    if (balanceCents <= 0) {
      return json({ error: "already_paid", detail: "This is already paid in full." }, 400);
    }
    if (amountCents > balanceCents) {
      return json({ error: "too_much", detail: `That's more than the $${(balanceCents / 100).toFixed(2)} still owing.` }, 400);
    }

    const form: Record<string, string> = {
      amount: String(amountCents),
      currency: "aud",
      "payment_method_types[]": "card_present",
      capture_method: "automatic",
      description,
    };
    for (const [key, value] of Object.entries(metadata)) form[`metadata[${key}]`] = value;
    // Stripe emails the card receipt (live mode only).
    if (clientEmail) form.receipt_email = clientEmail;
    const created = await stripe("POST", "payment_intents", form);
    if (!created.ok) return stripeError(created);
    return json({ payment_intent_id: created.body.id, client_secret: created.body.client_secret, amount_cents: amountCents });
  }

  if (body.action === "confirm") {
    if (!body.payment_intent_id) return json({ error: "bad_request" }, 400);
    const result = await stripe("GET", `payment_intents/${encodeURIComponent(body.payment_intent_id)}`);
    if (!result.ok) return stripeError(result);
    const intent = result.body;
    const metadata = (intent.metadata ?? {}) as Record<string, string>;
    if (metadata.jms_source !== "terminal" || metadata.tenant_id !== profile.tenant_id) return json({ error: "not_found" }, 404);
    if (intent.status !== "succeeded") return json({ ok: false, status: intent.status });

    const { data, error } = await admin.rpc("record_stripe_payment", {
      p_tenant_id: profile.tenant_id,
      p_invoice_id: metadata.invoice_id || null,
      p_quote_id: metadata.invoice_id ? null : metadata.quote_id || null,
      p_amount_cents: Number(intent.amount_received ?? intent.amount),
      p_method: "tap_to_pay",
      p_stripe_payment_intent_id: intent.id,
      p_stripe_checkout_session_id: null,
      p_recorded_by: metadata.recorded_by || profile.id,
    });
    if (error) {
      console.error("[stripe-terminal] record_stripe_payment failed", error.message);
      return json({ error: "record_failed", detail: "The card was charged but the payment couldn't be saved - it will be picked up from Stripe shortly." }, 500);
    }
    return json({ ok: true, status: "succeeded", payment_id: data?.payment_id ?? null, amount_cents: Number(intent.amount_received ?? intent.amount) });
  }

  return json({ error: "bad_request" }, 400);
});

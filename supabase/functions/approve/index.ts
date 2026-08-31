// Public, unauthenticated JSON API for the quote/invoice approval page.
// Deployed as a Supabase Edge Function (Deno runtime, npm: specifiers
// supported).
//
// This used to render the HTML page itself, but Supabase's platform force-
// downgrades any HTML-looking Edge Function response on the shared
// *.supabase.co domain to inert text/plain with a
// `Content-Security-Policy: default-src 'none'; sandbox` header - a
// deliberate anti-phishing measure (a function serving *interactive* HTML
// under a trusted shared domain is exactly what that policy exists to
// block), confirmed by inspecting the actual response headers rather than
// guessed at. There's no header this function can set to opt back out of
// it short of attaching a paid custom domain to the project. JSON
// responses aren't subject to that restriction, so this function is now a
// plain data API, and the actual page lives as a static HTML/JS file in
// Supabase Storage instead (see supabase/static/approval-page.html) -
// Storage-served files don't get the same lockdown, and Storage is
// already part of this app's stack (same place the company logo lives).
//
// Every actual read and write still goes through the SECURITY DEFINER
// RPCs added in supabase/migrations/20260728000100_quote_invoice_approval.sql
// (get_quote_for_approval, accept_quote_by_token, etc.) using the plain
// anon key - the token itself is the credential, validated server-side in
// those functions (existence, expiry, current status), not here. This
// function never touches the database directly and never sees the
// service role key.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

type DocType = "quote" | "invoice" | "nte_variation" | "po_quote";

// "authorization" added alongside the original "content-type" - the public
// approval page never sent an Authorization header (the token in the
// request body is its credential), but InvoiceDetail.tsx's "Create Stripe
// payment link" button does (see createPaymentLinkForAdmin), sent with the
// signed-in admin's own bearer token. Without "authorization" listed here,
// the browser's CORS preflight rejects that header before the request ever
// reaches this function - same class of bug already documented in
// dispatch-now.ts/process-scheduled-comms's own CORS_HEADERS comment.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: new Headers(CORS_HEADERS) });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  if (req.method === "GET") {
    const url = new URL(req.url);
    const docType = url.searchParams.get("type");
    const token = url.searchParams.get("token");
    if ((docType !== "quote" && docType !== "invoice" && docType !== "nte_variation" && docType !== "po_quote") || !token) {
      return json({ error: "bad_request" }, 400);
    }
    // get_${type}_for_approval - same generic name shape for all four,
    // matching the RPC names in the quote_invoice_approval,
    // real_estate_nte_and_invoicing, and subcontractor_management
    // migrations. po_quote's RPC is literally named get_po_quote_for_approval,
    // so this generic template still lines up.
    const { data, error } = await supabase.rpc(`get_${docType}_for_approval`, { p_token: token });
    if (error) return json({ error: "server_error" }, 500);
    return json(data);
  }

  if (req.method === "POST") {
    let body: {
      type?: string;
      token?: string;
      action?: string;
      name?: string;
      reason?: string;
      amount_cents?: number;
      signature_svg?: string;
      invoice_id?: string;
      approval_page_url?: string;
      included_optional_item_ids?: string[];
    };
    try {
      body = await req.json();
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    const {
      type: docType,
      token,
      action,
      name,
      reason,
      amount_cents,
      signature_svg,
      invoice_id,
      approval_page_url,
      included_optional_item_ids,
    } = body;

    // Stripe Checkout link creation - the office's own admin-authenticated
    // path (a bearer token from a signed-in user, not a client-facing
    // approval token), called from InvoiceDetail.tsx to generate/regenerate
    // the link to (re)send.
    if (docType === "invoice" && action === "create_payment_link") {
      return createPaymentLinkForAdmin(req, invoice_id, approval_page_url);
    }

    // Same Stripe Checkout link creation, but reached by the client's own
    // invoice link (the approval-page token, not a bearer token) - this is
    // what makes "the invoice link takes me to a payment page" work once
    // it's already been accepted, without the client needing the office to
    // generate anything first.
    if (docType === "invoice" && action === "get_payment_link" && token) {
      return getPaymentLinkForToken(token, approval_page_url);
    }

    if (!token) {
      return json({ error: "bad_request" }, 400);
    }

    // NTE variation only has one resolution (approve) - see the
    // real_estate_nte_and_invoicing migration's own comment for why there's
    // no decline path, unlike quote/invoice's accept/decline pair below.
    if (docType === "nte_variation") {
      if (action !== "approve") return json({ error: "bad_request" }, 400);
      const { data, error } = await supabase.rpc("approve_nte_variation_by_token", { p_token: token });
      if (error) return json({ error: "server_error" }, 500);
      return json(data);
    }

    // po_quote also has one resolution - a subcontractor submitting their
    // quoted dollar figure (Workflow 3). See submit_po_quote_by_token in
    // the subcontractor_management migration.
    if (docType === "po_quote") {
      if (action !== "submit") return json({ error: "bad_request" }, 400);
      const { data, error } = await supabase.rpc("submit_po_quote_by_token", {
        p_token: token,
        p_amount_cents: amount_cents ?? null,
      });
      if (error) return json({ error: "server_error" }, 500);
      return json(data);
    }

    if (docType !== "quote" && docType !== "invoice") {
      return json({ error: "bad_request" }, 400);
    }
    const rpcPrefix: DocType = docType;

    if (action === "accept") {
      // included_optional_item_ids only means anything for a quote -
      // accept_invoice_by_token has no such parameter (invoices never carry
      // optional line items, see the optional_bundled_line_items migration),
      // so it's only added to the RPC params for docType === "quote".
      const rpcParams: Record<string, unknown> = {
        p_token: token,
        p_name: name ?? "",
        p_signature_svg: signature_svg ?? null,
      };
      if (rpcPrefix === "quote") {
        rpcParams.p_included_optional_item_ids = included_optional_item_ids ?? [];
      }
      const { data, error } = await supabase.rpc(`accept_${rpcPrefix}_by_token`, rpcParams);
      if (error) return json({ error: "server_error" }, 500);
      return json(data);
    }
    if (action === "decline") {
      const { data, error } = await supabase.rpc(`decline_${rpcPrefix}_by_token`, {
        p_token: token,
        p_reason: reason ?? "",
      });
      if (error) return json({ error: "server_error" }, 500);
      return json(data);
    }
    return json({ error: "bad_request" }, 400);
  }

  return json({ error: "method_not_allowed" }, 405);
});

// Shared by both entry points below: given an already-fetched invoice row
// (admin/service-role client, full columns), returns its Stripe Checkout
// URL - reusing an existing session if one's already been created (Stripe
// Checkout Sessions stay open, and their url usable, for 24 hours by
// default, so this avoids handing out a second, different link for the
// same invoice while the first one's still valid), otherwise creating one
// via the Stripe REST API directly over fetch (no SDK - a single REST call
// doesn't need the extra dependency weight).
async function getOrCreateStripeCheckoutUrl(
  admin: ReturnType<typeof createClient>,
  invoice: Record<string, any>,
  approvalPageUrl: string | undefined
): Promise<{ ok: true; checkout_url: string } | { ok: false; error: string; detail?: string; status: number }> {
  if (invoice.approval_status !== "accepted") return { ok: false, error: "not_accepted", status: 400 };
  if (invoice.status === "paid") return { ok: false, error: "already_paid", status: 400 };
  if (invoice.stripe_checkout_url) return { ok: true, checkout_url: invoice.stripe_checkout_url };
  if (!STRIPE_SECRET_KEY) return { ok: false, error: "stripe_not_configured", status: 400 };

  const successUrl = approvalPageUrl ? `${approvalPageUrl}?type=invoice&token=${invoice.access_token}&paid=1` : "https://example.com/paid";
  const cancelUrl = approvalPageUrl ? `${approvalPageUrl}?type=invoice&token=${invoice.access_token}` : "https://example.com";

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", successUrl);
  form.set("cancel_url", cancelUrl);
  form.set("line_items[0][price_data][currency]", "aud");
  form.set("line_items[0][price_data][product_data][name]", `Invoice ${invoice.invoice_number}`);
  form.set("line_items[0][price_data][unit_amount]", String(invoice.total_cents));
  form.set("line_items[0][quantity]", "1");
  form.set("metadata[invoice_id]", invoice.id);
  if (invoice.clients?.email) form.set("customer_email", invoice.clients.email);

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const stripeBody = await stripeRes.json();
  if (!stripeRes.ok) {
    console.error("[approve] Stripe checkout session creation failed", stripeBody);
    return { ok: false, error: "stripe_error", detail: stripeBody?.error?.message, status: 500 };
  }

  const { error: updateError } = await admin
    .from("invoices")
    .update({ stripe_checkout_url: stripeBody.url, stripe_checkout_session_id: stripeBody.id })
    .eq("id", invoice.id);
  if (updateError) return { ok: false, error: "server_error", status: 500 };

  return { ok: true, checkout_url: stripeBody.url as string };
}

// Admin-authenticated path - caller's own bearer token, scoped to their
// tenant. Called from InvoiceDetail.tsx.
async function createPaymentLinkForAdmin(req: Request, invoiceId: string | undefined, approvalPageUrl: string | undefined): Promise<Response> {
  if (!invoiceId) return json({ error: "bad_request" }, 400);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await callerClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);
  const { data: callerProfile } = await callerClient.from("profiles").select("tenant_id").eq("id", authData.user.id).single();
  if (!callerProfile) return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: invoice } = await admin
    .from("invoices")
    .select("*, clients(name, email)")
    .eq("id", invoiceId)
    .eq("tenant_id", callerProfile.tenant_id)
    .maybeSingle();
  if (!invoice) return json({ error: "not_found" }, 404);

  const result = await getOrCreateStripeCheckoutUrl(admin, invoice, approvalPageUrl);
  return result.ok ? json({ ok: true, checkout_url: result.checkout_url }) : json({ error: result.error, detail: result.detail }, result.status);
}

// Public, token-authenticated path - reached by the client's own invoice
// link once it's already been accepted, same trust model as accept/decline
// (the token is the credential, validated here exactly like the by_token
// RPCs validate it: exists, not expired).
async function getPaymentLinkForToken(token: string, approvalPageUrl: string | undefined): Promise<Response> {
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: invoice } = await admin.from("invoices").select("*, clients(name, email)").eq("access_token", token).maybeSingle();
  if (!invoice) return json({ error: "not_found" }, 404);
  if (invoice.token_expires_at && new Date(invoice.token_expires_at) < new Date()) return json({ error: "expired" }, 400);

  const result = await getOrCreateStripeCheckoutUrl(admin, invoice, approvalPageUrl);
  return result.ok ? json({ ok: true, checkout_url: result.checkout_url }) : json({ error: result.error, detail: result.detail }, result.status);
}

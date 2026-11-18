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

const SEND_NOTIFICATION_URL = `${SUPABASE_URL}/functions/v1/send-notification`;

// Best-effort, same pattern as the inbound-message webhooks' own
// notifyNewMessage - "quote acceptances" was on section 68's own
// originally-scoped notification roadmap but never wired up. Looked up
// separately here via the admin client, rather than returned from the
// accept_*_by_token RPCs, to avoid touching those RPCs' return shape -
// the approval page itself only ever reads `data.error` from a
// successful accept, nothing else, so this stays fully additive.
async function notifyDocumentAccepted(docType: DocType, token: string, acceptedByName: string): Promise<void> {
  if (docType !== "quote" && docType !== "invoice") return;
  if (!SUPABASE_SERVICE_ROLE_KEY) return;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const table = docType === "quote" ? "quotes" : "invoices";
  const numberColumn = docType === "quote" ? "quote_number" : "invoice_number";
  const { data: doc } = await admin.from(table).select(`id, tenant_id, ${numberColumn}, clients(name)`).eq("access_token", token).maybeSingle();
  if (!doc) return;
  const docNumber = (doc as Record<string, unknown>)[numberColumn];
  const clientName = (doc as any).clients?.name as string | undefined;
  const label = docType === "quote" ? "Quote" : "Invoice";
  try {
    const res = await fetch(SEND_NOTIFICATION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_id: doc.tenant_id,
        type: `${docType}_accepted`,
        title: `${label} accepted`,
        body: `${acceptedByName || clientName || "A client"} accepted ${label} #${docNumber}`,
        data: { [`${docType}_id`]: doc.id },
      }),
    });
    if (!res.ok) console.error("[approve] send-notification call failed", res.status, await res.text());
  } catch (e) {
    console.error("[approve] send-notification call threw", e);
  }
}

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
    // Deposit / amount paid / balance (payments migration), merged in so
    // the page can offer "Pay deposit" or "Pay $X balance".
    if ((docType === "quote" || docType === "invoice") && data && !data.error) {
      const { data: summary } = await supabase.rpc("get_payment_summary_by_token", { p_type: docType, p_token: token });
      return json({ ...data, payment_summary: summary ?? null, online_payment_available: !!STRIPE_SECRET_KEY });
    }
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

    // A quote's deposit, paid online from the client's quote link once
    // they've accepted it.
    if (docType === "quote" && action === "get_deposit_link" && token) {
      return getDepositLinkForToken(token, approval_page_url);
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
      if (!data?.error) await notifyDocumentAccepted(rpcPrefix, token, name ?? "");
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
// (admin/service-role client, full columns), returns a Stripe Checkout URL
// for what's still owing on it. The balance, not the total - deposits and
// part payments already recorded come off (payments migration).
//
// A link already made for the same balance in the last 23 hours is handed
// out again (Checkout Sessions stay usable for 24 hours), so the client
// doesn't get a second, different link for the same thing. Any payment
// recorded against the invoice clears the cached link, so a link for an
// old balance is never reused. Created via the Stripe REST API directly
// over fetch (no SDK - a single REST call doesn't need the dependency).
const CHECKOUT_REUSE_MS = 23 * 60 * 60 * 1000;

async function createCheckoutSession(params: {
  amountCents: number;
  name: string;
  metadata: Record<string, string>;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ ok: true; id: string; url: string } | { ok: false; detail?: string }> {
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", params.successUrl);
  form.set("cancel_url", params.cancelUrl);
  form.set("line_items[0][price_data][currency]", "aud");
  form.set("line_items[0][price_data][product_data][name]", params.name);
  form.set("line_items[0][price_data][unit_amount]", String(params.amountCents));
  form.set("line_items[0][quantity]", "1");
  for (const [key, value] of Object.entries(params.metadata)) form.set(`metadata[${key}]`, value);
  if (params.customerEmail) form.set("customer_email", params.customerEmail);

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const stripeBody = await stripeRes.json();
  if (!stripeRes.ok) {
    console.error("[approve] Stripe checkout session creation failed", stripeBody);
    return { ok: false, detail: stripeBody?.error?.message };
  }
  return { ok: true, id: stripeBody.id as string, url: stripeBody.url as string };
}

async function getOrCreateStripeCheckoutUrl(
  // A service-role client. Typed loosely: there are no generated database
  // types here, and ReturnType<typeof createClient> resolves to a client
  // whose tables are all `never`.
  // deno-lint-ignore no-explicit-any
  admin: any,
  invoice: Record<string, any>,
  approvalPageUrl: string | undefined
): Promise<{ ok: true; checkout_url: string } | { ok: false; error: string; detail?: string; status: number }> {
  if (invoice.approval_status !== "accepted") return { ok: false, error: "not_accepted", status: 400 };
  if (invoice.status === "void") return { ok: false, error: "void", status: 400 };
  const balanceCents = Math.max(Number(invoice.total_cents) - Number(invoice.amount_paid_cents ?? 0), 0);
  if (invoice.status === "paid" || balanceCents <= 0) return { ok: false, error: "already_paid", status: 400 };
  if (
    invoice.stripe_checkout_url &&
    Number(invoice.stripe_checkout_amount_cents) === balanceCents &&
    invoice.stripe_checkout_created_at &&
    Date.now() - new Date(invoice.stripe_checkout_created_at).getTime() < CHECKOUT_REUSE_MS
  ) {
    return { ok: true, checkout_url: invoice.stripe_checkout_url };
  }
  if (!STRIPE_SECRET_KEY) return { ok: false, error: "stripe_not_configured", status: 400 };

  const pageUrl = approvalPageUrl ? `${approvalPageUrl}?type=invoice&token=${invoice.access_token}` : null;
  const session = await createCheckoutSession({
    amountCents: balanceCents,
    name: balanceCents < Number(invoice.total_cents) ? `Invoice ${invoice.invoice_number} - balance owing` : `Invoice ${invoice.invoice_number}`,
    metadata: { invoice_id: invoice.id, kind: "payment" },
    customerEmail: invoice.clients?.email,
    successUrl: pageUrl ? `${pageUrl}&paid=1` : "https://example.com/paid",
    cancelUrl: pageUrl ?? "https://example.com",
  });
  if (!session.ok) return { ok: false, error: "stripe_error", detail: session.detail, status: 500 };

  const { error: updateError } = await admin
    .from("invoices")
    .update({
      stripe_checkout_url: session.url,
      stripe_checkout_session_id: session.id,
      stripe_checkout_amount_cents: balanceCents,
      stripe_checkout_created_at: new Date().toISOString(),
    })
    .eq("id", invoice.id);
  if (updateError) return { ok: false, error: "server_error", status: 500 };

  return { ok: true, checkout_url: session.url };
}

// Public, token-authenticated - the client's own quote link, after they've
// accepted it. Charges what's left of the deposit the quote asks for.
async function getDepositLinkForToken(token: string, approvalPageUrl: string | undefined): Promise<Response> {
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: quote } = await admin.from("quotes").select("*, clients(name, email)").eq("access_token", token).maybeSingle();
  if (!quote) return json({ error: "not_found" }, 404);
  if (quote.token_expires_at && new Date(quote.token_expires_at) < new Date()) return json({ error: "expired" }, 400);
  if (quote.approval_status !== "accepted") return json({ error: "not_accepted" }, 400);

  const { data: summary } = await admin.rpc("get_payment_summary_by_token", { p_type: "quote", p_token: token });
  const remainingCents = Number(summary?.deposit_remaining_cents ?? 0);
  if (remainingCents <= 0) return json({ error: "already_paid" }, 400);
  if (!STRIPE_SECRET_KEY) return json({ error: "stripe_not_configured" }, 400);

  const pageUrl = approvalPageUrl ? `${approvalPageUrl}?type=quote&token=${quote.access_token}` : null;
  const session = await createCheckoutSession({
    amountCents: remainingCents,
    name: `Deposit for quote ${quote.quote_number}`,
    metadata: { quote_id: quote.id, kind: "deposit" },
    customerEmail: quote.clients?.email,
    successUrl: pageUrl ? `${pageUrl}&paid=1` : "https://example.com/paid",
    cancelUrl: pageUrl ?? "https://example.com",
  });
  if (!session.ok) return json({ error: "stripe_error", detail: session.detail }, 500);
  return json({ ok: true, checkout_url: session.url });
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

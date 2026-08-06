// Xero Phase 2 - the read-back half of the loop Phase 1 deliberately left
// out. Xero POSTs here whenever an Invoice changes in any organisation
// connected to this app (subscribed once, app-wide, in the Xero
// Developer Portal -> Webhooks -> Invoices - not per-tenant). The payload
// itself carries no invoice detail, only which resource changed
// (resourceId/tenantId) - this fetches the current state of that invoice
// from Xero's API and, if Xero now shows it as fully paid, marks the
// matching invoices row here paid too (the existing set_invoice_paid_at/
// calculate_referral_fee_on_invoice_paid triggers then fire exactly as
// they would for a manual/Stripe-driven paid transition - nothing
// Xero-specific needed there).
//
// Also doubles as the "Intent to Receive" handshake Xero requires the
// first time a webhook URL is saved/re-verified in the Developer Portal:
// that request has an empty `events` array but must still be signature-
// verified and answered with a 200, which the logic below does naturally
// (an empty events array just means nothing to process).
//
// Signature verification (HMAC-SHA256 over the raw request body, base64-
// encoded, in the X-Xero-Signature header) is done by hand with Deno's
// Web Crypto SubtleCrypto, same reasoning as stripe-webhook's own
// approach - no SDK needed for one HMAC check.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const XERO_CLIENT_ID = Deno.env.get("XERO_CLIENT_ID") ?? "";
const XERO_CLIENT_SECRET = Deno.env.get("XERO_CLIENT_SECRET") ?? "";
const XERO_WEBHOOK_KEY = Deno.env.get("XERO_WEBHOOK_KEY") ?? "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader || !XERO_WEBHOOK_KEY) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(XERO_WEBHOOK_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));

  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

interface XeroEvent {
  resourceId: string;
  eventCategory: string;
  eventType: string;
  tenantId: string;
}

// Same 60-second-headroom proactive refresh as xero-sync's ensureFreshToken
// - duplicated rather than shared, Edge Functions can't import code from
// outside their own function directory (see other functions' own comments
// on this).
async function ensureFreshToken(admin: ReturnType<typeof createClient>, connection: Record<string, any>): Promise<string | null> {
  const expiresAt = new Date(connection.token_expires_at).getTime();
  if (expiresAt - Date.now() > 60_000) return connection.access_token;

  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: connection.refresh_token }).toString(),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error("[xero-webhook] Token refresh failed", body);
    return null;
  }
  await admin
    .from("xero_connections")
    .update({
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      token_expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(),
    })
    .eq("tenant_id", connection.tenant_id);
  return body.access_token as string;
}

async function processInvoiceEvent(admin: ReturnType<typeof createClient>, event: XeroEvent): Promise<void> {
  const { data: connection } = await admin.from("xero_connections").select("*").eq("xero_tenant_id", event.tenantId).maybeSingle();
  if (!connection) return; // Xero org not connected to any tenant we know about - ignore.

  const { data: invoice } = await admin
    .from("invoices")
    .select("id, status")
    .eq("tenant_id", connection.tenant_id)
    .eq("xero_invoice_id", event.resourceId)
    .maybeSingle();
  if (!invoice) return; // Not an invoice this app pushed/knows about - ignore.
  if (invoice.status === "paid") return; // Already reflected, nothing to do.

  const accessToken = await ensureFreshToken(admin, connection);
  if (!accessToken) return;

  const res = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${event.resourceId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Xero-tenant-id": event.tenantId,
      Accept: "application/json",
    },
  });
  const body = await res.json();
  const xeroInvoice = body?.Invoices?.[0];
  if (!res.ok || !xeroInvoice) {
    console.error("[xero-webhook] Failed to fetch invoice from Xero", body);
    return;
  }

  // "Paid" here means fully paid, matching this app's own binary paid/
  // unpaid model (no partial-payment tracking - see quote-invoice-pdf.ts's
  // own comment on Balance Due) - a partial payment recorded in Xero
  // (AmountDue > 0, Status still AUTHORISED) deliberately doesn't flip
  // anything here yet.
  if (xeroInvoice.Status === "PAID") {
    await admin.from("invoices").update({ status: "paid" }).eq("id", invoice.id);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const rawBody = await req.text();
  const valid = await verifySignature(rawBody, req.headers.get("x-xero-signature"));
  if (!valid) return json({ error: "invalid_signature" }, 401);

  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  let payload: { events?: XeroEvent[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Signature was valid but body isn't JSON - shouldn't happen from
    // Xero itself, but still answer 200 (this is likely the Intent to
    // Receive check, which cares only about signature verification).
    return json({ ok: true });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const events = (payload.events ?? []).filter((e) => e.eventCategory === "INVOICE");
  for (const event of events) {
    try {
      await processInvoiceEvent(admin, event);
    } catch (e) {
      // One bad event shouldn't sink the whole batch (or make Xero think
      // the endpoint is broken and retry-storm it) - log and move on.
      console.error("[xero-webhook] Failed to process event", event, e);
    }
  }

  return json({ ok: true, processed: events.length });
});

// Xero invoice sync - Phase 1 (one-way push, this app -> Xero). Called
// from InvoiceDetail.tsx's "Sync to Xero" button with the signed-in
// admin's own bearer token. For a given invoice: ensures its client has a
// matching Xero Contact (reusing one found by name, or creating one), then
// creates or updates the matching Xero Invoice with this invoice's current
// line items.
//
// Deliberately NOT wired to fire automatically on every status change
// (sent/paid/etc) yet, and deliberately one-way (nothing here reads
// anything back from Xero into this app) - both are real scope, staged
// for a later pass once this manual, one-invoice-at-a-time path has been
// exercised against a real Xero org without surprises. Real accounting
// data is a much less forgiving place to have a bug than most of this
// app's other features.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const XERO_CLIENT_ID = Deno.env.get("XERO_CLIENT_ID") ?? "";
const XERO_CLIENT_SECRET = Deno.env.get("XERO_CLIENT_SECRET") ?? "";

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

// Xero access tokens last 30 minutes; refresh tokens rotate on every use
// (each refresh response contains a NEW refresh_token that must overwrite
// the stored one - the old one stops working) and expire after 60 days of
// inactivity. Refreshing proactively (60s of headroom) rather than
// reactively on a 401 keeps this simple - one refresh check per sync call.
async function ensureFreshToken(
  admin: ReturnType<typeof createClient>,
  connection: Record<string, any>
): Promise<{ accessToken: string; xeroTenantId: string } | { error: string }> {
  const expiresAt = new Date(connection.token_expires_at).getTime();
  if (expiresAt - Date.now() > 60_000) {
    return { accessToken: connection.access_token, xeroTenantId: connection.xero_tenant_id };
  }

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
    console.error("[xero-sync] Token refresh failed", body);
    return { error: "xero_reauth_required" };
  }

  await admin
    .from("xero_connections")
    .update({
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      token_expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(),
    })
    .eq("tenant_id", connection.tenant_id);

  return { accessToken: body.access_token, xeroTenantId: connection.xero_tenant_id };
}

function xeroHeaders(accessToken: string, xeroTenantId: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Xero-tenant-id": xeroTenantId,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

// Finds an existing Xero Contact by exact name match first (so connecting
// Xero to a business with years of existing contacts doesn't immediately
// spam it with duplicates), creates one only if nothing matches.
async function ensureXeroContact(
  admin: ReturnType<typeof createClient>,
  accessToken: string,
  xeroTenantId: string,
  client: { id: string; name: string; company_name: string | null; client_type: string; email: string | null; phone: string | null }
): Promise<{ contactId: string } | { error: string }> {
  const contactName = client.client_type === "company" && client.company_name ? client.company_name : client.name;

  const searchRes = await fetch(`https://api.xero.com/api.xro/2.0/Contacts?where=${encodeURIComponent(`Name=="${contactName.replace(/"/g, '\\"')}"`)}`, {
    headers: xeroHeaders(accessToken, xeroTenantId),
  });
  const searchBody = await searchRes.json();
  if (searchRes.ok && Array.isArray(searchBody.Contacts) && searchBody.Contacts.length > 0) {
    const contactId = searchBody.Contacts[0].ContactID as string;
    await admin.from("clients").update({ xero_contact_id: contactId }).eq("id", client.id);
    return { contactId };
  }

  const createRes = await fetch("https://api.xero.com/api.xro/2.0/Contacts", {
    method: "POST",
    headers: xeroHeaders(accessToken, xeroTenantId),
    body: JSON.stringify({
      Contacts: [
        {
          Name: contactName,
          EmailAddress: client.email || undefined,
          Phones: client.phone ? [{ PhoneType: "DEFAULT", PhoneNumber: client.phone }] : undefined,
        },
      ],
    }),
  });
  const createBody = await createRes.json();
  if (!createRes.ok || !createBody.Contacts?.[0]?.ContactID) {
    console.error("[xero-sync] Failed to create Xero contact", createBody);
    return { error: createBody?.Elements?.[0]?.ValidationErrors?.[0]?.Message || "Failed to create Xero contact" };
  }
  const contactId = createBody.Contacts[0].ContactID as string;
  await admin.from("clients").update({ xero_contact_id: contactId }).eq("id", client.id);
  return { contactId };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: new Headers(CORS_HEADERS) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET) return json({ error: "xero_not_configured" }, 400);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  let body: { invoice_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!body.invoice_id) return json({ error: "bad_request" }, 400);

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await callerClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);
  const { data: callerProfile } = await callerClient.from("profiles").select("tenant_id").eq("id", authData.user.id).single();
  if (!callerProfile) return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: connection } = await admin
    .from("xero_connections")
    .select("*")
    .eq("tenant_id", callerProfile.tenant_id)
    .maybeSingle();
  if (!connection) return json({ error: "xero_not_connected" }, 400);

  const { data: invoice } = await admin
    .from("invoices")
    .select("*, clients(id, name, company_name, client_type, email, phone)")
    .eq("id", body.invoice_id)
    .eq("tenant_id", callerProfile.tenant_id)
    .maybeSingle();
  if (!invoice) return json({ error: "not_found" }, 404);
  if (invoice.status === "draft") return json({ error: "invoice_still_draft" }, 400);

  const { data: lineItems } = await admin
    .from("invoice_line_items")
    .select("description, quantity, unit_price_cents, gst_applicable")
    .eq("invoice_id", invoice.id)
    .order("sort_order");

  const { data: tenant } = await admin.from("tenants").select("xero_sales_account_code").eq("id", callerProfile.tenant_id).single();
  const accountCode = tenant?.xero_sales_account_code || "200";

  const tokenResult = await ensureFreshToken(admin, connection);
  if ("error" in tokenResult) return json({ error: tokenResult.error }, 400);
  const { accessToken, xeroTenantId } = tokenResult;

  let contactId = invoice.clients?.xero_contact_id as string | undefined;
  if (!contactId) {
    const contactResult = await ensureXeroContact(admin, accessToken, xeroTenantId, invoice.clients);
    if ("error" in contactResult) {
      await admin.from("invoices").update({ xero_sync_error: contactResult.error }).eq("id", invoice.id);
      return json({ error: contactResult.error }, 400);
    }
    contactId = contactResult.contactId;
  }

  const xeroInvoicePayload = {
    Invoices: [
      {
        ...(invoice.xero_invoice_id ? { InvoiceID: invoice.xero_invoice_id } : {}),
        Type: "ACCREC",
        Contact: { ContactID: contactId },
        Date: invoice.issue_date,
        DueDate: invoice.due_date || invoice.issue_date,
        Reference: invoice.invoice_number,
        Status: "AUTHORISED",
        LineItems: (lineItems ?? []).map((item) => ({
          Description: item.description,
          Quantity: item.quantity,
          UnitAmount: item.unit_price_cents / 100,
          AccountCode: accountCode,
          TaxType: item.gst_applicable ? "OUTPUT" : "EXEMPTOUTPUT",
        })),
      },
    ],
  };

  const invoiceRes = await fetch("https://api.xero.com/api.xro/2.0/Invoices", {
    method: "POST",
    headers: xeroHeaders(accessToken, xeroTenantId),
    body: JSON.stringify(xeroInvoicePayload),
  });
  const invoiceBody = await invoiceRes.json();
  const xeroInvoice = invoiceBody?.Invoices?.[0];
  const validationError = xeroInvoice?.ValidationErrors?.[0]?.Message;
  if (!invoiceRes.ok || !xeroInvoice?.InvoiceID || validationError) {
    const message = validationError || invoiceBody?.Elements?.[0]?.ValidationErrors?.[0]?.Message || "Failed to sync invoice to Xero";
    console.error("[xero-sync] Failed to push invoice", invoiceBody);
    await admin.from("invoices").update({ xero_sync_error: message }).eq("id", invoice.id);
    return json({ error: message }, 400);
  }

  await admin
    .from("invoices")
    .update({ xero_invoice_id: xeroInvoice.InvoiceID, xero_synced_at: new Date().toISOString(), xero_sync_error: null })
    .eq("id", invoice.id);

  return json({
    ok: true,
    xero_invoice_id: xeroInvoice.InvoiceID,
    xero_view_url: `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${xeroInvoice.InvoiceID}`,
  });
});

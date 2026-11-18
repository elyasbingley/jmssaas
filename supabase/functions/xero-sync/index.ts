// Xero two-way sync - see sync.ts and the xero_two_way_sync migration.
//
// Called by:
//   * pg_cron every 10 minutes, and xero-webhook straight after Xero
//     reports a change - service role key, { action: "sweep", tenant_id? }
//     (no tenant_id = every connected company);
//   * the desktop/phone "Sync to Xero" button on an invoice - signed-in
//     user, { invoice_id }: pushes that invoice (and its payments) now;
//   * Settings "Sync now" - { action: "sync_now" }: a full sweep now;
//   * Settings payment-account pickers - { action: "list_accounts" }.
//
// Deployed with --no-verify-jwt: it checks the caller itself (the service
// role key, or a signed-in user of the company).

import { createClient } from "npm:@supabase/supabase-js@2";
import { listAccounts, sweep } from "./sync.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const XERO_CLIENT_ID = Deno.env.get("XERO_CLIENT_ID") ?? "";
const XERO_CLIENT_SECRET = Deno.env.get("XERO_CLIENT_SECRET") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
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
  if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET) return json({ error: "xero_not_configured" }, 400);
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: "server_error" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  let body: { action?: string; invoice_id?: string; tenant_id?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Scheduled / webhook sweep.
  if (authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
    let query = admin.from("xero_connections").select("tenant_id");
    if (body.tenant_id) query = query.eq("tenant_id", body.tenant_id);
    const { data: connections } = await query;
    const results: Record<string, unknown> = {};
    for (const c of connections ?? []) results[c.tenant_id] = await sweep(admin, c.tenant_id);
    return json({ ok: true, results });
  }

  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await caller.auth.getUser();
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);
  const { data: profile } = await caller.from("profiles").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!profile) return json({ error: "unauthorized" }, 401);
  const tenantId = profile.tenant_id as string;

  const { data: connection } = await admin.from("xero_connections").select("tenant_id").eq("tenant_id", tenantId).maybeSingle();
  if (!connection) return json({ error: "xero_not_connected" }, 400);

  if (body.action === "list_accounts") {
    if (profile.role !== "admin") return json({ error: "forbidden" }, 403);
    const result = await listAccounts(admin, tenantId);
    return "error" in result ? json(result, 400) : json(result);
  }

  if (body.action === "sync_now") {
    const result = await sweep(admin, tenantId, { force: true });
    if (result.error === "busy") return json({ error: "busy" }, 409);
    return json({ ok: !result.error, result });
  }

  // "Sync to Xero" on one invoice.
  if (!body.invoice_id) return json({ error: "bad_request" }, 400);
  const { data: invoice } = await admin.from("invoices").select("id, status").eq("id", body.invoice_id).eq("tenant_id", tenantId).maybeSingle();
  if (!invoice) return json({ error: "not_found" }, 404);
  if (invoice.status === "draft") return json({ error: "invoice_still_draft" }, 400);
  await admin.from("invoices").update({ xero_needs_sync: true, xero_sync_failed_at: null }).eq("id", invoice.id);
  const result = await sweep(admin, tenantId, { force: true, onlyInvoiceId: invoice.id });
  if (result.error === "busy") return json({ error: "Xero is syncing right now - try again in a minute" }, 409);
  if (result.error) return json({ error: result.error }, 400);

  const { data: after } = await admin.from("invoices").select("xero_invoice_id, xero_sync_error, xero_needs_sync").eq("id", invoice.id).single();
  if (after?.xero_sync_error && after.xero_needs_sync) return json({ error: after.xero_sync_error }, 400);
  return json({
    ok: true,
    xero_invoice_id: after?.xero_invoice_id,
    xero_view_url: after?.xero_invoice_id ? `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${after.xero_invoice_id}` : null,
    result,
  });
});

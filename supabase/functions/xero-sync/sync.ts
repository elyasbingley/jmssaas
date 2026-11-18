// The Xero "sweep" for one company - see the xero_two_way_sync migration
// for the whole picture. In order:
//   1. push invoices flagged xero_needs_sync (new, changed, voided here);
//   2. delete in Xero the payments removed here;
//   3. push payments taken here into the Xero account chosen for their
//      method (Settings);
//   4. pull what changed in Xero since last time: payments (new, deleted)
//      and invoices (paid by other means, voided).
// Only one sweep runs per company at a time (xero_claim_sweep), so tokens
// are never refreshed twice at once and nothing is pushed twice.

// deno-lint-ignore-file no-explicit-any
type Admin = any;

const XERO_CLIENT_ID = Deno.env.get("XERO_CLIENT_ID") ?? "";
const XERO_CLIENT_SECRET = Deno.env.get("XERO_CLIENT_SECRET") ?? "";
const API = "https://api.xero.com/api.xro/2.0";

// How far back the very first pull looks, and how long a failed push waits
// before the schedule tries it again ("Sync now" retries straight away).
const FIRST_PULL_DAYS = 90;
const RETRY_AFTER_MS = 60 * 60 * 1000;
// Xero's invoice total can round a cent or two differently from ours (GST
// per line, membership discount). A payment that's over what Xero says is
// owing by no more than this is sent as Xero's amount.
const ROUNDING_TOLERANCE_CENTS = 5;

export const PAYMENT_ACCOUNT_KEYS: Record<string, string> = {
  tap_to_pay: "stripe",
  card_online: "stripe",
  card: "card",
  cash: "cash",
  bank_transfer: "bank_transfer",
  cheque: "cheque",
  other: "other",
};
const METHOD_LABELS: Record<string, string> = {
  tap_to_pay: "Tap to Pay",
  card_online: "Card (online)",
  card: "Card",
  cash: "Cash",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  other: "Other",
};
const ACCOUNT_KEY_LABELS: Record<string, string> = {
  stripe: "Stripe card payments",
  card: "Card (other machine)",
  cash: "Cash",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  other: "Other",
};

export class XeroRateLimited extends Error {}

export interface Ctx {
  admin: Admin;
  tenantId: string;
  xeroTenantId: string;
  accessToken: string;
  scopes: string[];
}

export interface SweepResult {
  ran: boolean;
  invoicesPushed: number;
  invoiceErrors: number;
  paymentsPushed: number;
  paymentErrors: number;
  deletions: number;
  paymentsImported: number;
  paymentsRemoved: number;
  invoicesSettled: number;
  invoicesVoided: number;
  error?: string;
}

const cents = (dollars: unknown) => Math.round(Number(dollars ?? 0) * 100);

// Xero's JSON dates are either "/Date(1700000000000+0000)/" or ISO.
export function xeroDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = value.match(/\/Date\((-?\d+)/);
  const d = ms ? new Date(Number(ms[1])) : new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

const sydneyDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });

// The scopes this connection was granted, from the access token itself.
export function tokenScopes(accessToken: string): string[] {
  try {
    const payload = JSON.parse(atob(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const scope = payload.scope;
    return Array.isArray(scope) ? scope : typeof scope === "string" ? scope.split(" ") : [];
  } catch {
    return [];
  }
}

const hasPaymentsScope = (scopes: string[]) => scopes.some((s) => s === "accounting.payments" || s === "accounting.transactions");
const hasSettingsScope = (scopes: string[]) => scopes.some((s) => s.startsWith("accounting.settings"));

export function missingScopes(scopes: string[]): string[] {
  const missing: string[] = [];
  if (!hasPaymentsScope(scopes)) missing.push("accounting.payments");
  if (!hasSettingsScope(scopes)) missing.push("accounting.settings.read");
  return missing;
}

// Xero's error text from any of the shapes it uses.
export function xeroError(body: any, fallback: string): string {
  const first = (arr: any) => (Array.isArray(arr) && arr.length ? arr[0] : null);
  const fromElements = first(first(body?.Elements)?.ValidationErrors)?.Message;
  const fromItem = first(first(body?.Invoices)?.ValidationErrors)?.Message || first(first(body?.Payments)?.ValidationErrors)?.Message;
  return fromItem || fromElements || body?.Message || body?.Detail || body?.error || fallback;
}

export async function xeroFetch(ctx: Ctx, path: string, init: RequestInit & { since?: string } = {}): Promise<{ ok: boolean; status: number; body: any }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.accessToken}`,
    "Xero-tenant-id": ctx.xeroTenantId,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (init.since) headers["If-Modified-Since"] = init.since;
  const res = await fetch(`${API}/${path}`, { method: init.method ?? "GET", headers, body: init.body });
  if (res.status === 429) throw new XeroRateLimited("Xero's rate limit was reached - the rest will go on the next sync");
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { Message: text.slice(0, 300) };
  }
  if (!res.ok) console.error(`[xero-sync] ${init.method ?? "GET"} ${path} -> ${res.status}`, text.slice(0, 500));
  return { ok: res.ok, status: res.status, body };
}

// Xero access tokens last 30 minutes; each refresh hands back a new refresh
// token that replaces the old one. Refreshed with a minute to spare.
export async function freshToken(admin: Admin, connection: Record<string, any>): Promise<string | null> {
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
    console.error("[xero-sync] Token refresh failed", body);
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

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

// Finds the client's Xero contact by exact name first (so years of
// existing contacts aren't duplicated), creates one only if none matches.
async function ensureContact(ctx: Ctx, client: Record<string, any>): Promise<{ contactId: string } | { error: string }> {
  if (client.xero_contact_id) return { contactId: client.xero_contact_id };
  const name = client.client_type === "company" && client.company_name ? client.company_name : client.name;
  const search = await xeroFetch(ctx, `Contacts?where=${encodeURIComponent(`Name=="${String(name).replace(/"/g, '\\"')}"`)}`);
  let contactId: string | undefined = search.ok ? search.body?.Contacts?.[0]?.ContactID : undefined;
  if (!contactId) {
    const created = await xeroFetch(ctx, "Contacts", {
      method: "POST",
      body: JSON.stringify({
        Contacts: [{ Name: name, EmailAddress: client.email || undefined, Phones: client.phone ? [{ PhoneType: "DEFAULT", PhoneNumber: client.phone }] : undefined }],
      }),
    });
    contactId = created.body?.Contacts?.[0]?.ContactID;
    if (!created.ok || !contactId) return { error: xeroError(created.body, "Couldn't create the client in Xero") };
  }
  await ctx.admin.from("clients").update({ xero_contact_id: contactId }).eq("id", client.id);
  return { contactId };
}

// The invoice as Xero should hold it. Line amounts are ex-GST (as here);
// waived amounts go across as line discounts and a membership discount as
// its own negative line, so Xero's total comes out the same as ours.
export function xeroInvoiceBody(invoice: Record<string, any>, lines: Record<string, any>[], contactId: string, accountCode: string) {
  const items: Record<string, unknown>[] = lines.map((line) => {
    const item: Record<string, unknown> = {
      Description: line.description,
      Quantity: Number(line.quantity),
      UnitAmount: Number(line.unit_price_cents) / 100,
      AccountCode: accountCode,
      TaxType: line.gst_applicable ? "OUTPUT" : "EXEMPTOUTPUT",
    };
    if (Number(line.waived_amount_cents) > 0) item.DiscountAmount = Number(line.waived_amount_cents) / 100;
    return item;
  });
  const discount = Number(invoice.membership_discount_cents ?? 0);
  if (discount > 0) {
    items.push({
      Description: "Membership discount",
      Quantity: 1,
      UnitAmount: -Math.round(discount / 1.1) / 100,
      AccountCode: accountCode,
      TaxType: "OUTPUT",
    });
  }
  return {
    Invoices: [
      {
        ...(invoice.xero_invoice_id ? { InvoiceID: invoice.xero_invoice_id } : {}),
        Type: "ACCREC",
        Contact: { ContactID: contactId },
        Date: invoice.issue_date,
        DueDate: invoice.due_date || invoice.issue_date,
        Reference: invoice.invoice_number,
        Status: "AUTHORISED",
        LineAmountTypes: "Exclusive",
        LineItems: items,
      },
    ],
  };
}

async function recordInvoice(ctx: Ctx, invoiceId: string, result: { xeroInvoiceId?: string; total?: number; status?: string; error?: string }) {
  await ctx.admin.rpc("xero_record_invoice_sync", {
    p_invoice_id: invoiceId,
    p_xero_invoice_id: result.xeroInvoiceId ?? null,
    p_xero_total_cents: result.total ?? null,
    p_xero_status: result.status ?? null,
    p_error: result.error ?? null,
  });
}

export async function pushInvoice(ctx: Ctx, invoice: Record<string, any>, accountCode: string): Promise<boolean> {
  if (invoice.status === "void") {
    if (!invoice.xero_invoice_id) {
      await recordInvoice(ctx, invoice.id, { status: null as any });
      return true;
    }
    const res = await xeroFetch(ctx, "Invoices", {
      method: "POST",
      body: JSON.stringify({ Invoices: [{ InvoiceID: invoice.xero_invoice_id, Status: "VOIDED" }] }),
    });
    const x = res.body?.Invoices?.[0];
    if (!res.ok || x?.HasErrors || x?.ValidationErrors?.length) {
      await recordInvoice(ctx, invoice.id, { error: `Couldn't void it in Xero: ${xeroError(res.body, "Xero refused")}` });
      return false;
    }
    await recordInvoice(ctx, invoice.id, { xeroInvoiceId: invoice.xero_invoice_id, total: cents(x?.Total), status: x?.Status ?? "VOIDED" });
    return true;
  }

  const contact = await ensureContact(ctx, invoice.clients ?? {});
  if ("error" in contact) {
    await recordInvoice(ctx, invoice.id, { error: contact.error });
    return false;
  }
  const { data: lines } = await ctx.admin
    .from("invoice_line_items")
    .select("description, quantity, unit_price_cents, gst_applicable, waived_amount_cents, sort_order")
    .eq("invoice_id", invoice.id)
    .order("sort_order");
  const res = await xeroFetch(ctx, "Invoices", { method: "POST", body: JSON.stringify(xeroInvoiceBody(invoice, lines ?? [], contact.contactId, accountCode)) });
  const x = res.body?.Invoices?.[0];
  if (!res.ok || !x?.InvoiceID || x?.HasErrors || x?.ValidationErrors?.length) {
    await recordInvoice(ctx, invoice.id, { error: xeroError(res.body, "Xero didn't accept the invoice") });
    return false;
  }
  await recordInvoice(ctx, invoice.id, { xeroInvoiceId: x.InvoiceID, total: cents(x.Total), status: x.Status });
  return true;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

async function paymentFailed(ctx: Ctx, paymentId: string, error: string) {
  await ctx.admin.from("payments").update({ xero_sync_error: error, xero_sync_failed_at: new Date().toISOString() }).eq("id", paymentId);
}

export async function pushPayment(
  ctx: Ctx,
  payment: Record<string, any>,
  invoice: Record<string, any>,
  accounts: Record<string, { id: string; name?: string } | undefined>,
  alreadyInXeroCents: number
): Promise<boolean> {
  const key = PAYMENT_ACCOUNT_KEYS[payment.method];
  const account = key ? accounts[key] : undefined;
  if (!account?.id) {
    await paymentFailed(ctx, payment.id, `No Xero account chosen for ${ACCOUNT_KEY_LABELS[key] ?? payment.method} - choose one in Settings > Company Details > Xero`);
    return false;
  }
  let amount = Number(payment.amount_cents);
  if (invoice.xero_total_cents != null) {
    const owingInXero = Number(invoice.xero_total_cents) - alreadyInXeroCents;
    if (owingInXero <= 0) {
      await paymentFailed(ctx, payment.id, "Xero already shows this invoice as paid - not sent, to avoid paying it twice in Xero");
      return false;
    }
    if (amount > owingInXero && amount - owingInXero <= ROUNDING_TOLERANCE_CENTS) amount = owingInXero;
  }
  const label = METHOD_LABELS[payment.method] ?? payment.method;
  const reference = [label, payment.reference, payment.stripe_payment_intent_id].filter(Boolean).join(" - ").slice(0, 255);
  const res = await xeroFetch(ctx, "Payments", {
    method: "PUT",
    body: JSON.stringify({
      Payments: [{ Invoice: { InvoiceID: invoice.xero_invoice_id }, Account: { AccountID: account.id }, Date: sydneyDate(payment.paid_at), Amount: amount / 100, Reference: reference }],
    }),
  });
  const x = res.body?.Payments?.[0];
  if (!res.ok || !x?.PaymentID || x?.HasValidationErrors || x?.ValidationErrors?.length) {
    await paymentFailed(ctx, payment.id, xeroError(res.body, "Xero didn't accept the payment"));
    return false;
  }
  await ctx.admin
    .from("payments")
    .update({ xero_payment_id: x.PaymentID, xero_amount_cents: amount, xero_synced_at: new Date().toISOString(), xero_sync_error: null, xero_sync_failed_at: null })
    .eq("id", payment.id);
  return true;
}

export async function deletePayment(ctx: Ctx, row: Record<string, any>): Promise<boolean> {
  const res = await xeroFetch(ctx, `Payments/${encodeURIComponent(row.xero_payment_id)}`, { method: "POST", body: JSON.stringify({ Status: "DELETED" }) });
  if (res.ok || res.status === 404) {
    await ctx.admin.from("xero_payment_deletions").delete().eq("id", row.id);
    return true;
  }
  await ctx.admin
    .from("xero_payment_deletions")
    .update({ attempts: Number(row.attempts) + 1, last_error: xeroError(res.body, "Xero refused") })
    .eq("id", row.id);
  return false;
}

// ---------------------------------------------------------------------------
// Pulling from Xero
// ---------------------------------------------------------------------------

async function pagedSince(ctx: Ctx, path: string, key: string, since: string): Promise<any[]> {
  const all: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await xeroFetch(ctx, `${path}${sep}page=${page}`, { since });
    if (!res.ok) throw new Error(xeroError(res.body, `Couldn't read ${key} from Xero`));
    const rows = res.body?.[key] ?? [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

async function invoicesByXeroId(ctx: Ctx, xeroIds: string[]): Promise<Map<string, Record<string, any>>> {
  const map = new Map<string, Record<string, any>>();
  const unique = [...new Set(xeroIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const { data } = await ctx.admin
      .from("invoices")
      .select("id, xero_invoice_id, status, total_cents, amount_paid_cents")
      .eq("tenant_id", ctx.tenantId)
      .in("xero_invoice_id", unique.slice(i, i + 100));
    for (const row of data ?? []) map.set(row.xero_invoice_id, row);
  }
  return map;
}

export async function pull(ctx: Ctx, since: string, result: SweepResult): Promise<void> {
  // Payments first, so an invoice paid in Xero has its payments here
  // before we look at whether anything's left to settle.
  if (hasPaymentsScope(ctx.scopes)) {
    const payments = await pagedSince(ctx, `Payments?where=${encodeURIComponent('PaymentType=="ACCRECPAYMENT"')}`, "Payments", since);
    const invoices = await invoicesByXeroId(ctx, payments.map((p) => p.Invoice?.InvoiceID));
    for (const p of payments) {
      const invoice = invoices.get(p.Invoice?.InvoiceID);
      if (p.Status === "DELETED") {
        const { data } = await ctx.admin.rpc("xero_payment_removed", { p_xero_payment_id: p.PaymentID });
        if (data === "deleted" || data === "unlinked") result.paymentsRemoved++;
        continue;
      }
      if (!invoice) continue;
      const { data } = await ctx.admin.rpc("xero_import_payment", {
        p_invoice_id: invoice.id,
        p_xero_payment_id: p.PaymentID,
        p_amount_cents: cents(p.Amount),
        p_paid_on: xeroDate(p.Date) ?? new Date().toISOString().slice(0, 10),
        p_reference: p.Reference ?? null,
      });
      if (data === "imported") result.paymentsImported++;
    }
  }

  const xeroInvoices = await pagedSince(ctx, `Invoices?summaryOnly=true&where=${encodeURIComponent('Type=="ACCREC"')}`, "Invoices", since);
  const ours = await invoicesByXeroId(ctx, xeroInvoices.map((x) => x.InvoiceID));
  for (const x of xeroInvoices) {
    const invoice = ours.get(x.InvoiceID);
    if (!invoice) continue;
    if (x.Status === "VOIDED") {
      const { data } = await ctx.admin.rpc("xero_void_invoice", { p_invoice_id: invoice.id });
      if (data === "voided") result.invoicesVoided++;
    } else if (x.Status === "PAID") {
      const { data } = await ctx.admin.rpc("xero_settle_invoice", { p_invoice_id: invoice.id });
      if (data === "settled") result.invoicesSettled++;
    } else if (x.Status) {
      await ctx.admin.from("invoices").update({ xero_status: x.Status }).eq("id", invoice.id);
    }
  }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export async function sweep(admin: Admin, tenantId: string, opts: { force?: boolean; onlyInvoiceId?: string } = {}): Promise<SweepResult> {
  const result: SweepResult = {
    ran: false,
    invoicesPushed: 0,
    invoiceErrors: 0,
    paymentsPushed: 0,
    paymentErrors: 0,
    deletions: 0,
    paymentsImported: 0,
    paymentsRemoved: 0,
    invoicesSettled: 0,
    invoicesVoided: 0,
  };

  // Someone else's sweep for this company may be running; a manual one
  // waits a little for it.
  let claimed = false;
  for (let attempt = 0; attempt < (opts.force ? 6 : 1); attempt++) {
    const { data } = await admin.rpc("xero_claim_sweep", { p_tenant_id: tenantId, p_seconds: 240 });
    if (data === true) {
      claimed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!claimed) return { ...result, error: "busy" };
  result.ran = true;

  const startedAt = new Date();
  const finish: Record<string, unknown> = { sweep_lease_until: null, last_sweep_at: startedAt.toISOString(), last_sweep_error: null };
  try {
    const { data: connection } = await admin.from("xero_connections").select("*").eq("tenant_id", tenantId).single();
    const accessToken = await freshToken(admin, connection);
    if (!accessToken) throw new Error("Xero needs reconnecting - Settings > Company Details > Xero > Connect");
    const scopes = tokenScopes(accessToken);
    finish.missing_scopes = missingScopes(scopes);
    const ctx: Ctx = { admin, tenantId, xeroTenantId: connection.xero_tenant_id, accessToken, scopes };

    const { data: tenant } = await admin.from("tenants").select("xero_sales_account_code, xero_payment_accounts").eq("id", tenantId).single();
    const accountCode = tenant?.xero_sales_account_code || "200";
    const accounts = (tenant?.xero_payment_accounts ?? {}) as Record<string, { id: string; name?: string }>;
    const retryBefore = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
    const due = (failedAt: string | null) => opts.force || !failedAt || failedAt < retryBefore;

    // 1. invoices
    let invoiceQuery = admin
      .from("invoices")
      .select("*, clients(id, name, company_name, client_type, email, phone, xero_contact_id)")
      .eq("tenant_id", tenantId)
      .eq("xero_needs_sync", true)
      .order("updated_at")
      .limit(25);
    if (opts.onlyInvoiceId) invoiceQuery = invoiceQuery.eq("id", opts.onlyInvoiceId);
    const { data: invoices } = await invoiceQuery;
    for (const invoice of invoices ?? []) {
      if (!due(invoice.xero_sync_failed_at)) continue;
      if (await pushInvoice(ctx, invoice, accountCode)) result.invoicesPushed++;
      else result.invoiceErrors++;
    }

    if (hasPaymentsScope(scopes) && !opts.onlyInvoiceId) {
      // 2. deletions
      const { data: deletions } = await admin.from("xero_payment_deletions").select("*").eq("tenant_id", tenantId).lt("attempts", 5).limit(25);
      for (const row of deletions ?? []) if (await deletePayment(ctx, row)) result.deletions++;
    }

    if (hasPaymentsScope(scopes)) {
      // 3. payments taken here, on invoices that are in Xero
      let paymentQuery = admin
        .from("payments")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("source", "app")
        .eq("xero_skip", false)
        .is("xero_payment_id", null)
        .not("invoice_id", "is", null)
        .order("paid_at")
        .limit(50);
      if (opts.onlyInvoiceId) paymentQuery = paymentQuery.eq("invoice_id", opts.onlyInvoiceId);
      const { data: pending } = await paymentQuery;
      const invoiceIds = [...new Set((pending ?? []).map((p: any) => p.invoice_id))];
      if (invoiceIds.length) {
        const { data: targets } = await admin
          .from("invoices")
          .select("id, xero_invoice_id, xero_total_cents, xero_needs_sync")
          .in("id", invoiceIds);
        const { data: inXero } = await admin.from("payments").select("invoice_id, xero_amount_cents").in("invoice_id", invoiceIds).not("xero_payment_id", "is", null);
        const pushedCents = new Map<string, number>();
        for (const row of inXero ?? []) pushedCents.set(row.invoice_id, (pushedCents.get(row.invoice_id) ?? 0) + Number(row.xero_amount_cents ?? 0));
        const byId = new Map((targets ?? []).map((t: any) => [t.id, t]));
        for (const payment of pending ?? []) {
          const invoice: any = byId.get(payment.invoice_id);
          // Not in Xero yet (or a change still to push): the payment waits.
          if (!invoice?.xero_invoice_id || invoice.xero_needs_sync) continue;
          if (!due(payment.xero_sync_failed_at)) continue;
          const ok = await pushPayment(ctx, payment, invoice, accounts, pushedCents.get(invoice.id) ?? 0);
          if (ok) {
            result.paymentsPushed++;
            const { data: saved } = await admin.from("payments").select("xero_amount_cents").eq("id", payment.id).single();
            pushedCents.set(invoice.id, (pushedCents.get(invoice.id) ?? 0) + Number(saved?.xero_amount_cents ?? payment.amount_cents));
          } else result.paymentErrors++;
        }
      }
    }

    // 4. pull
    if (!opts.onlyInvoiceId) {
      const since = connection.last_pulled_at
        ? new Date(connection.last_pulled_at)
        : new Date(Date.now() - FIRST_PULL_DAYS * 24 * 60 * 60 * 1000);
      await pull(ctx, since.toISOString().slice(0, 19), result);
      // A couple of minutes' overlap: anything changed in Xero while this
      // ran is read again next time (imports are idempotent).
      finish.last_pulled_at = new Date(startedAt.getTime() - 2 * 60 * 1000).toISOString();
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    finish.last_sweep_error = result.error;
    console.error("[xero-sync] sweep failed", tenantId, e);
  }
  await admin.from("xero_connections").update(finish).eq("tenant_id", tenantId);
  return result;
}

export async function listAccounts(admin: Admin, tenantId: string): Promise<{ accounts: { id: string; name: string; code: string | null; type: string }[] } | { error: string }> {
  const { data: connection } = await admin.from("xero_connections").select("*").eq("tenant_id", tenantId).maybeSingle();
  if (!connection) return { error: "xero_not_connected" };
  const { data: claimed } = await admin.rpc("xero_claim_sweep", { p_tenant_id: tenantId, p_seconds: 30 });
  if (claimed !== true) return { error: "busy" };
  try {
    const accessToken = await freshToken(admin, connection);
    if (!accessToken) return { error: "xero_reauth_required" };
    const scopes = tokenScopes(accessToken);
    if (!hasSettingsScope(scopes)) return { error: "missing_scope" };
    const ctx: Ctx = { admin, tenantId, xeroTenantId: connection.xero_tenant_id, accessToken, scopes };
    const res = await xeroFetch(ctx, `Accounts?where=${encodeURIComponent('Status=="ACTIVE"&&(Type=="BANK"||EnablePaymentsToAccount==true)')}`);
    if (!res.ok) return { error: xeroError(res.body, "Couldn't read accounts from Xero") };
    return {
      accounts: (res.body?.Accounts ?? []).map((a: any) => ({ id: a.AccountID, name: a.Name, code: a.Code ?? null, type: a.Type })),
    };
  } finally {
    await admin.from("xero_connections").update({ sweep_lease_until: null }).eq("tenant_id", tenantId);
  }
}

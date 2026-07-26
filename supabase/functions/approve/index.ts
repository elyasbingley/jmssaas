// Public, unauthenticated approval page for quotes/invoices - deployed as
// a Supabase Edge Function (Deno runtime, npm: specifiers supported).
//
// Deployed URL shape: https://<project-ref>.supabase.co/functions/v1/approve/quote/<token>
// (or .../approve/invoice/<token>). The function reads the trailing two
// path segments itself rather than relying on any router, since Edge
// Functions don't have one - see parseRoute() below.
//
// This is a thin HTML/form layer only. Every actual read and write goes
// through the SECURITY DEFINER RPCs added in
// supabase/migrations/20260728000100_quote_invoice_approval.sql
// (get_quote_for_approval, accept_quote_by_token, etc.) using the plain
// anon key - the token itself is the credential, validated server-side in
// those functions (existence, expiry, current status), not here. This
// function never touches the database directly and never sees the
// service role key.
//
// Deliberately duplicates a few tiny formatting helpers (escapeHtml,
// formatCentsAsAud, formatDate) that already exist in
// apps/mobile/lib/pdf.ts and packages/shared - this runs on Deno as a
// separate deployable unit from the Expo app/its pnpm workspace, so
// importing across that runtime boundary isn't a normal relative import;
// duplicating a handful of pure one-line functions is simpler and more
// robust than trying to bridge module resolution across it.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

type DocType = "quote" | "invoice";

interface LineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

interface ApprovalDoc {
  error?: "not_found" | "expired";
  quote_number?: string;
  invoice_number?: string;
  status: string | null;
  issue_date: string;
  expiry_date?: string | null;
  due_date?: string | null;
  subtotal_cents: number;
  gst_cents: number;
  total_cents: number;
  notes: string | null;
  accepted_by_name: string | null;
  decline_reason: string | null;
  tenant_name: string;
  tenant_logo_url: string | null;
  client_name: string;
  line_items: LineItem[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCentsAsAud(cents: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}

function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "-";
  const d = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateString;
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const ACCENT: Record<DocType, string> = { quote: "#1f2937", invoice: "#22a366" };

const PAGE_STYLES = `
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #111827; margin: 0; padding: 0; background: #f3f4f6; }
  .page { max-width: 640px; margin: 0 auto; padding: 24px 16px 60px; }
  .card { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .logo { max-width: 200px; max-height: 80px; margin-bottom: 16px; }
  .doc-title { font-size: 26px; margin: 0; }
  .doc-number { color: #6b7280; font-weight: 700; font-size: 13px; margin-top: 4px; }
  .meta { color: #374151; font-size: 13px; margin-top: 16px; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th { text-align: left; font-size: 11px; color: #fff; padding: 8px; }
  th.num, td.num { text-align: right; }
  td { padding: 8px; border-bottom: 1px solid #e5e7eb; font-size: 13px; vertical-align: top; white-space: pre-wrap; }
  .totals { width: 220px; margin-left: auto; margin-top: 16px; }
  .totals-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
  .totals-row.total { border-top: 2px solid #111827; font-weight: 700; font-size: 16px; padding-top: 8px; margin-top: 4px; }
  .notes { margin-top: 20px; font-size: 13px; color: #374151; white-space: pre-wrap; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 700; margin-top: 12px; }
  .badge.accepted { background: #dcfce7; color: #15803d; }
  .badge.declined { background: #fee2e2; color: #b91c1c; }
  .badge.pending { background: #fef9c3; color: #854d0e; }
  form { margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 20px; }
  label { display: block; font-size: 13px; font-weight: 700; color: #374151; margin-bottom: 6px; }
  input[type=text], textarea { width: 100%; padding: 12px; font-size: 15px; border: 1px solid #d1d5db; border-radius: 8px; margin-bottom: 14px; font-family: inherit; }
  button { border: none; border-radius: 8px; padding: 14px 20px; font-size: 15px; font-weight: 700; cursor: pointer; width: 100%; }
  .accept-btn { background: #16a34a; color: #fff; }
  .decline-btn { background: #f3f4f6; color: #b91c1c; margin-top: 10px; }
  .message-title { font-size: 20px; font-weight: 700; margin: 0 0 8px; }
  .message-body { color: #374151; font-size: 14px; line-height: 1.6; }
`;

function pageShell(bodyHtml: string): Response {
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Document Approval</title>
    <style>${PAGE_STYLES}</style>
  </head>
  <body>
    <div class="page"><div class="card">${bodyHtml}</div></div>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: new Headers({
      "Content-Type": "text/html; charset=utf-8",
      // Belt-and-suspenders against any intermediate cache (CDN, browser)
      // serving back a stale response from an earlier deploy while this
      // was being debugged - every request should hit the function fresh.
      "Cache-Control": "no-store",
    }),
  });
}

function messagePage(title: string, body: string): Response {
  return pageShell(`
    <p class="message-title">${escapeHtml(title)}</p>
    <p class="message-body">${escapeHtml(body)}</p>
  `);
}

function renderLineItemsTable(docType: DocType, items: LineItem[]): string {
  const rows = items
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(item.description)}</td>
        <td class="num">${item.quantity}</td>
        <td class="num">${formatCentsAsAud(item.unit_price_cents)}</td>
        <td class="num">${formatCentsAsAud(item.quantity * item.unit_price_cents)}</td>
      </tr>`
    )
    .join("");
  return `
    <table>
      <thead>
        <tr style="background: ${ACCENT[docType]};">
          <th>Item &amp; Description</th>
          <th class="num" style="width: 50px;">Qty</th>
          <th class="num" style="width: 80px;">Rate</th>
          <th class="num" style="width: 90px;">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderApprovalPage(docType: DocType, token: string, doc: ApprovalDoc): string {
  const accent = ACCENT[docType];
  const title = docType === "invoice" ? "Invoice" : "Quote";
  const number = docType === "invoice" ? doc.invoice_number : doc.quote_number;
  const dateLabel = docType === "invoice" ? "Due date" : "Expiry date";
  const dateValue = docType === "invoice" ? doc.due_date : doc.expiry_date;

  let statusBadge = "";
  if (doc.status === "accepted") {
    statusBadge = `<span class="badge accepted">Accepted by ${escapeHtml(doc.accepted_by_name ?? "client")}</span>`;
  } else if (doc.status === "declined") {
    statusBadge = `<span class="badge declined">Declined</span>`;
  }

  let actionSection = "";
  if (doc.status === "accepted") {
    actionSection = `<p class="message-body" style="margin-top: 20px;">This ${title.toLowerCase()} has already been accepted. No further action is needed.</p>`;
  } else if (doc.status === "declined") {
    actionSection = `<p class="message-body" style="margin-top: 20px;">This ${title.toLowerCase()} was declined${doc.decline_reason ? `: "${escapeHtml(doc.decline_reason)}"` : "."}</p>`;
  } else {
    actionSection = `
      <form method="POST" action="/functions/v1/approve/${docType}/${encodeURIComponent(token)}">
        <input type="hidden" name="action" value="accept" />
        <label for="accept-name">Type your full name to accept this ${title.toLowerCase()}</label>
        <input type="text" id="accept-name" name="name" placeholder="Full name" required />
        <button type="submit" class="accept-btn" style="background: ${accent};">I accept this ${title.toLowerCase()}</button>
      </form>
      <form method="POST" action="/functions/v1/approve/${docType}/${encodeURIComponent(token)}">
        <input type="hidden" name="action" value="decline" />
        <label for="decline-reason">Decline instead (optional reason)</label>
        <textarea id="decline-reason" name="reason" rows="3" placeholder="Let us know why (optional)"></textarea>
        <button type="submit" class="decline-btn">Decline this ${title.toLowerCase()}</button>
      </form>
    `;
  }

  return `
    ${doc.tenant_logo_url ? `<img class="logo" src="${escapeHtml(doc.tenant_logo_url)}" />` : ""}
    <p class="doc-title" style="color: ${accent};">${title}</p>
    <p class="doc-number"># ${escapeHtml(number ?? "")}</p>
    ${statusBadge}
    <div class="meta">
      <div><strong>${escapeHtml(doc.tenant_name)}</strong></div>
      <div>Prepared for ${escapeHtml(doc.client_name)}</div>
      <div>Issued ${formatDate(doc.issue_date)} &middot; ${dateLabel} ${formatDate(dateValue)}</div>
    </div>
    ${renderLineItemsTable(docType, doc.line_items)}
    <div class="totals">
      <div class="totals-row"><span>Sub Total</span><span>${formatCentsAsAud(doc.subtotal_cents)}</span></div>
      <div class="totals-row"><span>GST</span><span>${formatCentsAsAud(doc.gst_cents)}</span></div>
      <div class="totals-row total"><span>Total</span><span>${formatCentsAsAud(doc.total_cents)}</span></div>
    </div>
    ${doc.notes ? `<div class="notes"><strong>Notes</strong><br/>${escapeHtml(doc.notes)}</div>` : ""}
    ${actionSection}
  `;
}

function parseRoute(req: Request): { docType: DocType; token: string } | null {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const token = parts[parts.length - 1];
  const docType = parts[parts.length - 2];
  if ((docType !== "quote" && docType !== "invoice") || !token) return null;
  return { docType, token };
}

Deno.serve(async (req: Request) => {
  const route = parseRoute(req);
  if (!route) {
    return messagePage("Not found", "This link is missing a document type or token.");
  }
  const { docType, token } = route;
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const rpcPrefix = docType === "invoice" ? "invoice" : "quote";

  if (req.method === "POST") {
    const form = await req.formData();
    const action = form.get("action");
    if (action === "accept") {
      const name = String(form.get("name") ?? "");
      const { data, error } = await supabase.rpc(`accept_${rpcPrefix}_by_token`, { p_token: token, p_name: name });
      if (error) return messagePage("Something went wrong", "Please try again, or contact us directly.");
      if (data?.error === "expired") return messagePage("Link expired", "This approval link has expired - please ask for a new one.");
      if (data?.error === "already_resolved") return messagePage("Already resolved", "This document has already been accepted or declined.");
      if (data?.error === "not_found") return messagePage("Not found", "This link doesn't match any document.");
      if (data?.error === "name_required") return messagePage("Name required", "Please enter your name to accept.");
      return messagePage("Thank you", `You've accepted this ${docType}. We'll be in touch shortly.`);
    }
    if (action === "decline") {
      const reason = String(form.get("reason") ?? "");
      const { data, error } = await supabase.rpc(`decline_${rpcPrefix}_by_token`, { p_token: token, p_reason: reason });
      if (error) return messagePage("Something went wrong", "Please try again, or contact us directly.");
      if (data?.error === "expired") return messagePage("Link expired", "This approval link has expired - please ask for a new one.");
      if (data?.error === "already_resolved") return messagePage("Already resolved", "This document has already been accepted or declined.");
      if (data?.error === "not_found") return messagePage("Not found", "This link doesn't match any document.");
      return messagePage("Received", `You've declined this ${docType}. Thanks for letting us know.`);
    }
    return messagePage("Invalid request", "Unrecognised form action.");
  }

  const { data, error } = await supabase.rpc(`get_${rpcPrefix}_for_approval`, { p_token: token });
  if (error) return messagePage("Something went wrong", "Please try again, or contact us directly.");
  if (data?.error === "expired") return messagePage("Link expired", "This approval link has expired - please ask for a new one.");
  if (data?.error === "not_found") return messagePage("Not found", "This link doesn't match any document.");

  return pageShell(renderApprovalPage(docType, token, data as ApprovalDoc));
});

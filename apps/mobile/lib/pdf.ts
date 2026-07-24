import {
  calculateDocumentTotals,
  formatCentsAsAud,
  lineItemSubtotalCents,
  type Client,
  type Invoice,
  type LineItemFormInput,
  type Quote,
  type Tenant,
} from "@jmssaas/shared";
import { formatClientAddress } from "./format";

// Builds the HTML string that gets handed to expo-print's printToFileAsync
// (see lib/print.ts) - kept as plain string-building rather than a React
// component because printToFileAsync wants a raw HTML document, not a
// React Native render tree. The itemised table intentionally uses the same
// fields as LineItemSummary (components/LineItemEditor.tsx) - description,
// quantity, unit_price_cents - and never the labour/material/markup
// breakdown, so a PDF can never leak internal margin figures regardless of
// who exports it.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(dateString: string | null): string {
  if (!dateString) return "-";
  const d = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateString;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function formatBusinessAddress(tenant: Tenant): string | null {
  const parts = [
    tenant.business_address_line1,
    tenant.business_address_line2,
    [tenant.business_suburb, tenant.business_state, tenant.business_postcode].filter(Boolean).join(" "),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

const BASE_STYLES = `
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #111827; margin: 0; padding: 40px; font-size: 12px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
  .company-block { max-width: 60%; }
  .company-name { font-size: 16px; font-weight: 700; margin: 0 0 4px; }
  .company-detail { color: #6b7280; font-size: 11px; line-height: 1.5; margin: 0; }
  .doc-block { text-align: right; }
  .doc-title { font-size: 32px; font-weight: 800; letter-spacing: 1px; margin: 0; color: #111827; }
  .doc-number { color: #1d4ed8; font-weight: 700; font-size: 13px; margin-top: 4px; }
  .meta-row { display: flex; justify-content: space-between; margin-bottom: 28px; gap: 24px; }
  .bill-to-label { color: #6b7280; font-size: 11px; font-weight: 700; text-transform: uppercase; margin-bottom: 4px; }
  .bill-to-name { font-weight: 700; font-size: 13px; margin-bottom: 2px; }
  .bill-to-detail { color: #374151; font-size: 11px; line-height: 1.5; }
  .dates-block { text-align: right; }
  .date-row { margin-bottom: 3px; font-size: 11px; }
  .date-label { color: #6b7280; margin-right: 8px; }
  .date-value { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; color: #6b7280; border-bottom: 2px solid #111827; padding: 6px 8px; }
  th.num, td.num { text-align: right; }
  td { padding: 8px; border-bottom: 1px solid #e5e7eb; font-size: 12px; vertical-align: top; }
  .totals { width: 260px; margin-left: auto; margin-bottom: 28px; }
  .totals-row { display: flex; justify-content: space-between; padding: 4px 8px; font-size: 12px; }
  .totals-row.total { border-top: 2px solid #111827; font-weight: 700; font-size: 14px; padding-top: 8px; margin-top: 4px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6b7280; margin: 20px 0 6px; }
  .section-body { font-size: 11px; color: #374151; line-height: 1.6; white-space: pre-wrap; }
  .bank-details { display: flex; gap: 24px; }
  .bank-detail { font-size: 11px; }
  .bank-detail-label { color: #6b7280; }
  .bank-detail-value { font-weight: 700; }
`;

function renderCompanyBlock(tenant: Tenant): string {
  const address = formatBusinessAddress(tenant);
  return `
    <div class="company-block">
      <p class="company-name">${escapeHtml(tenant.name)}</p>
      ${address ? `<p class="company-detail">${escapeHtml(address)}</p>` : ""}
      ${tenant.abn ? `<p class="company-detail">ABN ${escapeHtml(tenant.abn)}</p>` : ""}
      ${tenant.license_number ? `<p class="company-detail">License ${escapeHtml(tenant.license_number)}</p>` : ""}
    </div>
  `;
}

function renderBillTo(client: Client): string {
  const address = formatClientAddress(client);
  return `
    <div>
      <div class="bill-to-label">Bill To</div>
      <div class="bill-to-name">${escapeHtml(client.name)}</div>
      ${client.phone ? `<div class="bill-to-detail">${escapeHtml(client.phone)}</div>` : ""}
      ${client.email ? `<div class="bill-to-detail">${escapeHtml(client.email)}</div>` : ""}
      ${address ? `<div class="bill-to-detail">${escapeHtml(address)}</div>` : ""}
    </div>
  `;
}

function renderItemsTable(lineItems: LineItemFormInput[]): string {
  const rows = lineItems
    .map(
      (item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(item.description)}</td>
        <td class="num">${item.quantity}</td>
        <td class="num">${formatCentsAsAud(item.unit_price_cents)}</td>
        <td class="num">${formatCentsAsAud(lineItemSubtotalCents(item))}</td>
      </tr>`
    )
    .join("");
  return `
    <table>
      <thead>
        <tr>
          <th style="width: 32px;">#</th>
          <th>Item &amp; Description</th>
          <th class="num" style="width: 60px;">Qty</th>
          <th class="num" style="width: 90px;">Rate</th>
          <th class="num" style="width: 90px;">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderTotals(lineItems: LineItemFormInput[]): string {
  const totals = calculateDocumentTotals(lineItems);
  return `
    <div class="totals">
      <div class="totals-row"><span>Sub Total</span><span>${formatCentsAsAud(totals.subtotal_cents)}</span></div>
      <div class="totals-row"><span>GST</span><span>${formatCentsAsAud(totals.gst_cents)}</span></div>
      <div class="totals-row total"><span>Total</span><span>${formatCentsAsAud(totals.total_cents)}</span></div>
    </div>
  `;
}

function renderNotes(notes: string | null): string {
  if (!notes) return "";
  return `
    <div class="section-title">Notes</div>
    <div class="section-body">${escapeHtml(notes)}</div>
  `;
}

function renderBankDetails(tenant: Tenant): string {
  if (!tenant.bank_account_name && !tenant.bank_account_number && !tenant.bank_bsb) return "";
  return `
    <div class="section-title">Bank Details</div>
    <div class="bank-details">
      ${tenant.bank_account_name ? `<div class="bank-detail"><span class="bank-detail-label">Account name</span><br/><span class="bank-detail-value">${escapeHtml(tenant.bank_account_name)}</span></div>` : ""}
      ${tenant.bank_bsb ? `<div class="bank-detail"><span class="bank-detail-label">BSB</span><br/><span class="bank-detail-value">${escapeHtml(tenant.bank_bsb)}</span></div>` : ""}
      ${tenant.bank_account_number ? `<div class="bank-detail"><span class="bank-detail-label">Account number</span><br/><span class="bank-detail-value">${escapeHtml(tenant.bank_account_number)}</span></div>` : ""}
    </div>
  `;
}

export function buildQuotePdfHtml(params: {
  tenant: Tenant;
  quote: Quote;
  client: Client;
  lineItems: LineItemFormInput[];
}): string {
  const { tenant, quote, client, lineItems } = params;
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    <div class="header">
      ${renderCompanyBlock(tenant)}
      <div class="doc-block">
        <p class="doc-title">QUOTE</p>
        <p class="doc-number">${escapeHtml(quote.quote_number)}</p>
      </div>
    </div>

    <div class="meta-row">
      ${renderBillTo(client)}
      <div class="dates-block">
        <div class="date-row"><span class="date-label">Issue date</span><span class="date-value">${formatDate(quote.issue_date)}</span></div>
        <div class="date-row"><span class="date-label">Expiry date</span><span class="date-value">${formatDate(quote.expiry_date)}</span></div>
      </div>
    </div>

    ${renderItemsTable(lineItems)}
    ${renderTotals(lineItems)}
    ${renderNotes(quote.notes)}
  </body>
</html>`;
}

export function buildInvoicePdfHtml(params: {
  tenant: Tenant;
  invoice: Invoice;
  client: Client;
  lineItems: LineItemFormInput[];
}): string {
  const { tenant, invoice, client, lineItems } = params;
  // Invoices don't have their own persisted "terms" field distinct from
  // notes (see docs/SETUP.md known-gaps) - the reference template's "terms"
  // line is derived from due_date rather than a fabricated new column.
  const terms = invoice.due_date ? `Due ${formatDate(invoice.due_date)}` : "Due on receipt";
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    <div class="header">
      ${renderCompanyBlock(tenant)}
      <div class="doc-block">
        <p class="doc-title">INVOICE</p>
        <p class="doc-number">${escapeHtml(invoice.invoice_number)}</p>
      </div>
    </div>

    <div class="meta-row">
      ${renderBillTo(client)}
      <div class="dates-block">
        <div class="date-row"><span class="date-label">Invoice date</span><span class="date-value">${formatDate(invoice.issue_date)}</span></div>
        <div class="date-row"><span class="date-label">Terms</span><span class="date-value">${escapeHtml(terms)}</span></div>
        <div class="date-row"><span class="date-label">Due date</span><span class="date-value">${formatDate(invoice.due_date)}</span></div>
      </div>
    </div>

    ${renderItemsTable(lineItems)}
    ${renderTotals(lineItems)}
    ${renderNotes(invoice.notes)}
    ${renderBankDetails(tenant)}
  </body>
</html>`;
}

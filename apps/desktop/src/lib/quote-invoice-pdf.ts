import {
  calculateDocumentTotals,
  formatCentsAsAud,
  formatCentsPlain,
  lineItemSubtotalCents,
  type Client,
  type ClientSite,
  type Invoice,
  type LineItemFormInput,
  type Quote,
  type Tenant,
} from "@jmssaas/shared";

// Ported from apps/mobile/lib/pdf.ts's buildQuotePdfHtml/buildInvoicePdfHtml
// and their shared rendering helpers - duplicated rather than shared, same
// reasoning as lib/errors.ts and lib/shopping-list-pdf.ts: this app has no
// other dependency on mobile's lib/ directory. Layout/styling mirrors the
// same reference invoice/quote templates mobile's version was built
// against - logo top-left, doc title/number/Balance Due stacked top-right,
// plain (no $) numbers in the itemised table and Sub Total, green accent
// for invoices vs. a dark/near-black accent for quotes. The itemised table
// intentionally uses only description/quantity/unit_price_cents (never the
// labour/material/markup breakdown), so a PDF can never leak internal
// margin figures regardless of who exports it.

const ACCENT = {
  quote: "#1f2937",
  invoice: "#22a366",
} as const;

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
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatAddressLines(address: {
  line1: string | null;
  line2: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
}): string[] {
  const lines: string[] = [];
  if (address.line1) lines.push(address.line1);
  if (address.line2) lines.push(address.line2);
  if (address.suburb) lines.push(address.suburb);
  const postcodeState = [address.postcode, address.state].filter(Boolean).join(" ");
  if (postcodeState) lines.push(postcodeState);
  if (lines.length > 0) lines.push("Australia");
  return lines;
}

const BASE_STYLES = `
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #111827; margin: 0; padding: 40px; font-size: 12px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; }
  .logo { max-width: 220px; max-height: 90px; }
  .doc-block { text-align: right; }
  .doc-title { font-size: 34px; margin: 0; }
  .doc-number { font-weight: 700; font-size: 13px; margin-top: 4px; color: #111827; }
  .balance-due-label { color: #6b7280; font-size: 11px; font-weight: 700; text-transform: uppercase; margin-top: 18px; }
  .balance-due-value { font-size: 20px; font-weight: 800; color: #111827; margin-top: 2px; }
  .company-block { margin-top: 28px; }
  .company-name { font-size: 14px; font-weight: 700; margin: 0 0 4px; }
  .company-detail { color: #374151; font-size: 11px; line-height: 1.5; margin: 0; }
  .meta-row { display: flex; justify-content: space-between; margin-top: 28px; margin-bottom: 24px; gap: 24px; }
  .bill-to-label { color: #6b7280; font-size: 11px; margin-bottom: 4px; }
  .bill-to-name { font-weight: 700; font-size: 13px; margin-bottom: 2px; }
  .bill-to-detail { color: #374151; font-size: 11px; line-height: 1.5; }
  .dates-block { text-align: right; }
  .date-row { margin-bottom: 3px; font-size: 11px; }
  .date-label { color: #6b7280; margin-right: 8px; }
  .date-value { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { text-align: left; font-size: 11px; color: #fff; padding: 8px; }
  th.num, td.num { text-align: right; }
  td { padding: 8px; border-bottom: 1px solid #e5e7eb; font-size: 12px; vertical-align: top; }
  td.desc { white-space: pre-wrap; }
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
  const addressLines = formatAddressLines({
    line1: tenant.business_address_line1,
    line2: tenant.business_address_line2,
    suburb: tenant.business_suburb,
    state: tenant.business_state,
    postcode: tenant.business_postcode,
  });
  return `
    <div class="company-block">
      <p class="company-name">${escapeHtml(tenant.name)}</p>
      ${addressLines.map((line) => `<p class="company-detail">${escapeHtml(line)}</p>`).join("")}
      ${tenant.abn ? `<p class="company-detail">ABN ${escapeHtml(tenant.abn)}</p>` : ""}
      ${tenant.license_number ? `<p class="company-detail">License ${escapeHtml(tenant.license_number)}</p>` : ""}
      ${tenant.email ? `<p class="company-detail">${escapeHtml(tenant.email)}</p>` : ""}
      ${tenant.website ? `<p class="company-detail">${escapeHtml(tenant.website)}</p>` : ""}
    </div>
  `;
}

function renderHeader(docType: "quote" | "invoice", docNumber: string, balanceDueCents: number | null, tenant: Tenant): string {
  const accent = ACCENT[docType];
  const titleStyle =
    docType === "invoice"
      ? `color: ${accent}; font-weight: 300;`
      : `color: ${accent}; font-weight: 700; text-transform: uppercase;`;
  const title = docType === "invoice" ? "Invoice" : "Quote";
  return `
    <div class="header">
      <div>${tenant.logo_url ? `<img class="logo" src="${escapeHtml(tenant.logo_url)}" />` : ""}</div>
      <div class="doc-block">
        <p class="doc-title" style="${titleStyle}">${title}</p>
        <p class="doc-number"># ${escapeHtml(docNumber)}</p>
        ${
          balanceDueCents !== null
            ? `<p class="balance-due-label">Balance Due</p><p class="balance-due-value">${formatCentsAsAud(balanceDueCents)}</p>`
            : ""
        }
      </div>
    </div>
    ${renderCompanyBlock(tenant)}
  `;
}

// agencyBilling overrides the name line to "Owner/Landlord c/- Agency" for
// a real-estate job's invoice (see Workflow 4 in the Real Estate & Strata
// spec) - the address block still comes from the invoice's own `clients`
// row, since that's still where this schema's contact details live,
// unless `site` is supplied - a quote/invoice's own site_id (one of the
// client's client_sites), which takes priority over the client's single
// primary address when set. When `billToLandlord` is set (InvoiceDetail's
// "Bill to" control), the name drops the "c/- Agency" decoration and the
// phone/email lines swap to the property's own owner_landlord_phone/email
// instead of the client's - the address line is left as-is either way,
// since that's the job/property address regardless of who's paying for it.
function renderBillTo(
  client: Client,
  agencyBilling?: { ownerLandlordName: string | null; agencyName: string; billToLandlord?: boolean; ownerLandlordPhone?: string | null; ownerLandlordEmail?: string | null },
  site?: ClientSite | null
): string {
  const addressLines = site
    ? formatAddressLines({ line1: site.address_line1, line2: site.address_line2, suburb: site.suburb, state: site.state, postcode: site.postcode })
    : formatAddressLines({
        line1: client.address_line1,
        line2: client.address_line2,
        suburb: client.suburb,
        state: client.state,
        postcode: client.postcode,
      });
  const billToName = agencyBilling
    ? agencyBilling.billToLandlord
      ? (agencyBilling.ownerLandlordName ?? client.name)
      : `${agencyBilling.ownerLandlordName ?? client.name} c/- ${agencyBilling.agencyName}`
    : client.name;
  const billToPhone = agencyBilling?.billToLandlord ? (agencyBilling.ownerLandlordPhone ?? null) : client.phone;
  const billToEmail = agencyBilling?.billToLandlord ? (agencyBilling.ownerLandlordEmail ?? null) : client.email;
  return `
    <div>
      <div class="bill-to-label">Bill To</div>
      <div class="bill-to-name">${escapeHtml(billToName)}</div>
      ${site?.label ? `<div class="bill-to-detail">${escapeHtml(site.label)}</div>` : ""}
      ${addressLines.map((line) => `<div class="bill-to-detail">${escapeHtml(line)}</div>`).join("")}
      ${billToPhone ? `<div class="bill-to-detail">${escapeHtml(billToPhone)}</div>` : ""}
      ${billToEmail ? `<div class="bill-to-detail">${escapeHtml(billToEmail)}</div>` : ""}
    </div>
  `;
}

// Proof of acceptance stamped onto the document itself - the drawn
// signature captured on the public approval page (same base64 PNG data URI
// convention as report_signatures/SignaturePad.tsx), alongside the typed
// name and timestamp that already existed.
function renderAcceptanceSignature(docType: "quote" | "invoice", quoteOrInvoice: Quote | Invoice): string {
  if (quoteOrInvoice.approval_status !== "accepted" || !quoteOrInvoice.accepted_signature_svg) return "";
  const label = docType === "quote" ? "Quote accepted" : "Invoice accepted";
  return `
    <div class="section-title">${label}</div>
    <div class="section-body">
      <img src="${escapeHtml(quoteOrInvoice.accepted_signature_svg)}" style="max-width: 220px; max-height: 90px; display: block; margin-bottom: 4px;" />
      ${escapeHtml(quoteOrInvoice.accepted_by_name ?? "")}${
        quoteOrInvoice.accepted_at ? ` &middot; ${formatDate(quoteOrInvoice.accepted_at.slice(0, 10))}` : ""
      }
    </div>
  `;
}

function renderItemsTable(docType: "quote" | "invoice", lineItems: LineItemFormInput[]): string {
  const accent = ACCENT[docType];
  const rows = lineItems
    .map(
      (item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td class="desc">${escapeHtml(item.description)}</td>
        <td class="num">${item.quantity}</td>
        <td class="num">${formatCentsPlain(item.unit_price_cents)}</td>
        <td class="num">${formatCentsPlain(lineItemSubtotalCents(item))}</td>
      </tr>`
    )
    .join("");
  return `
    <table>
      <thead>
        <tr style="background: ${accent};">
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

function renderTotals(lineItems: LineItemFormInput[], balanceDueCents: number | null): string {
  const totals = calculateDocumentTotals(lineItems);
  return `
    <div class="totals">
      <div class="totals-row"><span>Sub Total</span><span>${formatCentsPlain(totals.subtotal_cents)}</span></div>
      <div class="totals-row"><span>GST</span><span>${formatCentsPlain(totals.gst_cents)}</span></div>
      <div class="totals-row total"><span>Total</span><span>${formatCentsPlain(totals.total_cents)}</span></div>
      ${
        balanceDueCents !== null
          ? `<div class="totals-row total"><span>Balance Due</span><span>${formatCentsAsAud(balanceDueCents)}</span></div>`
          : ""
      }
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
  site?: ClientSite | null;
}): string {
  const { tenant, quote, client, lineItems, site } = params;
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Quote ${escapeHtml(quote.quote_number)}</title>
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    ${renderHeader("quote", quote.quote_number, null, tenant)}

    <div class="meta-row">
      ${renderBillTo(client, undefined, site)}
      <div class="dates-block">
        <div class="date-row"><span class="date-label">Quote date</span><span class="date-value">${formatDate(quote.issue_date)}</span></div>
        <div class="date-row"><span class="date-label">Expiry date</span><span class="date-value">${formatDate(quote.expiry_date)}</span></div>
        ${quote.po_number ? `<div class="date-row"><span class="date-label">PO</span><span class="date-value">${escapeHtml(quote.po_number)}</span></div>` : ""}
      </div>
    </div>

    ${renderItemsTable("quote", lineItems)}
    ${renderTotals(lineItems, null)}
    ${renderNotes(quote.notes)}
    ${renderAcceptanceSignature("quote", quote)}
  </body>
</html>`;
}

export function buildInvoicePdfHtml(params: {
  tenant: Tenant;
  invoice: Invoice;
  client: Client;
  lineItems: LineItemFormInput[];
  agencyBilling?: { ownerLandlordName: string | null; agencyName: string; billToLandlord?: boolean; ownerLandlordPhone?: string | null; ownerLandlordEmail?: string | null };
  site?: ClientSite | null;
}): string {
  const { tenant, invoice, client, lineItems, agencyBilling, site } = params;
  // Invoices don't have their own persisted "terms" field distinct from
  // notes (see docs/SETUP.md known-gaps) - the reference template's "terms"
  // line is derived from due_date rather than a fabricated new column.
  const terms = invoice.due_date ? `Due ${formatDate(invoice.due_date)}` : "Due on receipt";
  // No payment/partial-payment tracking exists in this schema, so
  // "Balance Due" is binary: the full total while unpaid, zero once paid.
  const balanceDueCents = invoice.status === "paid" ? 0 : invoice.total_cents;
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Invoice ${escapeHtml(invoice.invoice_number)}</title>
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    ${renderHeader("invoice", invoice.invoice_number, balanceDueCents, tenant)}

    <div class="meta-row">
      ${renderBillTo(client, agencyBilling, site)}
      <div class="dates-block">
        <div class="date-row"><span class="date-label">Invoice date</span><span class="date-value">${formatDate(invoice.issue_date)}</span></div>
        <div class="date-row"><span class="date-label">Terms</span><span class="date-value">${escapeHtml(terms)}</span></div>
        <div class="date-row"><span class="date-label">Due date</span><span class="date-value">${formatDate(invoice.due_date)}</span></div>
        ${invoice.po_number ? `<div class="date-row"><span class="date-label">PO</span><span class="date-value">${escapeHtml(invoice.po_number)}</span></div>` : ""}
      </div>
    </div>

    ${renderItemsTable("invoice", lineItems)}
    ${renderTotals(lineItems, balanceDueCents)}
    ${renderNotes(invoice.notes)}
    ${renderAcceptanceSignature("invoice", invoice)}
    ${renderBankDetails(tenant)}
  </body>
</html>`;
}

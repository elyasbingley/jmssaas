import {
  calculateDocumentTotals,
  formatCentsAsAud,
  formatCentsPlain,
  lineItemSubtotalCents,
  type Client,
  type Invoice,
  type LineItemFormInput,
  type LowStockItem,
  type Quote,
  type Tenant,
} from "@jmssaas/shared";

// Builds the HTML string that gets handed to expo-print's printToFileAsync
// (see lib/print.ts) - kept as plain string-building rather than a React
// component because printToFileAsync wants a raw HTML document, not a
// React Native render tree. The itemised table intentionally uses the same
// fields as LineItemSummary (components/LineItemEditor.tsx) - description,
// unit, quantity, unit_price_cents, warranty_text - and never the labour/
// material/markup/crew/materials/internal_notes breakdown (see the
// line_item_rework_schema migration), so a PDF can never leak internal
// margin figures regardless of who exports it. warranty_text is the one
// itemized-rework field that's client-visible by design, so it prints
// directly under the description, same as the optional/waived tags below
// it.
//
// Layout and styling here deliberately mirror the person's real reference
// invoice/quote templates (uploaded as INV-000037.pdf / QT-000092.pdf):
// logo top-left, doc title/number/Balance Due stacked top-right, plain
// (no $) numbers in the itemised table and Sub Total, and a green accent
// for invoices vs a dark/near-black accent for quotes.

const ACCENT = {
  quote: "#1f2937",
  invoice: "#22a366",
} as const;

export function escapeHtml(value: string): string {
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

// Multi-line "line1 / suburb / postcode state / Australia" shape, matching
// how both reference templates lay out the business and Bill To addresses -
// distinct from lib/format.ts's formatClientAddress, which stays a single
// comma-joined line for the compact in-app views it's used in.
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
  table { width: 100%; table-layout: fixed; border-collapse: collapse; margin-bottom: 20px; }
  th { text-align: left; font-size: 11px; color: #fff; padding: 8px; }
  th.num, td.num { text-align: right; }
  /* Without this, expo-print's PDF renderer will split a tall row (a long
     wrapped description, an image) across a page boundary, leaving the
     border-bottom line drawn straight through the middle of the text. */
  tr { break-inside: avoid; page-break-inside: avoid; }
  td { padding: 8px; border-bottom: 1px solid #e5e7eb; font-size: 12px; vertical-align: top; word-wrap: break-word; }
  td.desc { white-space: pre-wrap; }
  .item-title { font-weight: 700; }
  tr.excluded-item td { color: #9ca3af; }
  tr.bundle-heading td { background: #f9fafb; font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; }
  .optional-tag { color: #7e22ce; font-size: 10px; font-weight: 700; }
  .item-image { max-width: 140px; max-height: 90px; border-radius: 4px; display: block; margin-top: 6px; }
  /* break-inside/page-break-inside here is the same orphan-prevention
     trick as the table rows above - without it, expo-print can split this
     box so the grand total lands alone at the top of a new page while
     "Sub Total"/"GST" stay behind on the previous one. */
  .totals { width: 260px; margin-left: auto; margin-bottom: 28px; border: 1px solid #1f2937; border-radius: 3px; padding: 6px 0; break-inside: avoid; page-break-inside: avoid; }
  .totals-row { display: flex; justify-content: space-between; padding: 4px 12px; font-size: 12px; }
  .totals-row.total { font-weight: 700; font-size: 14px; padding-top: 8px; padding-bottom: 8px; margin-top: 4px; border-top: 1px solid #1f2937; }
  .totals-row.total.highlight { background: #fac715; color: #5c4402; border-top: none; margin-top: 0; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6b7280; margin: 20px 0 6px; }
  .section-body { font-size: 11px; color: #374151; line-height: 1.6; white-space: pre-wrap; }
  .bank-details { display: flex; gap: 24px; }
  .bank-detail { font-size: 11px; }
  .bank-detail-label { color: #6b7280; }
  .bank-detail-value { font-weight: 700; }
  .accent-rule { border: none; border-top: 2px solid #fac715; margin: 12px 0 0; }
  .job-summary { background: #f3f4f6; border: 1px solid #1f2937; border-radius: 3px; padding: 10px 14px; margin: 8px 0 20px; break-inside: avoid; page-break-inside: avoid; }
  .job-summary-label { font-size: 9px; font-weight: 700; text-transform: uppercase; color: #6b7280; margin: 0 0 4px; }
  .job-summary-body { font-size: 11px; color: #111827; line-height: 1.5; white-space: pre-wrap; margin: 0; }
  .approval-block { break-inside: avoid; page-break-inside: avoid; margin-top: 8px; }
  .approval-instruction { font-size: 11px; color: #6b7280; margin: 4px 0 20px; }
  .signature-line { display: flex; gap: 40px; margin-bottom: 4px; }
  .signature-line span { display: block; width: 180px; border-top: 1px solid #6b7280; padding-top: 4px; font-size: 10px; color: #6b7280; }
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
  // Matches the two reference templates' distinct title treatments: the
  // invoice title is light-weight, title-case, and green; the quote title
  // is bold, uppercase, and near-black.
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
    ${docType === "quote" ? `<hr class="accent-rule" />` : ""}
  `;
}

// A short, optional highlight box summarizing the job in plain terms for a
// property owner/landlord who may not read the itemized table closely -
// backed by the quote's own `notes` field (the one free-text field meant
// to travel with the document) rather than a new column, same convention
// as apps/desktop/src/lib/quote-invoice-pdf-bytes.ts's renderJobSummary.
function renderJobSummary(notes: string | null): string {
  if (!notes) return "";
  return `
    <div class="job-summary">
      <p class="job-summary-label">Job Summary</p>
      <p class="job-summary-body">${escapeHtml(notes)}</p>
    </div>
  `;
}

// Same three badges as the desktop PDF path - license number is a real,
// persisted tenant field; the other two are generic trust-building copy,
// not tenant-specific claims (see that file's own comment on why a
// specific insured dollar figure isn't hardcoded here).
function renderTrustBadges(tenant: Tenant): string {
  const badges = [
    { title: "Licensed & Insured", body: tenant.license_number ? `Lic #${escapeHtml(tenant.license_number)} - fully insured` : "Fully licensed & insured" },
    { title: "Photo Report Included", body: "Before &amp; after completion photos provided" },
    { title: "Quality Guarantee", body: "Workmanship &amp; materials backed by warranty" },
  ];
  return `
    <div style="display: flex; gap: 8px; margin: 4px 0 20px;">
      ${badges
        .map(
          (b) => `
        <div style="flex: 1; background: #fef9dc; border: 1px solid #fac715; border-radius: 3px; padding: 8px 6px; text-align: center;">
          <div style="font-size: 9px; font-weight: 700; color: #5c4402;">${b.title}</div>
          <div style="font-size: 7.5px; color: #6b7280; margin-top: 2px;">${b.body}</div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

// A quote that hasn't been accepted yet has no signature to show - this
// renders the acceptance instruction + a blank sign-here line instead, so
// an exported/shared quote always ends with a clear call to action.
function renderApprovalBlock(): string {
  return `
    <div class="approval-block">
      <div class="section-title" style="margin-top: 0;">Approve This Quote</div>
      <p class="approval-instruction">To approve, reply to this email or sign below:</p>
      <div class="signature-line"><span>Signature</span><span>Date</span></div>
    </div>
  `;
}

// agencyBilling mirrors apps/desktop/src/lib/quote-invoice-pdf.ts's
// renderBillTo - decorates the name "Owner/Landlord c/- Agency" for a
// real-estate invoice, or (once billToLandlord is set, see
// invoices/[id].tsx's "Billed to" control) drops the agency decoration
// and swaps the phone/email lines to the property's own
// owner_landlord_phone/email instead of the client's. The address line
// stays the job/property address regardless of who's paying.
function renderBillTo(
  client: Client,
  agencyBilling?: { ownerLandlordName: string | null; agencyName: string; billToLandlord?: boolean; ownerLandlordPhone?: string | null; ownerLandlordEmail?: string | null }
): string {
  const addressLines = formatAddressLines({
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
      ${addressLines.map((line) => `<div class="bill-to-detail">${escapeHtml(line)}</div>`).join("")}
      ${billToPhone ? `<div class="bill-to-detail">${escapeHtml(billToPhone)}</div>` : ""}
      ${billToEmail ? `<div class="bill-to-detail">${escapeHtml(billToEmail)}</div>` : ""}
    </div>
  `;
}

// A line item's description's first line is treated as a bold title (e.g.
// "RIDGE CAPPING RE-POINTING") with the rest as normal body text below it -
// there's no separate title column on the schema, so this splits on the
// first newline, same convention as the desktop PDF path.
function renderDescription(description: string): string {
  const parts = (description || "-").split("\n").filter((l) => l.trim().length > 0);
  if (parts.length === 0) return `<span class="item-title">-</span>`;
  const [title, ...body] = parts;
  return `<span class="item-title">${escapeHtml(title)}</span>${body.length > 0 ? `<br/>${escapeHtml(body.join(" "))}` : ""}`;
}

function renderItemsTable(docType: "quote" | "invoice", lineItems: LineItemFormInput[]): string {
  const accent = ACCENT[docType];
  let lastBundleName: string | null = null;
  const rows = lineItems
    .map((item) => {
      const excluded = !!item.is_optional && !item.is_included;
      const heading =
        item.bundle_name && item.bundle_name !== lastBundleName
          ? `<tr class="bundle-heading"><td colspan="4">${escapeHtml(item.bundle_name)}</td></tr>`
          : "";
      lastBundleName = item.bundle_name || null;
      return `
      ${heading}
      <tr class="${excluded ? "excluded-item" : ""}">
        <td class="desc">${renderDescription(item.description)}
          ${item.warranty_text ? `<br/><span style="color:#6b7280;font-size:10px;">${escapeHtml(item.warranty_text)}</span>` : ""}
          ${item.is_optional ? `<br/><span class="optional-tag">${excluded ? "Optional - not selected" : "Optional - included"}</span>` : ""}
          ${item.waived_amount_cents > 0 ? `<br/><span style="color:#1d4ed8;font-size:10px;font-weight:700;">Waived - Membership</span>` : ""}
          ${item.image_url ? `<img class="item-image" src="${escapeHtml(item.image_url)}" />` : ""}
        </td>
        <td class="num">${item.quantity}${item.unit ? ` ${escapeHtml(item.unit)}` : ""}</td>
        <td class="num">${formatCentsPlain(item.unit_price_cents)}</td>
        <td class="num" style="font-weight: 700;">${excluded ? "-" : formatCentsPlain(lineItemSubtotalCents(item))}</td>
      </tr>`;
    })
    .join("");
  return `
    <table>
      <thead>
        <tr style="background: ${accent};">
          <th style="width: 60%;">Item &amp; Description</th>
          <th class="num" style="width: 10%;">Qty</th>
          <th class="num" style="width: 15%;">Rate</th>
          <th class="num" style="width: 15%;">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// highlightGrandTotal (quotes only) picks out the grand total in yellow,
// the one sparing use of the brand accent on an otherwise charcoal/white
// card - everywhere else yellow would read as "caution tape" rather than
// drawing the eye to the number that matters, same reasoning as the
// desktop PDF path's own totals card.
function renderTotals(lineItems: LineItemFormInput[], balanceDueCents: number | null, membershipDiscountCents = 0, highlightGrandTotal = false): string {
  const totals = calculateDocumentTotals(lineItems);
  const grandTotalLabel = balanceDueCents !== null ? "Total" : "Grand Total";
  return `
    <div class="totals">
      <div class="totals-row"><span>Sub Total</span><span>${formatCentsPlain(totals.subtotal_cents)}</span></div>
      <div class="totals-row"><span>GST (10%)</span><span>${formatCentsPlain(totals.gst_cents)}</span></div>
      ${
        membershipDiscountCents > 0
          ? `<div class="totals-row"><span>Membership discount</span><span>-${formatCentsPlain(membershipDiscountCents)}</span></div>`
          : ""
      }
      <div class="totals-row total${highlightGrandTotal ? " highlight" : ""}"><span>${grandTotalLabel}</span><span>${formatCentsPlain(totals.total_cents - membershipDiscountCents)}</span></div>
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

function renderFinePrint(finePrintText: string | null): string {
  if (!finePrintText) return "";
  return `
    <div class="section-title">Fine Print</div>
    <div class="section-body">${escapeHtml(finePrintText)}</div>
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

function renderAcceptedSignature(quote: Quote): string {
  if (!quote.accepted_signature_svg) return "";
  const label = [quote.accepted_by_name, quote.accepted_at ? formatDate(quote.accepted_at.slice(0, 10)) : null].filter(Boolean).join(" - ");
  return `
    <div class="approval-block">
      <div class="section-title" style="margin-top: 0;">Accepted</div>
      <img src="${escapeHtml(quote.accepted_signature_svg)}" style="max-width: 200px; max-height: 90px; display: block; margin-bottom: 4px;" />
      ${label ? `<p class="section-body" style="margin: 0;">${escapeHtml(label)}</p>` : ""}
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
  const isAccepted = quote.approval_status === "accepted" && !!quote.accepted_signature_svg;
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    ${renderHeader("quote", quote.quote_number, null, tenant)}

    <div class="meta-row">
      ${renderBillTo(client)}
      <div class="dates-block">
        <div class="date-row"><span class="date-label">Quote date</span><span class="date-value">${formatDate(quote.issue_date)}</span></div>
        <div class="date-row"><span class="date-label">Expiry date</span><span class="date-value">${formatDate(quote.expiry_date)}</span></div>
        ${quote.po_number ? `<div class="date-row"><span class="date-label">PO</span><span class="date-value">${escapeHtml(quote.po_number)}</span></div>` : ""}
      </div>
    </div>

    ${renderJobSummary(quote.notes)}
    ${renderItemsTable("quote", lineItems)}
    ${renderTrustBadges(tenant)}
    ${renderTotals(lineItems, null, quote.membership_discount_cents, true)}
    ${isAccepted ? renderAcceptedSignature(quote) : renderApprovalBlock()}
    ${renderFinePrint(quote.fine_print_text)}
  </body>
</html>`;
}

export function buildInvoicePdfHtml(params: {
  tenant: Tenant;
  invoice: Invoice;
  client: Client;
  lineItems: LineItemFormInput[];
  agencyBilling?: { ownerLandlordName: string | null; agencyName: string; billToLandlord?: boolean; ownerLandlordPhone?: string | null; ownerLandlordEmail?: string | null };
}): string {
  const { tenant, invoice, client, lineItems, agencyBilling } = params;
  // Invoices don't have their own persisted "terms" field distinct from
  // notes (see docs/SETUP.md known-gaps) - the reference template's "terms"
  // line is derived from due_date rather than a fabricated new column.
  const terms = invoice.due_date ? `Due ${formatDate(invoice.due_date)}` : "Due on receipt";
  // No payment/partial-payment tracking exists in this schema (see
  // docs/SETUP.md known-gaps), so "Balance Due" is binary: the full total
  // while unpaid, zero once marked paid.
  const balanceDueCents = invoice.status === "paid" ? 0 : invoice.total_cents;
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    ${renderHeader("invoice", invoice.invoice_number, balanceDueCents, tenant)}

    <div class="meta-row">
      ${renderBillTo(client, agencyBilling)}
      <div class="dates-block">
        <div class="date-row"><span class="date-label">Invoice date</span><span class="date-value">${formatDate(invoice.issue_date)}</span></div>
        <div class="date-row"><span class="date-label">Terms</span><span class="date-value">${escapeHtml(terms)}</span></div>
        <div class="date-row"><span class="date-label">Due date</span><span class="date-value">${formatDate(invoice.due_date)}</span></div>
        ${invoice.po_number ? `<div class="date-row"><span class="date-label">PO</span><span class="date-value">${escapeHtml(invoice.po_number)}</span></div>` : ""}
      </div>
    </div>

    ${renderItemsTable("invoice", lineItems)}
    ${renderTotals(lineItems, balanceDueCents, invoice.membership_discount_cents)}
    ${renderNotes(invoice.notes)}
    ${renderFinePrint(invoice.fine_print_text)}
    ${renderBankDetails(tenant)}
  </body>
</html>`;
}

// Reorder quantity isn't a stored column - just enough to bring the
// location back up to the item's own ideal_stock target (the "par level"
// a reorder should restock to), minimum 1. reorder_threshold is the alert
// point, not the target - using it here would mean every reorder just
// barely clears the alert instead of actually restocking properly. Simple,
// easy-to-explain default rather than any kind of demand forecasting.
function suggestedReorderQuantity(item: LowStockItem): number {
  return Math.max(item.ideal_stock - item.quantity, 1);
}

function renderShoppingListTable(items: LowStockItem[]): string {
  const rows = items
    .map(
      (item) => `
      <tr>
        <td class="desc">${escapeHtml(item.item_name)}${item.supplier_name ? `<br/><span style="color:#6b7280;font-size:10px;">${escapeHtml(item.supplier_name)}</span>` : ""}</td>
        <td class="num">${item.quantity}</td>
        <td class="num">${item.ideal_stock}</td>
        <td class="num">${suggestedReorderQuantity(item)}</td>
      </tr>`
    )
    .join("");
  return `
    <table>
      <thead>
        <tr style="background: ${ACCENT.quote};">
          <th>Item</th>
          <th class="num" style="width: 70px;">On hand</th>
          <th class="num" style="width: 70px;">Ideal stock</th>
          <th class="num" style="width: 80px;">Order qty</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// Groups by location - one heading + table per inventory_locations row, so
// whoever's ordering knows exactly where each item is short, not just that
// the tenant overall is short somewhere. `items` is expected to already be
// scoped to whatever the caller wants on this particular list (e.g. the
// Inventory screen's supplier filter) - this function itself doesn't
// filter, it just renders and, when every item shares one supplier, says
// so in the header so a printed/shared copy is unambiguous about which
// supplier run it's for.
export function buildShoppingListPdfHtml(params: { tenant: Tenant; items: LowStockItem[] }): string {
  const { tenant, items } = params;
  const locationNames = [...new Set(items.map((item) => item.location_name))];
  const supplierNames = [...new Set(items.map((item) => item.supplier_name).filter((name): name is string => !!name))];
  const supplierSubtitle = items.length > 0 && supplierNames.length === 1 ? supplierNames[0] : null;
  const generatedAt = new Date().toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    <div class="header">
      <div>${tenant.logo_url ? `<img class="logo" src="${escapeHtml(tenant.logo_url)}" />` : ""}</div>
      <div class="doc-block">
        <p class="doc-title" style="color: ${ACCENT.quote}; font-weight: 700; text-transform: uppercase;">Shopping List</p>
        ${supplierSubtitle ? `<p class="doc-number">${escapeHtml(supplierSubtitle)}</p>` : ""}
        <p class="doc-number">Generated ${escapeHtml(generatedAt)}</p>
      </div>
    </div>
    ${renderCompanyBlock(tenant)}

    ${
      items.length === 0
        ? `<p class="section-body">Nothing is below its reorder threshold right now.</p>`
        : locationNames
            .map(
              (locationName) => `
        <div class="section-title">${escapeHtml(locationName)}</div>
        ${renderShoppingListTable(items.filter((item) => item.location_name === locationName))}
      `
            )
            .join("")
    }
  </body>
</html>`;
}

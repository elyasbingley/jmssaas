import { jsPDF } from "jspdf";
import {
  calculateDocumentTotals,
  formatCentsAsAud,
  lineItemSubtotalCents,
  type Client,
  type ClientSite,
  type Invoice,
  type LineItemFormInput,
  type Quote,
  type Tenant,
} from "@jmssaas/shared";

// Real PDF *bytes* (a jsPDF Blob), not the print-dialog HTML flow
// quote-invoice-pdf.ts's buildQuotePdfHtml/buildInvoicePdfHtml feed to
// print.ts's exportPdf - that flow needs a human in the loop (the
// browser's own "Save as PDF" dialog), which is fine for a deliberate
// "Export PDF" click but can't be attached to an outgoing email with no
// user interaction. Same jsPDF-cursor approach as report-pdf.ts (the
// other place in this app that needs real bytes, for the same reason:
// nothing to click through), simplified/re-laid-out for the quote/invoice
// shape rather than sharing report-pdf.ts's PdfCursor directly (Qty/Rate/
// Amount table + totals box needs different drawing primitives than a
// report's question/answer list does).

const PAGE_WIDTH = 210; // A4 mm
const PAGE_HEIGHT = 297;
const MARGIN = 15;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const ACCENT: Record<"quote" | "invoice", [number, number, number]> = {
  quote: [31, 41, 55],
  invoice: [34, 163, 102],
};

// Used by QuoteDetail/InvoiceDetail to turn the generated PDF Blob into the
// same data-URI shape EmailAttachment.content expects everywhere else
// (readFileAsDataUrl in EmailComposeModal.tsx does the identical FileReader
// dance for user-picked files).
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read generated PDF"));
    reader.readAsDataURL(blob);
  });
}

async function fetchImageDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function formatDate(dateString: string | null): string {
  if (!dateString) return "-";
  const d = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateString;
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function addressLines(address: {
  address_line1: string | null;
  address_line2?: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
}): string[] {
  const lines: string[] = [];
  if (address.address_line1) lines.push(address.address_line1);
  if (address.address_line2) lines.push(address.address_line2);
  const suburbLine = [address.suburb, address.state, address.postcode].filter(Boolean).join(" ");
  if (suburbLine) lines.push(suburbLine);
  return lines;
}

class Cursor {
  doc: jsPDF;
  y = MARGIN;

  constructor(doc: jsPDF) {
    this.doc = doc;
  }

  ensureSpace(height: number) {
    if (this.y + height > PAGE_HEIGHT - MARGIN) {
      this.doc.addPage();
      this.y = MARGIN;
    }
  }

  text(value: string, x: number, size: number, color: [number, number, number] = [55, 65, 81], align: "left" | "right" = "left") {
    this.doc.setFont("helvetica", "normal").setFontSize(size).setTextColor(...color);
    this.doc.text(value, x, this.y, { align });
  }

  bold(value: string, x: number, size: number, color: [number, number, number] = [17, 24, 39], align: "left" | "right" = "left") {
    this.doc.setFont("helvetica", "bold").setFontSize(size).setTextColor(...color);
    this.doc.text(value, x, this.y, { align });
  }
}

async function renderHeader(
  cursor: Cursor,
  tenant: Tenant,
  accent: [number, number, number],
  title: string,
  number: string,
  balanceDueCents: number | null
) {
  if (tenant.logo_url) {
    const dataUrl = await fetchImageDataUrl(tenant.logo_url);
    if (dataUrl) {
      try {
        cursor.doc.addImage(dataUrl, "PNG", MARGIN, cursor.y, 40, 20, undefined, "MEDIUM");
      } catch {
        // Some logo formats/data URIs reject the format hint - skip the
        // image rather than fail the whole PDF over a logo.
      }
    }
  }
  cursor.doc.setFont("helvetica", "bold").setFontSize(24).setTextColor(...accent);
  cursor.doc.text(title, PAGE_WIDTH - MARGIN, cursor.y + 8, { align: "right" });
  cursor.doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(17, 24, 39);
  cursor.doc.text(`# ${number}`, PAGE_WIDTH - MARGIN, cursor.y + 15, { align: "right" });
  if (balanceDueCents !== null) {
    cursor.doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(107, 114, 128);
    cursor.doc.text("Balance Due", PAGE_WIDTH - MARGIN, cursor.y + 22, { align: "right" });
    cursor.doc.setFont("helvetica", "bold").setFontSize(13).setTextColor(17, 24, 39);
    cursor.doc.text(formatCentsAsAud(balanceDueCents), PAGE_WIDTH - MARGIN, cursor.y + 28, { align: "right" });
  }
  cursor.y += 24;

  cursor.bold(tenant.name, MARGIN, 12);
  cursor.y += 5;
  const companyLines = [
    ...addressLines({
      address_line1: tenant.business_address_line1,
      address_line2: tenant.business_address_line2,
      suburb: tenant.business_suburb,
      state: tenant.business_state,
      postcode: tenant.business_postcode,
    }),
    tenant.abn ? `ABN ${tenant.abn}` : null,
    tenant.license_number ? `License ${tenant.license_number}` : null,
    tenant.email,
  ].filter((line): line is string => !!line);
  for (const line of companyLines) {
    cursor.text(line, MARGIN, 9);
    cursor.y += 4.5;
  }
  cursor.y += 6;
}

function renderBillToAndDates(
  cursor: Cursor,
  client: Client,
  site: ClientSite | null,
  billToName: string,
  dateRows: { label: string; value: string }[],
  billToContact?: { phone: string | null; email: string | null }
) {
  const startY = cursor.y;
  cursor.text("Bill To", MARGIN, 9, [107, 114, 128]);
  cursor.y += 5;
  cursor.bold(billToName, MARGIN, 11);
  cursor.y += 5;
  const lines = site
    ? addressLines(site)
    : addressLines({
        address_line1: client.address_line1,
        address_line2: client.address_line2,
        suburb: client.suburb,
        state: client.state,
        postcode: client.postcode,
      });
  const contactLines = billToContact ? [billToContact.phone, billToContact.email] : [client.phone, client.email];
  for (const line of [...lines, ...contactLines].filter((l): l is string => !!l)) {
    cursor.text(line, MARGIN, 9);
    cursor.y += 4.5;
  }
  const leftBottom = cursor.y;

  cursor.y = startY;
  for (const row of dateRows) {
    cursor.text(row.label, PAGE_WIDTH - MARGIN - 30, 9, [107, 114, 128], "right");
    cursor.bold(row.value, PAGE_WIDTH - MARGIN, 9, [17, 24, 39], "right");
    cursor.y += 5;
  }
  const rightBottom = cursor.y;

  cursor.y = Math.max(leftBottom, rightBottom) + 6;
}

const COL_DESC_X = MARGIN;
const COL_QTY_X = PAGE_WIDTH - MARGIN - 55;
const COL_RATE_X = PAGE_WIDTH - MARGIN - 32;
const COL_AMOUNT_X = PAGE_WIDTH - MARGIN;

function renderLineItemsTable(cursor: Cursor, accent: [number, number, number], lineItems: LineItemFormInput[]) {
  cursor.ensureSpace(12);
  cursor.doc.setFillColor(...accent);
  cursor.doc.rect(MARGIN, cursor.y - 4, CONTENT_WIDTH, 7, "F");
  cursor.doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(255, 255, 255);
  cursor.doc.text("Item & Description", COL_DESC_X + 1, cursor.y);
  cursor.doc.text("Qty", COL_QTY_X, cursor.y, { align: "right" });
  cursor.doc.text("Rate", COL_RATE_X, cursor.y, { align: "right" });
  cursor.doc.text("Amount", COL_AMOUNT_X, cursor.y, { align: "right" });
  cursor.y += 6;

  for (const item of lineItems) {
    const descLines = cursor.doc.splitTextToSize(item.description || "-", COL_QTY_X - COL_DESC_X - 40) as string[];
    const showWaived = item.waived_amount_cents > 0;
    const waivedLineCount = showWaived ? 1 : 0;
    cursor.ensureSpace((descLines.length + waivedLineCount) * 4.5 + 4);
    const rowTop = cursor.y;
    cursor.doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(55, 65, 81);
    descLines.forEach((line, i) => cursor.doc.text(line, COL_DESC_X, rowTop + i * 4.5));
    if (showWaived) {
      cursor.doc.setFont("helvetica", "bold").setFontSize(8).setTextColor(29, 78, 216);
      cursor.doc.text("Waived - Membership", COL_DESC_X, rowTop + descLines.length * 4.5);
    }
    cursor.doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(55, 65, 81);
    cursor.doc.text(String(item.quantity), COL_QTY_X, rowTop, { align: "right" });
    cursor.doc.text(formatCentsAsAud(item.unit_price_cents), COL_RATE_X, rowTop, { align: "right" });
    cursor.doc.text(formatCentsAsAud(lineItemSubtotalCents(item)), COL_AMOUNT_X, rowTop, { align: "right" });
    cursor.y = rowTop + Math.max((descLines.length + waivedLineCount) * 4.5, 4.5) + 2;
    cursor.doc.setDrawColor(229, 231, 235);
    cursor.doc.line(MARGIN, cursor.y - 1, PAGE_WIDTH - MARGIN, cursor.y - 1);
  }
  cursor.y += 4;
}

function renderTotals(cursor: Cursor, lineItems: LineItemFormInput[], balanceDueCents: number | null, membershipDiscountCents = 0) {
  const totals = calculateDocumentTotals(lineItems);
  cursor.ensureSpace(24);
  const rows: [string, string, boolean][] = [
    ["Sub Total", formatCentsAsAud(totals.subtotal_cents), false],
    ["GST", formatCentsAsAud(totals.gst_cents), false],
  ];
  if (membershipDiscountCents > 0) rows.push(["Membership discount", `-${formatCentsAsAud(membershipDiscountCents)}`, false]);
  rows.push(["Total", formatCentsAsAud(totals.total_cents - membershipDiscountCents), true]);
  if (balanceDueCents !== null) rows.push(["Balance Due", formatCentsAsAud(balanceDueCents), true]);
  for (const [label, value, bold] of rows) {
    if (bold) {
      cursor.doc.setDrawColor(17, 24, 39);
      cursor.doc.line(PAGE_WIDTH - MARGIN - 60, cursor.y - 4, PAGE_WIDTH - MARGIN, cursor.y - 4);
    }
    cursor.text(label, PAGE_WIDTH - MARGIN - 60, bold ? 11 : 9, bold ? [17, 24, 39] : [107, 114, 128]);
    if (bold) cursor.bold(value, PAGE_WIDTH - MARGIN, 11, [17, 24, 39], "right");
    else cursor.text(value, PAGE_WIDTH - MARGIN, 9, [55, 65, 81], "right");
    cursor.y += bold ? 7 : 5.5;
  }
  cursor.y += 4;
}

function renderNotes(cursor: Cursor, notes: string | null) {
  if (!notes) return;
  cursor.ensureSpace(12);
  cursor.bold("Notes", MARGIN, 9, [107, 114, 128]);
  cursor.y += 5;
  const lines = cursor.doc.splitTextToSize(notes, CONTENT_WIDTH) as string[];
  for (const line of lines) {
    cursor.ensureSpace(5);
    cursor.text(line, MARGIN, 9);
    cursor.y += 4.5;
  }
  cursor.y += 4;
}

function renderBankDetails(cursor: Cursor, tenant: Tenant) {
  if (!tenant.bank_account_name && !tenant.bank_bsb && !tenant.bank_account_number) return;
  cursor.ensureSpace(16);
  cursor.bold("Bank Details", MARGIN, 9, [107, 114, 128]);
  cursor.y += 5;
  const parts = [
    tenant.bank_account_name ? `Account name: ${tenant.bank_account_name}` : null,
    tenant.bank_bsb ? `BSB: ${tenant.bank_bsb}` : null,
    tenant.bank_account_number ? `Account number: ${tenant.bank_account_number}` : null,
  ].filter((p): p is string => !!p);
  for (const line of parts) {
    cursor.text(line, MARGIN, 9);
    cursor.y += 4.5;
  }
}

async function renderSignature(cursor: Cursor, signerName: string | null, acceptedAt: string | null, svgData: string | null) {
  if (!svgData) return;
  cursor.ensureSpace(30);
  cursor.bold("Accepted", MARGIN, 9, [107, 114, 128]);
  cursor.y += 5;
  try {
    cursor.doc.addImage(svgData, "PNG", MARGIN, cursor.y, 50, 22, undefined, "MEDIUM");
  } catch {
    // Ignore an unembeddable signature rather than failing the PDF.
  }
  cursor.y += 24;
  const label = [signerName, acceptedAt ? formatDate(acceptedAt.slice(0, 10)) : null].filter(Boolean).join(" - ");
  if (label) {
    cursor.text(label, MARGIN, 9);
    cursor.y += 5;
  }
}

export async function buildQuotePdfBytes(params: {
  tenant: Tenant;
  quote: Quote;
  client: Client;
  lineItems: LineItemFormInput[];
  site?: ClientSite | null;
}): Promise<Blob> {
  const { tenant, quote, client, lineItems, site } = params;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const cursor = new Cursor(doc);

  await renderHeader(cursor, tenant, ACCENT.quote, "QUOTE", quote.quote_number, null);
  renderBillToAndDates(cursor, client, site ?? null, client.name, [
    { label: "Quote date", value: formatDate(quote.issue_date) },
    { label: "Expiry date", value: formatDate(quote.expiry_date) },
  ]);
  renderLineItemsTable(cursor, ACCENT.quote, lineItems);
  renderTotals(cursor, lineItems, null, quote.membership_discount_cents);
  renderNotes(cursor, quote.notes);
  await renderSignature(cursor, quote.accepted_by_name, quote.accepted_at, quote.accepted_signature_svg);

  return doc.output("blob");
}

export async function buildInvoicePdfBytes(params: {
  tenant: Tenant;
  invoice: Invoice;
  client: Client;
  lineItems: LineItemFormInput[];
  site?: ClientSite | null;
  agencyBilling?: { ownerLandlordName: string | null; agencyName: string; billToLandlord?: boolean; ownerLandlordPhone?: string | null; ownerLandlordEmail?: string | null };
}): Promise<Blob> {
  const { tenant, invoice, client, lineItems, site, agencyBilling } = params;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const cursor = new Cursor(doc);

  const balanceDueCents = invoice.status === "paid" ? 0 : invoice.total_cents;
  const billToName = agencyBilling
    ? agencyBilling.billToLandlord
      ? (agencyBilling.ownerLandlordName ?? client.name)
      : `${agencyBilling.ownerLandlordName ?? client.name} c/- ${agencyBilling.agencyName}`
    : client.name;
  const billToContact = agencyBilling?.billToLandlord
    ? { phone: agencyBilling.ownerLandlordPhone ?? null, email: agencyBilling.ownerLandlordEmail ?? null }
    : undefined;

  await renderHeader(cursor, tenant, ACCENT.invoice, "INVOICE", invoice.invoice_number, balanceDueCents);
  renderBillToAndDates(
    cursor,
    client,
    site ?? null,
    billToName,
    [
      { label: "Invoice date", value: formatDate(invoice.issue_date) },
      { label: "Terms", value: invoice.due_date ? `Due ${formatDate(invoice.due_date)}` : "Due on receipt" },
      { label: "Due date", value: formatDate(invoice.due_date) },
    ],
    billToContact
  );
  renderLineItemsTable(cursor, ACCENT.invoice, lineItems);
  renderTotals(cursor, lineItems, balanceDueCents, invoice.membership_discount_cents);
  renderNotes(cursor, invoice.notes);
  await renderSignature(cursor, invoice.accepted_by_name, invoice.accepted_at, invoice.accepted_signature_svg);
  renderBankDetails(cursor, tenant);

  return doc.output("blob");
}

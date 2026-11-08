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
//
// This is also now the canonical "Export PDF" path for quotes/invoices
// (QuoteDetail/InvoiceDetail download this Blob directly) - the old
// browser-print-dialog route via quote-invoice-pdf.ts + print.ts's
// exportPdf() is no longer used for quotes/invoices, since Chrome's print
// dialog stamps its own "Headers and footers" (document title/URL at top,
// page number/date at bottom) onto the output with no way to suppress it
// from the page itself.

const PAGE_WIDTH = 210; // A4 mm
const PAGE_HEIGHT = 297;
const MARGIN = 15;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Charcoal for structure (header bar, table header, card borders, body
// text) - signals trust/competence on a document that's asking someone to
// pay money. Yellow is deliberately used ONLY as a sparing accent (the
// totals-card grand total, the trust badges) rather than as a broad fill -
// used everywhere it would read as "caution tape"/cheap rather than
// premium. Invoices keep their own pre-existing green accent untouched.
const CHARCOAL: [number, number, number] = [31, 41, 55];
const CHARCOAL_DARK: [number, number, number] = [17, 24, 39];
const CHARCOAL_MUTED: [number, number, number] = [107, 114, 128];
const YELLOW: [number, number, number] = [250, 204, 21];
const YELLOW_INK: [number, number, number] = [92, 68, 2]; // text on a yellow fill needs this much contrast to stay readable
const YELLOW_TINT: [number, number, number] = [254, 249, 220]; // pale wash for badge/box backgrounds

const ACCENT: Record<"quote" | "invoice", [number, number, number]> = {
  quote: CHARCOAL,
  invoice: [34, 163, 102],
};

// Used by QuoteDetail/InvoiceDetail to turn the generated PDF Blob into the
// same data-URI shape EmailAttachment.content expects everywhere else
// (readFileAsDataUrl in EmailComposeModal.tsx does the identical FileReader
// dance for user-picked files), and also to trigger a direct browser
// download for the "Export PDF" button (see downloadBlob below).
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read generated PDF"));
    reader.readAsDataURL(blob);
  });
}

// Triggers a normal browser file download for a generated PDF Blob - no
// print dialog involved, so none of Chrome's own print header/footer
// chrome ever gets a chance to render onto the page.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// jsPDF's addImage stretches the source into whatever box you give it - it
// does not preserve the image's own aspect ratio the way the HTML/print
// pipeline's `max-width`/`max-height` CSS does. Reading the natural size via
// getImageProperties and contain-fitting it into (maxW, maxH) keeps every
// image (logo, line-item photo, signature) undistorted here too.
function addContainedImage(doc: jsPDF, dataUrl: string, x: number, y: number, maxW: number, maxH: number) {
  const props = doc.getImageProperties(dataUrl);
  const scale = Math.min(maxW / props.width, maxH / props.height);
  const w = props.width * scale;
  const h = props.height * scale;
  doc.addImage(dataUrl, props.fileType || "PNG", x, y, w, h, undefined, "MEDIUM");
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

// Company clients store the agency/company name in company_name and the
// primary contact person's name in name (see Client's own field comment) -
// e.g. company_name "Aspire Property Agents", name "Sam". Individual
// clients have no company_name, so billToName is just their name.
function billToNameAndAttn(client: Client): { name: string; attn: string | null } {
  if (client.client_type === "company" && client.company_name) {
    return { name: client.company_name, attn: client.name || null };
  }
  return { name: client.name, attn: null };
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
  balanceDueCents: number | null,
  dates: { label: string; value: string }[]
) {
  const topY = cursor.y;
  if (tenant.logo_url) {
    const dataUrl = await fetchImageDataUrl(tenant.logo_url);
    if (dataUrl) {
      try {
        // Sized as a mark/icon, not a source of legible text - the logo
        // graphic's own baked-in wordmark is NOT relied on for legibility
        // here (it reads as a blur at any size this small); the company
        // name/ABN/license/email below are the legible, code-rendered text
        // that actually satisfies "clearly displays the company name" etc.
        addContainedImage(cursor.doc, dataUrl, MARGIN, cursor.y, 34, 34);
      } catch {
        // Some logo formats/data URIs reject the format hint - skip the
        // image rather than fail the whole PDF over a logo.
      }
    }
  }
  cursor.doc.setFont("helvetica", "bold").setFontSize(22).setTextColor(...accent);
  cursor.doc.text(title, PAGE_WIDTH - MARGIN, cursor.y + 7, { align: "right" });
  cursor.doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...CHARCOAL_DARK);
  cursor.doc.text(`# ${number}`, PAGE_WIDTH - MARGIN, cursor.y + 14, { align: "right" });
  let rightY = cursor.y + 14;
  if (balanceDueCents !== null) {
    cursor.doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...CHARCOAL_MUTED);
    cursor.doc.text("Balance Due", PAGE_WIDTH - MARGIN, rightY + 7, { align: "right" });
    cursor.doc.setFont("helvetica", "bold").setFontSize(13).setTextColor(...CHARCOAL_DARK);
    cursor.doc.text(formatCentsAsAud(balanceDueCents), PAGE_WIDTH - MARGIN, rightY + 13, { align: "right" });
    rightY += 13;
  }
  // Issue/expiry dates sit directly under the doc number, in the header
  // block itself, right-aligned - not buried further down the page.
  for (const row of dates) {
    rightY += 5.5;
    cursor.doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...CHARCOAL_MUTED);
    cursor.doc.text(row.label, PAGE_WIDTH - MARGIN - 28, rightY, { align: "right" });
    cursor.doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(...CHARCOAL_DARK);
    cursor.doc.text(row.value, PAGE_WIDTH - MARGIN, rightY, { align: "right" });
  }

  cursor.y = topY + 36;

  cursor.bold(tenant.name, MARGIN, 12, CHARCOAL_DARK);
  cursor.y += 5;
  const companyLines = [
    ...addressLines({
      address_line1: tenant.business_address_line1,
      address_line2: tenant.business_address_line2,
      suburb: tenant.business_suburb,
      state: tenant.business_state,
      postcode: tenant.business_postcode,
    }),
    [tenant.license_number ? `License ${tenant.license_number}` : null, tenant.abn ? `ABN ${tenant.abn}` : null].filter(Boolean).join("  |  ") || null,
    [tenant.email, tenant.website].filter(Boolean).join("  |  ") || null,
  ].filter((line): line is string => !!line);
  for (const line of companyLines) {
    cursor.text(line, MARGIN, 9, CHARCOAL_MUTED);
    cursor.y += 4.3;
  }
  cursor.y += 3;
  cursor.doc.setDrawColor(...YELLOW);
  cursor.doc.setLineWidth(1);
  cursor.doc.line(MARGIN, cursor.y, PAGE_WIDTH - MARGIN, cursor.y);
  cursor.doc.setLineWidth(0.2);
  cursor.y += 6;
}

// Bill To / Site columns sit side by side when a site is set (a job's
// physical property address is frequently NOT the billing party's own
// address - an agency's billing address vs. the rental property being
// worked on, for example); otherwise Bill To alone uses the client's own
// address, same as before this column existed.
function renderBillToSiteAndDates(
  cursor: Cursor,
  client: Client,
  site: ClientSite | null,
  billToOverride: { name: string; attn?: string | null; contact?: { phone: string | null; email: string | null } } | null
) {
  const startY = cursor.y;
  const colWidth = site ? CONTENT_WIDTH * 0.46 : CONTENT_WIDTH * 0.7;
  const siteColX = MARGIN + colWidth + 8;

  const { name: autoName, attn: autoAttn } = billToNameAndAttn(client);
  const billToName = billToOverride?.name ?? autoName;
  const billToAttn = billToOverride ? (billToOverride.attn ?? null) : autoAttn;
  const contact = billToOverride?.contact ?? { phone: client.phone, email: client.email };

  cursor.text("Bill To", MARGIN, 9, CHARCOAL_MUTED);
  cursor.y += 5;
  cursor.bold(billToName, MARGIN, 11, CHARCOAL_DARK);
  cursor.y += 5;
  if (billToAttn) {
    cursor.text(`Attn: ${billToAttn}`, MARGIN, 9, CHARCOAL_MUTED);
    cursor.y += 4.5;
  }
  const billLines = site
    ? []
    : addressLines({
        address_line1: client.address_line1,
        address_line2: client.address_line2,
        suburb: client.suburb,
        state: client.state,
        postcode: client.postcode,
      });
  for (const line of [...billLines, contact.phone, contact.email].filter((l): l is string => !!l)) {
    cursor.text(line, MARGIN, 9, CHARCOAL_MUTED);
    cursor.y += 4.5;
  }
  const leftBottom = cursor.y;

  let siteBottom = startY;
  if (site) {
    cursor.y = startY;
    cursor.text("Site / Property Address", siteColX, 9, CHARCOAL_MUTED);
    cursor.y += 5;
    cursor.bold(site.label || "Job site", siteColX, 11, CHARCOAL_DARK);
    cursor.y += 5;
    for (const line of addressLines(site)) {
      cursor.text(line, siteColX, 9, CHARCOAL_MUTED);
      cursor.y += 4.5;
    }
    siteBottom = cursor.y;
  }

  cursor.y = Math.max(leftBottom, siteBottom) + 5;
}

function renderDatesRow(cursor: Cursor, dateRows: { label: string; value: string }[]) {
  // Kept for invoices, which still show Terms/Due date/PO rows below the
  // bill-to block (quotes show issue/expiry dates up in the header band
  // instead, via renderHeader's `dates` param).
  const startY = cursor.y;
  for (const row of dateRows) {
    cursor.text(row.label, PAGE_WIDTH - MARGIN - 30, 9, CHARCOAL_MUTED, "right");
    cursor.bold(row.value, PAGE_WIDTH - MARGIN, 9, CHARCOAL_DARK, "right");
    cursor.y += 5;
  }
  cursor.y = Math.max(cursor.y, startY) + 1;
}

// A short, optional highlight box summarizing the job in plain terms for a
// property owner/landlord who may not read the itemized table closely.
// Backed by the quote's own `notes` field (the one free-text field meant
// to travel with the document) rather than a new column - shown here
// instead of in the plain "Notes" section further down, which quotes skip
// in favour of this more prominent placement.
function renderJobSummary(cursor: Cursor, notes: string | null) {
  if (!notes) return;
  const lines = cursor.doc.splitTextToSize(notes, CONTENT_WIDTH - 10) as string[];
  const boxHeight = 8 + lines.length * 4.6 + 4;
  cursor.ensureSpace(boxHeight + 4);
  cursor.doc.setFillColor(243, 244, 246);
  cursor.doc.setDrawColor(...CHARCOAL);
  cursor.doc.setLineWidth(0.4);
  cursor.doc.roundedRect(MARGIN, cursor.y - 4, CONTENT_WIDTH, boxHeight, 1.5, 1.5, "FD");
  cursor.doc.setLineWidth(0.2);
  cursor.bold("JOB SUMMARY", MARGIN + 5, 7.5, CHARCOAL_MUTED);
  cursor.y += 4;
  for (const line of lines) {
    cursor.text(line, MARGIN + 5, 9.5, CHARCOAL_DARK);
    cursor.y += 4.6;
  }
  cursor.y += 6;
}

const COL_DESC_WIDTH = CONTENT_WIDTH * 0.6;
const COL_QTY_WIDTH = CONTENT_WIDTH * 0.1;
const COL_RATE_WIDTH = CONTENT_WIDTH * 0.15;
const COL_DESC_X = MARGIN;
const COL_QTY_X = MARGIN + COL_DESC_WIDTH + COL_QTY_WIDTH;
const COL_RATE_X = COL_QTY_X + COL_RATE_WIDTH;
const COL_AMOUNT_X = PAGE_WIDTH - MARGIN;
const DESC_WRAP_WIDTH = COL_DESC_WIDTH - 2;

// A line item's description's first line is treated as a bold title (e.g.
// "RIDGE CAPPING RE-POINTING") with the rest as normal body text below it -
// there's no separate title column on the schema, so this splits on the
// first newline, which is how these are actually entered in practice.
function splitDescription(description: string): { title: string; body: string[] } {
  const parts = (description || "-").split("\n").filter((l) => l.trim().length > 0);
  if (parts.length === 0) return { title: "-", body: [] };
  return { title: parts[0] ?? "-", body: parts.slice(1) };
}

async function renderLineItemsTable(cursor: Cursor, accent: [number, number, number], lineItems: LineItemFormInput[]) {
  cursor.ensureSpace(12);
  cursor.doc.setFillColor(...accent);
  cursor.doc.rect(MARGIN, cursor.y - 4, CONTENT_WIDTH, 7, "F");
  cursor.doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(255, 255, 255);
  cursor.doc.text("Item & Description", COL_DESC_X + 2, cursor.y);
  cursor.doc.text("Qty", COL_QTY_X, cursor.y, { align: "right" });
  cursor.doc.text("Rate", COL_RATE_X, cursor.y, { align: "right" });
  cursor.doc.text("Amount", COL_AMOUNT_X, cursor.y, { align: "right" });
  cursor.y += 9;

  let lastBundleName: string | null = null;
  for (const item of lineItems) {
    // A bundle is purely a presentation grouping (see the migration's own
    // comment) - a heading band, same shape as the column header above but
    // muted, whenever the bundle changes. Consecutive items sharing a
    // bundle_name only get one heading, matching the desktop/mobile
    // LineItemSummary views.
    if (item.bundle_name && item.bundle_name !== lastBundleName) {
      cursor.ensureSpace(8);
      cursor.doc.setFillColor(243, 244, 246);
      cursor.doc.rect(MARGIN, cursor.y - 4, CONTENT_WIDTH, 6, "F");
      cursor.doc.setFont("helvetica", "bold").setFontSize(8).setTextColor(...CHARCOAL_MUTED);
      cursor.doc.text(item.bundle_name.toUpperCase(), COL_DESC_X + 2, cursor.y);
      cursor.y += 6;
    }
    lastBundleName = item.bundle_name || null;

    const excluded = !!item.is_optional && !item.is_included;
    const rowColor: [number, number, number] = excluded ? [156, 163, 175] : [55, 65, 81];
    const titleColor: [number, number, number] = excluded ? [156, 163, 175] : CHARCOAL_DARK;
    const { title, body } = splitDescription(item.description);
    const titleLines = cursor.doc.splitTextToSize(title, DESC_WRAP_WIDTH) as string[];
    const bodyLines = body.length > 0 ? (cursor.doc.splitTextToSize(body.join(" "), DESC_WRAP_WIDTH) as string[]) : [];
    const showWaived = item.waived_amount_cents > 0;
    const waivedLineCount = showWaived ? 1 : 0;
    const optionalTagLineCount = item.is_optional ? 1 : 0;
    const warrantyLines = item.warranty_text ? (cursor.doc.splitTextToSize(item.warranty_text, DESC_WRAP_WIDTH) as string[]) : [];

    let imageDataUrl: string | null = null;
    const IMAGE_H = 22;
    if (item.image_url) imageDataUrl = await fetchImageDataUrl(item.image_url);

    const textLineCount = titleLines.length + bodyLines.length + warrantyLines.length + waivedLineCount + optionalTagLineCount;
    cursor.ensureSpace(textLineCount * 4.5 + (imageDataUrl ? IMAGE_H + 2 : 0) + 4);
    const rowTop = cursor.y;
    cursor.doc.setFont("helvetica", "bold").setFontSize(9.5).setTextColor(...titleColor);
    titleLines.forEach((line, i) => cursor.doc.text(line, COL_DESC_X, rowTop + i * 4.5));
    let textY = rowTop + titleLines.length * 4.5;
    if (bodyLines.length > 0) {
      cursor.doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...rowColor);
      bodyLines.forEach((line, i) => cursor.doc.text(line, COL_DESC_X, textY + i * 4.5));
      textY += bodyLines.length * 4.5;
    }
    // warranty_text is the one itemized-rework field that's client-visible
    // by design (see the line_item_rework_schema migration) - printed
    // directly under the description, same placement as the HTML PDF path.
    if (warrantyLines.length > 0) {
      cursor.doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...CHARCOAL_MUTED);
      warrantyLines.forEach((line, i) => cursor.doc.text(line, COL_DESC_X, textY + i * 4.5));
      textY += warrantyLines.length * 4.5;
    }
    if (item.is_optional) {
      cursor.doc.setFont("helvetica", "bold").setFontSize(8).setTextColor(126, 34, 206);
      cursor.doc.text(excluded ? "Optional - not selected" : "Optional - included", COL_DESC_X, textY);
      textY += 4.5;
    }
    if (showWaived) {
      cursor.doc.setFont("helvetica", "bold").setFontSize(8).setTextColor(29, 78, 216);
      cursor.doc.text("Waived - Membership", COL_DESC_X, textY);
      textY += 4.5;
    }
    if (imageDataUrl) {
      try {
        addContainedImage(cursor.doc, imageDataUrl, COL_DESC_X, textY, 32, IMAGE_H);
      } catch {
        // Skip an unembeddable image rather than fail the whole PDF.
      }
    }
    cursor.doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...rowColor);
    cursor.doc.text(String(item.quantity) + (item.unit ? ` ${item.unit}` : ""), COL_QTY_X, rowTop, { align: "right" });
    cursor.doc.text(formatCentsAsAud(item.unit_price_cents), COL_RATE_X, rowTop, { align: "right" });
    cursor.doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(...titleColor);
    cursor.doc.text(excluded ? "-" : formatCentsAsAud(lineItemSubtotalCents(item)), COL_AMOUNT_X, rowTop, { align: "right" });
    // Draw the separator right at this row's own bottom edge, then leave a
    // clear gap before the next row's title starts - a 9pt font's ascent
    // is ~2.3mm, so a 3mm gap here left the next title's glyphs almost
    // touching the line; 5.5mm gives it real breathing room.
    const rowBottom = rowTop + Math.max(textLineCount * 4.5 + (imageDataUrl ? IMAGE_H + 2 : 0), 4.5);
    cursor.doc.setDrawColor(229, 231, 235);
    cursor.doc.line(MARGIN, rowBottom, PAGE_WIDTH - MARGIN, rowBottom);
    cursor.y = rowBottom + 5.5;
  }
  cursor.y += 3;
}

// NSW Lic #.../$ liability figures aren't persisted anywhere in the
// schema (and hardcoding a specific insured amount into generated code
// would silently go stale if it ever changes), so this badge leans on
// tenant.license_number - already a real, live field - rather than
// fabricating a dollar figure. The other two badges are generic
// trust-building copy, not tenant-specific claims.
function trustBadges(tenant: Tenant): { title: string; body: string }[] {
  return [
    { title: "Licensed & Insured", body: tenant.license_number ? `Lic #${tenant.license_number} - fully insured` : "Fully licensed & insured" },
    { title: "Photo Report Included", body: "Before & after completion photos provided" },
    { title: "Quality Guarantee", body: "Workmanship & materials backed by warranty" },
  ];
}

function trustBadgesHeight(): number {
  return 20;
}

function drawTrustBadges(cursor: Cursor, tenant: Tenant) {
  const badges = trustBadges(tenant);
  const gap = 4;
  const badgeWidth = (CONTENT_WIDTH - gap * 2) / 3;
  const top = cursor.y;
  badges.forEach((badge, i) => {
    const x = MARGIN + i * (badgeWidth + gap);
    cursor.doc.setFillColor(...YELLOW_TINT);
    cursor.doc.setDrawColor(...YELLOW);
    cursor.doc.setLineWidth(0.5);
    cursor.doc.roundedRect(x, top, badgeWidth, 16, 1.5, 1.5, "FD");
    cursor.doc.setLineWidth(0.2);
    cursor.doc.setFont("helvetica", "bold").setFontSize(8).setTextColor(...YELLOW_INK);
    cursor.doc.text(badge.title, x + badgeWidth / 2, top + 6, { align: "center" });
    const bodyLines = cursor.doc.splitTextToSize(badge.body, badgeWidth - 6) as string[];
    cursor.doc.setFont("helvetica", "normal").setFontSize(6.8).setTextColor(...CHARCOAL_MUTED);
    bodyLines.slice(0, 2).forEach((line, j) => cursor.doc.text(line, x + badgeWidth / 2, top + 10.5 + j * 3.3, { align: "center" }));
  });
  cursor.y = top + 16 + 6;
}

function totalsCardHeight(lineItems: LineItemFormInput[], balanceDueCents: number | null, membershipDiscountCents: number): number {
  const rowCount = 2 + (membershipDiscountCents > 0 ? 1 : 0) + 1 + (balanceDueCents !== null ? 1 : 0);
  return rowCount * 6.5 + 10;
}

// A single bordered card (rather than a bare label/value list) so the
// totals read as one unit rather than loose text - and, specifically,
// never splits across a page boundary on its own: callers compute this
// card's height up front and call ensureSpace once for the WHOLE following
// block (card + anything after it), rather than ensureSpace-ing only the
// first few rows - that gap is what let the grand total land alone on
// page 2 after a table that nearly filled page 1.
function renderTotalsCard(
  cursor: Cursor,
  accent: [number, number, number],
  lineItems: LineItemFormInput[],
  balanceDueCents: number | null,
  membershipDiscountCents: number,
  highlightGrandTotal: boolean
) {
  const totals = calculateDocumentTotals(lineItems);
  const cardWidth = 85;
  const cardX = PAGE_WIDTH - MARGIN - cardWidth;
  const height = totalsCardHeight(lineItems, balanceDueCents, membershipDiscountCents);
  const top = cursor.y;

  cursor.doc.setDrawColor(...accent);
  cursor.doc.setLineWidth(0.6);
  cursor.doc.roundedRect(cardX, top, cardWidth, height, 1.5, 1.5, "S");
  cursor.doc.setLineWidth(0.2);

  cursor.y = top + 7;
  const labelX = cardX + 5;
  const valueX = cardX + cardWidth - 5;
  const rows: [string, string, boolean][] = [
    ["Sub Total", formatCentsAsAud(totals.subtotal_cents), false],
    ["GST (10%)", formatCentsAsAud(totals.gst_cents), false],
  ];
  if (membershipDiscountCents > 0) rows.push(["Membership discount", `-${formatCentsAsAud(membershipDiscountCents)}`, false]);
  for (const [label, value] of rows) {
    cursor.text(label, labelX, 9.5, CHARCOAL_MUTED);
    cursor.text(value, valueX, 9.5, CHARCOAL_DARK, "right");
    cursor.y += 6.5;
  }

  const grandTotalLabel = balanceDueCents !== null ? "Total" : "Grand Total";
  const grandTotalValue = formatCentsAsAud(totals.total_cents - membershipDiscountCents);
  if (highlightGrandTotal) {
    cursor.doc.setFillColor(...YELLOW);
    cursor.doc.rect(cardX + 1, cursor.y - 4.6, cardWidth - 2, 9, "F");
    cursor.bold(grandTotalLabel, labelX, 11, YELLOW_INK);
    cursor.bold(grandTotalValue, valueX, 11, YELLOW_INK, "right");
  } else {
    cursor.doc.setDrawColor(...accent);
    cursor.doc.line(labelX, cursor.y - 4, valueX, cursor.y - 4);
    cursor.bold(grandTotalLabel, labelX, 11, CHARCOAL_DARK);
    cursor.bold(grandTotalValue, valueX, 11, CHARCOAL_DARK, "right");
  }
  cursor.y += 7;

  if (balanceDueCents !== null) {
    cursor.text("Balance Due", labelX, 10, CHARCOAL_MUTED);
    cursor.bold(formatCentsAsAud(balanceDueCents), valueX, 11, CHARCOAL_DARK, "right");
    cursor.y += 6.5;
  }

  cursor.y = top + height + 6;
}

function renderNotes(cursor: Cursor, notes: string | null) {
  if (!notes) return;
  cursor.ensureSpace(12);
  cursor.bold("Notes", MARGIN, 9, CHARCOAL_MUTED);
  cursor.y += 5;
  const lines = cursor.doc.splitTextToSize(notes, CONTENT_WIDTH) as string[];
  for (const line of lines) {
    cursor.ensureSpace(5);
    cursor.text(line, MARGIN, 9);
    cursor.y += 4.5;
  }
  cursor.y += 4;
}

function renderFinePrint(cursor: Cursor, finePrintText: string | null) {
  if (!finePrintText) return;
  cursor.ensureSpace(12);
  cursor.bold("Fine Print", MARGIN, 9, CHARCOAL_MUTED);
  cursor.y += 5;
  const lines = cursor.doc.splitTextToSize(finePrintText, CONTENT_WIDTH) as string[];
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
  cursor.bold("Bank Details", MARGIN, 9, CHARCOAL_MUTED);
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
  cursor.bold("Accepted", MARGIN, 9, CHARCOAL_MUTED);
  cursor.y += 5;
  try {
    addContainedImage(cursor.doc, svgData, MARGIN, cursor.y, 50, 22);
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

function signatureBlockHeight(): number {
  return 30;
}

// For a quote that hasn't been accepted yet, a signature image obviously
// doesn't exist - this draws the acceptance instruction + a blank
// sign-here line instead, so a printed/emailed quote always ends with a
// clear call to action rather than silently having nothing where the
// signature would otherwise go.
function drawUnsignedApprovalBlock(cursor: Cursor) {
  cursor.bold("Approve This Quote", MARGIN, 9.5, CHARCOAL_DARK);
  cursor.y += 5.5;
  cursor.text("To approve, reply to this email or sign below:", MARGIN, 9, CHARCOAL_MUTED);
  cursor.y += 10;
  cursor.doc.setDrawColor(...CHARCOAL_MUTED);
  cursor.doc.setLineWidth(0.3);
  cursor.doc.line(MARGIN, cursor.y, MARGIN + 70, cursor.y);
  cursor.doc.line(MARGIN + 90, cursor.y, MARGIN + 140, cursor.y);
  cursor.y += 4;
  cursor.text("Signature", MARGIN, 8, CHARCOAL_MUTED);
  cursor.text("Date", MARGIN + 90, 8, CHARCOAL_MUTED);
  cursor.y += 6;
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

  await renderHeader(cursor, tenant, ACCENT.quote, "QUOTE", quote.quote_number, null, [
    { label: "Issue Date", value: formatDate(quote.issue_date) },
    { label: "Expiry Date", value: formatDate(quote.expiry_date) },
  ]);
  renderBillToSiteAndDates(cursor, client, site ?? null, null);
  renderJobSummary(cursor, quote.notes);
  await renderLineItemsTable(cursor, ACCENT.quote, lineItems);

  // Trust badges + totals card + approval/signature block are treated as
  // ONE unit for pagination: a single ensureSpace covering everything that
  // must stay together, then no further page-break checks until it's all
  // drawn - this is what stops the grand total from landing alone on a
  // second page while everything above it fit on the first.
  const isAccepted = quote.approval_status === "accepted" && !!quote.accepted_signature_svg;
  const trailingHeight =
    trustBadgesHeight() +
    6 +
    totalsCardHeight(lineItems, null, quote.membership_discount_cents) +
    6 +
    (isAccepted ? signatureBlockHeight() : 24) +
    (quote.fine_print_text ? 12 : 0);
  cursor.ensureSpace(trailingHeight);

  drawTrustBadges(cursor, tenant);
  renderTotalsCard(cursor, ACCENT.quote, lineItems, null, quote.membership_discount_cents, true);
  if (isAccepted) {
    await renderSignature(cursor, quote.accepted_by_name, quote.accepted_at, quote.accepted_signature_svg);
  } else {
    drawUnsignedApprovalBlock(cursor);
  }
  renderFinePrint(cursor, quote.fine_print_text);

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
  const billToOverride = agencyBilling
    ? {
        name: agencyBilling.billToLandlord
          ? (agencyBilling.ownerLandlordName ?? client.name)
          : `${agencyBilling.ownerLandlordName ?? client.name} c/- ${agencyBilling.agencyName}`,
        contact: agencyBilling.billToLandlord
          ? { phone: agencyBilling.ownerLandlordPhone ?? null, email: agencyBilling.ownerLandlordEmail ?? null }
          : { phone: client.phone, email: client.email },
      }
    : null;

  await renderHeader(cursor, tenant, ACCENT.invoice, "INVOICE", invoice.invoice_number, balanceDueCents, []);
  renderBillToSiteAndDates(cursor, client, site ?? null, billToOverride);
  renderDatesRow(cursor, [
    { label: "Invoice date", value: formatDate(invoice.issue_date) },
    { label: "Terms", value: invoice.due_date ? `Due ${formatDate(invoice.due_date)}` : "Due on receipt" },
    { label: "Due date", value: formatDate(invoice.due_date) },
  ]);
  await renderLineItemsTable(cursor, ACCENT.invoice, lineItems);

  const isAccepted = invoice.approval_status === "accepted" && !!invoice.accepted_signature_svg;
  const trailingHeight =
    totalsCardHeight(lineItems, balanceDueCents, invoice.membership_discount_cents) + 6 + (isAccepted ? signatureBlockHeight() : 0);
  cursor.ensureSpace(trailingHeight);
  renderTotalsCard(cursor, ACCENT.invoice, lineItems, balanceDueCents, invoice.membership_discount_cents, false);
  if (isAccepted) await renderSignature(cursor, invoice.accepted_by_name, invoice.accepted_at, invoice.accepted_signature_svg);

  renderNotes(cursor, invoice.notes);
  renderFinePrint(cursor, invoice.fine_print_text);
  renderBankDetails(cursor, tenant);

  return doc.output("blob");
}

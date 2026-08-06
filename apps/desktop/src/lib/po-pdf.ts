import { jsPDF } from "jspdf";
import { formatCentsAsAud, type PoLineItemInput, type PurchaseOrder, type SubcontractorCompany, type Tenant } from "@jmssaas/shared";

// Compiles a purchase_orders row into a branded PDF for the "Send Work
// Order" action - same jsPDF-direct-to-Blob approach as report-pdf.ts's
// buildReportPdfBlob (see that file's own comment for why: this needs real
// PDF bytes to upload+email unattended, not the browser "Print to PDF"
// dialog quote-invoice-pdf.ts/print.ts use for a human-triggered export).

const PAGE_WIDTH = 210; // A4 mm
const MARGIN = 15;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

export function buildPurchaseOrderPdfBlob(params: {
  tenant: Tenant;
  po: PurchaseOrder;
  subcontractor: SubcontractorCompany;
  jobTitle: string;
  siteAddress: string | null;
  lineItems: PoLineItemInput[];
}): Blob {
  const { tenant, po, subcontractor, jobTitle, siteAddress, lineItems } = params;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = MARGIN;

  doc.setFont("helvetica", "bold").setFontSize(16).setTextColor(30, 41, 59);
  doc.text(tenant.name, MARGIN, y);
  y += 10;

  doc.setFont("helvetica", "bold").setFontSize(13);
  doc.text(po.is_quote_request ? "Quote Request" : "Purchase Order", MARGIN, y);
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(75, 85, 99);
  doc.text(po.po_number ?? "Pending", PAGE_WIDTH - MARGIN, y, { align: "right" });
  y += 8;

  doc.setDrawColor(226, 232, 240);
  doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y += 6;

  doc.setFontSize(10).setTextColor(55, 65, 81);
  doc.text(`To: ${subcontractor.company_name}`, MARGIN, y);
  y += 5;
  doc.text(`Job: ${jobTitle}`, MARGIN, y);
  y += 5;
  if (siteAddress) {
    doc.text(`Site address: ${siteAddress}`, MARGIN, y);
    y += 5;
  }
  y += 4;

  doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(107, 114, 128);
  doc.text("Description", MARGIN, y);
  doc.text("Qty", MARGIN + CONTENT_WIDTH - 60, y, { align: "right" });
  doc.text("Unit cost", MARGIN + CONTENT_WIDTH - 30, y, { align: "right" });
  doc.text("Amount", MARGIN + CONTENT_WIDTH, y, { align: "right" });
  y += 3;
  doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y += 5;

  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(31, 41, 55);
  for (const item of lineItems) {
    const descLines = doc.splitTextToSize(item.description, CONTENT_WIDTH - 65) as string[];
    for (const [i, line] of descLines.entries()) {
      if (y > 270) {
        doc.addPage();
        y = MARGIN;
      }
      doc.text(line, MARGIN, y);
      if (i === 0) {
        doc.text(String(item.quantity), MARGIN + CONTENT_WIDTH - 60, y, { align: "right" });
        doc.text(formatCentsAsAud(item.unit_cost_cents), MARGIN + CONTENT_WIDTH - 30, y, { align: "right" });
        doc.text(formatCentsAsAud(Math.round(item.quantity * item.unit_cost_cents)), MARGIN + CONTENT_WIDTH, y, { align: "right" });
      }
      y += 5;
    }
  }

  y += 2;
  doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y += 7;
  doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(17, 24, 39);
  doc.text("Total", MARGIN + CONTENT_WIDTH - 30, y, { align: "right" });
  doc.text(formatCentsAsAud(po.total_cost_cents), MARGIN + CONTENT_WIDTH, y, { align: "right" });

  return doc.output("blob");
}

import { decode as decodeBase64 } from "base64-arraybuffer";
import { v4 as uuidv4 } from "uuid";
import { formatCentsAsAud, type PoLineItemInput, type PurchaseOrder, type SubcontractorCompany, type Tenant } from "@jmssaas/shared";
import { escapeHtml } from "./pdf";
import { supabase } from "./supabase";

// Compiles a purchase_orders row to HTML for expo-print, the same
// HTML+expo-print pipeline lib/pdf.ts/lib/print.ts already use for quote/
// invoice PDFs (and lib/report-pdf.ts for report PDFs) - rather than
// porting desktop's jsPDF-based po-pdf.ts, since that pipeline is already
// built and this needs no server dependency either way.

const BUCKET = "subcontractor-files";

export async function uploadComplianceDoc(params: {
  tenantId: string;
  subcontractorId: string;
  base64: string;
  extension: string;
  contentType?: string;
}): Promise<string> {
  const id = uuidv4();
  const storagePath = `${params.tenantId}/${params.subcontractorId}/${id}.${params.extension}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, decodeBase64(params.base64), { contentType: params.contentType });
  if (error) throw error;
  return storagePath;
}

const PO_PDF_STYLES = `
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #111827; margin: 0; padding: 40px; font-size: 12px; }
  .company-name { font-size: 18px; font-weight: 700; color: #1e293b; margin: 0 0 6px; }
  .doc-header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 8px; }
  .doc-title { font-size: 14px; font-weight: 700; margin: 0; }
  .doc-number { font-size: 11px; color: #4b5563; }
  .meta { font-size: 11px; color: #374151; margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; color: #6b7280; padding: 6px 4px; border-bottom: 1px solid #e2e8f0; }
  th.num, td.num { text-align: right; }
  td { padding: 6px 4px; border-bottom: 1px solid #f1f5f9; font-size: 11px; vertical-align: top; white-space: pre-wrap; }
  .total-row td { border-top: 2px solid #111827; border-bottom: none; font-weight: 700; font-size: 13px; padding-top: 10px; }
`;

export function buildPurchaseOrderPdfHtml(params: {
  tenant: Tenant;
  po: PurchaseOrder;
  subcontractor: SubcontractorCompany;
  jobTitle: string;
  siteAddress: string | null;
  lineItems: PoLineItemInput[];
}): string {
  const { tenant, po, subcontractor, jobTitle, siteAddress, lineItems } = params;
  const rows = lineItems
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(item.description)}</td>
        <td class="num">${item.quantity}</td>
        <td class="num">${formatCentsAsAud(item.unit_cost_cents)}</td>
        <td class="num">${formatCentsAsAud(Math.round(item.quantity * item.unit_cost_cents))}</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>${PO_PDF_STYLES}</style>
  </head>
  <body>
    <p class="company-name">${escapeHtml(tenant.name)}</p>
    <div class="doc-header">
      <p class="doc-title">${po.is_quote_request ? "Quote Request" : "Purchase Order"}</p>
      <p class="doc-number">${escapeHtml(po.po_number ?? "Pending")}</p>
    </div>
    <p class="meta">To: ${escapeHtml(subcontractor.company_name)}</p>
    <p class="meta">Job: ${escapeHtml(jobTitle)}</p>
    ${siteAddress ? `<p class="meta">Site address: ${escapeHtml(siteAddress)}</p>` : ""}
    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th class="num" style="width: 60px;">Qty</th>
          <th class="num" style="width: 90px;">Unit cost</th>
          <th class="num" style="width: 90px;">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="total-row">
          <td colspan="3">Total</td>
          <td class="num">${formatCentsAsAud(po.total_cost_cents)}</td>
        </tr>
      </tfoot>
    </table>
  </body>
</html>`;
}

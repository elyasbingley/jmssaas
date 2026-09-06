import type { JobCard, MaterialOrderLineItem, Tenant } from "@jmssaas/shared";
import { escapeHtml } from "./pdf";

// Job-specific material order requisition PDF (mobile) - same escape/
// company-block pattern as desktop's material-order-pdf.ts, duplicated
// per-app rather than shared (see lib/pdf.ts's own header comment on why
// desktop and mobile don't cross-import lib/ files).

const ACCENT = "#1f2937";

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
  .doc-title { font-size: 30px; margin: 0; }
  .doc-number { font-weight: 700; font-size: 13px; margin-top: 4px; color: #111827; }
  .company-block { margin-top: 28px; }
  .company-name { font-size: 14px; font-weight: 700; margin: 0 0 4px; }
  .company-detail { color: #374151; font-size: 11px; line-height: 1.5; margin: 0; }
  .meta-row { display: flex; gap: 32px; margin-top: 20px; }
  .meta-label { font-size: 10px; text-transform: uppercase; color: #6b7280; margin: 0; }
  .meta-value { font-size: 13px; font-weight: 600; margin: 2px 0 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th { text-align: left; font-size: 11px; color: #fff; padding: 8px; }
  th.num, td.num { text-align: right; }
  td { padding: 8px; border-bottom: 1px solid #e5e7eb; font-size: 12px; vertical-align: top; }
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
      ${tenant.phone ? `<p class="company-detail">${escapeHtml(tenant.phone)}</p>` : ""}
      ${tenant.email ? `<p class="company-detail">${escapeHtml(tenant.email)}</p>` : ""}
    </div>
  `;
}

export function buildMaterialOrderPdfHtml(params: {
  tenant: Tenant;
  job: JobCard;
  orderNumber: string;
  supplierName: string | null;
  deliveryDate: string | null;
  lineItems: MaterialOrderLineItem[];
}): string {
  const { tenant, job, orderNumber, supplierName, deliveryDate, lineItems } = params;
  const rows = lineItems
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(item.item_name)}</td>
        <td class="num">${item.quantity}</td>
        <td>${escapeHtml(item.unit_type)}</td>
        <td>${escapeHtml(item.notes)}</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Material Order ${escapeHtml(orderNumber)}</title>
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    <div class="header">
      <div>${tenant.logo_url ? `<img class="logo" src="${escapeHtml(tenant.logo_url)}" />` : ""}</div>
      <div class="doc-block">
        <p class="doc-title" style="color: ${ACCENT}; font-weight: 700; text-transform: uppercase;">Material Order</p>
        <p class="doc-number">${escapeHtml(orderNumber)}</p>
      </div>
    </div>
    ${renderCompanyBlock(tenant)}

    <div class="meta-row">
      <div>
        <p class="meta-label">Job</p>
        <p class="meta-value">${escapeHtml(job.title)}${job.number ? ` (${escapeHtml(job.number)})` : ""}</p>
      </div>
      ${supplierName ? `<div><p class="meta-label">Supplier</p><p class="meta-value">${escapeHtml(supplierName)}</p></div>` : ""}
      ${deliveryDate ? `<div><p class="meta-label">Delivery date</p><p class="meta-value">${escapeHtml(deliveryDate)}</p></div>` : ""}
    </div>

    <table>
      <thead>
        <tr style="background: ${ACCENT};">
          <th>Item</th>
          <th class="num" style="width: 70px;">Qty</th>
          <th style="width: 80px;">Unit</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </body>
</html>`;
}

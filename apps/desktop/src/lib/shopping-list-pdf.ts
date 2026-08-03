import type { LowStockItem, Tenant } from "@jmssaas/shared";

// Ported from apps/mobile/lib/pdf.ts's buildShoppingListPdfHtml/
// renderShoppingListTable, scoped to just the shopping list (desktop has
// no quote/invoice PDF export at all yet, so the rest of that file's
// quote/invoice-specific rendering isn't needed here). Duplicated rather
// than shared - same reasoning as lib/errors.ts: tiny, app-specific, and
// this app has no other dependency on mobile's lib/ directory.

const ACCENT = "#1f2937";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  .company-block { margin-top: 28px; }
  .company-name { font-size: 14px; font-weight: 700; margin: 0 0 4px; }
  .company-detail { color: #374151; font-size: 11px; line-height: 1.5; margin: 0; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { text-align: left; font-size: 11px; color: #fff; padding: 8px; }
  th.num, td.num { text-align: right; }
  td { padding: 8px; border-bottom: 1px solid #e5e7eb; font-size: 12px; vertical-align: top; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6b7280; margin: 20px 0 6px; }
  .section-body { font-size: 11px; color: #374151; line-height: 1.6; white-space: pre-wrap; }
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

// Reorder quantity isn't a stored column - just enough to bring the
// location back up to the item's own ideal_stock target, minimum 1.
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
        <tr style="background: ${ACCENT};">
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

// Groups by location - one heading + table per inventory_locations row.
// `items` is expected to already be scoped to whatever the caller wants
// (e.g. the Low Stock tab's supplier filter) - this function only renders.
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
    <title>Shopping List</title>
    <style>${BASE_STYLES}</style>
  </head>
  <body>
    <div class="header">
      <div>${tenant.logo_url ? `<img class="logo" src="${escapeHtml(tenant.logo_url)}" />` : ""}</div>
      <div class="doc-block">
        <p class="doc-title" style="color: ${ACCENT}; font-weight: 700; text-transform: uppercase;">Shopping List</p>
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

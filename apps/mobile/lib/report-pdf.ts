import { decode as decodeBase64, encode as encodeBase64 } from "base64-arraybuffer";
import { v4 as uuidv4 } from "uuid";
import {
  RISK_CONSEQUENCE_LABELS,
  RISK_LIKELIHOOD_LABELS,
  RISK_RATING_LABELS,
  type ReportAnswer,
  type ReportFormData,
  type ReportGeoLocation,
  type ReportInstance,
  type ReportSectionDefinition,
  type ReportSignature,
  type ReportStructureSchema,
  type ReportTemplate,
  type Tenant,
} from "@jmssaas/shared";
import { escapeHtml } from "./pdf";
import { supabase } from "./supabase";

// Report photos/action-fail photos are stored as object paths in the
// "report-files" bucket (report_instances.form_data's photoPaths), same
// convention as desktop - uploaded eagerly at capture time via
// uploadReportPhoto below, then resolved back to a data URI here only when
// compiling the PDF (never stored as a URL). Signature answers are the one
// exception: SignaturePad already hands back a data URI directly, so those
// go straight into form_data with no separate upload step.
const REPORT_FILES_BUCKET = "report-files";

export async function uploadReportPhoto(params: {
  tenantId: string;
  reportInstanceId: string;
  base64: string;
  extension: string;
  contentType?: string;
}): Promise<string> {
  const id = uuidv4();
  const storagePath = `${params.tenantId}/${params.reportInstanceId}/${id}.${params.extension}`;
  const { error } = await supabase.storage
    .from(REPORT_FILES_BUCKET)
    .upload(storagePath, decodeBase64(params.base64), { contentType: params.contentType });
  if (error) throw error;
  return storagePath;
}

async function loadImageDataUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(REPORT_FILES_BUCKET).download(path);
  if (error || !data) return null;
  const buffer = await data.arrayBuffer();
  const mime = data.type || "image/jpeg";
  return `data:${mime};base64,${encodeBase64(buffer)}`;
}

function answerSummary(answer: ReportAnswer | undefined): string {
  if (!answer) return "Not answered";
  switch (answer.type) {
    case "pass_fail":
      return answer.value.toUpperCase();
    case "risk_matrix": {
      const count = answer.rows?.length ?? 0;
      return count === 0 ? "No hazards recorded" : `${count} hazard(s) recorded`;
    }
    case "text":
    case "long_text":
    case "meter_reading":
      return answer.value || "-";
    case "photo":
      return `${answer.photoPaths.length} photo(s) attached`;
    case "signature":
      return `Signed by ${answer.signerName}`;
  }
}

const RATING_COLOR: Record<string, string> = {
  low: "#15803d",
  medium: "#b45309",
  high: "#b91c1c",
  extreme: "#b91c1c",
};

async function renderField(field: { id: string; label: string }, answer: ReportAnswer | undefined): Promise<string> {
  const label = `<div class="field-label">${escapeHtml(field.label || "(unlabelled field)")}</div>`;

  if (answer?.type === "pass_fail") {
    const color = answer.value === "fail" ? "#b91c1c" : answer.value === "pass" ? "#15803d" : "#6b7280";
    let html = `${label}<div class="field-value" style="color:${color};">${escapeHtml(answerSummary(answer))}</div>`;
    if (answer.value === "fail" && answer.actionNote) {
      html += `<div class="field-sub">Action required: ${escapeHtml(answer.actionNote)}</div>`;
    }
    if (answer.value === "fail" && answer.actionPhotoPaths?.length) {
      for (const path of answer.actionPhotoPaths) {
        const dataUrl = await loadImageDataUrl(path);
        if (dataUrl) html += `<img class="field-photo" src="${dataUrl}" />`;
      }
    }
    return html;
  }

  if (answer?.type === "risk_matrix") {
    const rows = answer.rows ?? [];
    if (rows.length === 0) return `${label}<div class="field-sub">No hazards recorded</div>`;
    const rowsHtml = rows
      .map(
        (row) => `
        <div class="hazard-row">
          <div class="field-value">${escapeHtml(row.hazard || "(hazard not described)")}</div>
          <div class="field-sub" style="color:${RATING_COLOR[row.rating]};">
            ${escapeHtml(RISK_LIKELIHOOD_LABELS[row.likelihood])} x ${escapeHtml(RISK_CONSEQUENCE_LABELS[row.consequence])} = ${escapeHtml(RISK_RATING_LABELS[row.rating])} risk
          </div>
          ${row.controlMeasures ? `<div class="field-sub">Control measures: ${escapeHtml(row.controlMeasures)}</div>` : ""}
        </div>`
      )
      .join("");
    return `${label}${rowsHtml}`;
  }

  if (answer?.type === "photo") {
    let html = `${label}<div class="field-sub">${escapeHtml(answerSummary(answer))}</div>`;
    for (const path of answer.photoPaths) {
      const dataUrl = await loadImageDataUrl(path);
      if (dataUrl) html += `<img class="field-photo" src="${dataUrl}" />`;
    }
    return html;
  }

  if (answer?.type === "signature") {
    let html = `${label}<div class="field-sub">Signed by: ${escapeHtml(answer.signerName || "-")}</div>`;
    if (answer.svgData) html += `<img class="field-photo signature" src="${answer.svgData}" />`;
    return html;
  }

  return `${label}<div class="field-sub">${escapeHtml(answerSummary(answer))}</div>`;
}

async function renderSection(section: ReportSectionDefinition, formData: ReportFormData): Promise<string> {
  const fieldsHtml = (await Promise.all(section.fields.map((field) => renderField(field, formData[field.id])))).join("");
  return `
    <div class="section">
      <div class="section-title">${escapeHtml(section.title || "Untitled section")}</div>
      ${fieldsHtml}
    </div>
  `;
}

const REPORT_STYLES = `
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #111827; margin: 0; padding: 40px; font-size: 12px; }
  .doc-title { font-size: 24px; font-weight: 700; margin: 0; }
  .doc-subtitle { color: #4b5563; font-size: 13px; margin-top: 4px; }
  .doc-meta { color: #9ca3af; font-size: 10px; margin-top: 8px; }
  .section { border-top: 1px solid #e2e8f0; padding-top: 12px; margin-top: 16px; }
  .section-title { font-size: 14px; font-weight: 700; color: #1e293b; margin-bottom: 8px; }
  .field-label { font-size: 11px; font-weight: 700; color: #111827; margin-top: 8px; }
  .field-value { font-size: 11px; margin-top: 2px; }
  .field-sub { font-size: 10px; color: #6b7280; margin-top: 2px; }
  .field-photo { max-width: 200px; max-height: 150px; display: block; margin-top: 6px; border-radius: 4px; }
  .field-photo.signature { max-width: 160px; max-height: 80px; }
  .hazard-row { margin-top: 4px; padding-left: 8px; border-left: 2px solid #e2e8f0; }
  .roster-row { font-size: 11px; margin-top: 10px; }
`;

export async function buildReportPdfHtml(params: {
  tenant: Tenant;
  template: ReportTemplate;
  instance: ReportInstance;
  signatures: ReportSignature[];
}): Promise<string> {
  const { tenant, template, instance, signatures } = params;
  const structure = template.structure_schema as ReportStructureSchema;
  const sectionsHtml = (await Promise.all(structure.map((section) => renderSection(section, instance.form_data)))).join("");

  let rosterHtml = "";
  if (template.is_swms && signatures.length > 0) {
    const rows = signatures
      .map(
        (sig) => `
        <div class="roster-row">
          <div class="field-value">${escapeHtml(sig.signer_name)} (${escapeHtml(sig.signer_role.replace("_", " "))}) - ${escapeHtml(new Date(sig.signed_at).toLocaleString("en-AU"))}</div>
          ${sig.signature_svg_data ? `<img class="field-photo signature" src="${sig.signature_svg_data}" />` : ""}
        </div>`
      )
      .join("");
    rosterHtml = `<div class="section"><div class="section-title">Worker Sign-Off Roster</div>${rows}</div>`;
  }

  const geo = instance.geo_location as ReportGeoLocation | null;

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>${REPORT_STYLES}</style>
  </head>
  <body>
    <p class="doc-title">${escapeHtml(tenant.name)}</p>
    <p class="doc-subtitle">${escapeHtml(template.title)}</p>
    <p class="doc-meta">Completed: ${escapeHtml(instance.completed_at ? new Date(instance.completed_at).toLocaleString("en-AU") : "In progress")}</p>
    ${geo ? `<p class="doc-meta">Location: ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}</p>` : ""}
    ${sectionsHtml}
    ${rosterHtml}
  </body>
</html>`;
}

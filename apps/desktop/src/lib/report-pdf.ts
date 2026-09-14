import { jsPDF } from "jspdf";
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
import { supabase } from "./supabase";

// Compiles a completed report_instance into a branded PDF (Workflow 4).
// Unlike quote/invoice PDFs (buildQuotePdfHtml + the browser's own "Print
// to PDF" dialog - see print.ts), this needs actual PDF bytes with no user
// interaction in the loop: the whole point is "auto-compile... store in
// cloud storage... auto-attach to the job" with nothing for a human to
// click through. jsPDF (client-side, no server dependency) generates a
// real Blob that gets uploaded directly to Supabase Storage - the only
// place in this app that produces a PDF this way; every other PDF export
// stays a manual "open a new tab and print" because those are always a
// deliberate save-this-now user action, not a system-triggered compile.

const PAGE_WIDTH = 210; // A4 mm
const PAGE_HEIGHT = 297;
const MARGIN = 15;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

async function loadImageDataUrl(bucket: string, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) return null;
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(data);
  });
}

class PdfCursor {
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

  heading(text: string, size = 14) {
    this.ensureSpace(10);
    this.doc.setFont("helvetica", "bold").setFontSize(size).setTextColor(30, 41, 59);
    this.doc.text(text, MARGIN, this.y);
    this.y += size * 0.6;
  }

  text(text: string, size = 10, color: [number, number, number] = [55, 65, 81]) {
    this.doc.setFont("helvetica", "normal").setFontSize(size).setTextColor(...color);
    const lines = this.doc.splitTextToSize(text, CONTENT_WIDTH) as string[];
    for (const line of lines) {
      this.ensureSpace(size * 0.5);
      this.doc.text(line, MARGIN, this.y);
      this.y += size * 0.5;
    }
  }

  gap(amount = 4) {
    this.y += amount;
  }

  rule() {
    this.ensureSpace(4);
    this.doc.setDrawColor(226, 232, 240);
    this.doc.line(MARGIN, this.y, PAGE_WIDTH - MARGIN, this.y);
    this.y += 4;
  }

  async image(dataUrl: string, maxWidth = 80, maxHeight = 60) {
    this.ensureSpace(maxHeight + 4);
    try {
      this.doc.addImage(dataUrl, "JPEG", MARGIN, this.y, maxWidth, maxHeight, undefined, "MEDIUM");
    } catch {
      // Some browsers/data URIs (PNG signatures, unsupported formats)
      // reject the "JPEG" hint - retry as PNG rather than failing the
      // whole compile over one bad image.
      try {
        this.doc.addImage(dataUrl, "PNG", MARGIN, this.y, maxWidth, maxHeight, undefined, "MEDIUM");
      } catch {
        this.text("[Photo could not be embedded]", 9, [156, 163, 175]);
        return;
      }
    }
    this.y += maxHeight + 4;
  }
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

async function renderSection(cursor: PdfCursor, section: ReportSectionDefinition, formData: ReportFormData, bucket: string) {
  cursor.rule();
  cursor.heading(section.title || "Untitled section", 12);
  cursor.gap(2);

  for (const field of section.fields) {
    const answer = formData[field.id];
    cursor.ensureSpace(8);
    cursor.text(field.label || "(unlabelled field)", 10, [17, 24, 39]);

    if (answer?.type === "pass_fail") {
      const color: [number, number, number] = answer.value === "fail" ? [185, 28, 28] : answer.value === "pass" ? [21, 128, 61] : [107, 114, 128];
      cursor.text(answerSummary(answer), 10, color);
      if (answer.value === "fail" && answer.actionNote) {
        cursor.text(`Action required: ${answer.actionNote}`, 9, [107, 114, 128]);
      }
      if (answer.value === "fail" && answer.actionPhotoPaths?.length) {
        for (const path of answer.actionPhotoPaths) {
          const dataUrl = await loadImageDataUrl(bucket, path);
          if (dataUrl) await cursor.image(dataUrl);
        }
      }
    } else if (answer?.type === "risk_matrix") {
      // `?? []` covers report_instances saved before this field became a
      // hazard register (see reports.ts's RiskMatrixAnswer comment) - a row
      // with no `rows` array at all just renders as no hazards recorded,
      // rather than throwing on a completed report from before this change.
      const rows = answer.rows ?? [];
      if (rows.length === 0) {
        cursor.text("No hazards recorded", 9, [107, 114, 128]);
      }
      for (const row of rows) {
        cursor.gap(1);
        cursor.ensureSpace(20);
        cursor.text(row.hazard || "(hazard not described)", 9, [17, 24, 39]);
        const ratingColor: [number, number, number] =
          row.rating === "extreme" || row.rating === "high" ? [185, 28, 28] : row.rating === "medium" ? [180, 83, 9] : [21, 128, 61];
        cursor.text(
          `${RISK_LIKELIHOOD_LABELS[row.likelihood]} x ${RISK_CONSEQUENCE_LABELS[row.consequence]} = ${RISK_RATING_LABELS[row.rating]} risk`,
          9,
          ratingColor
        );
        if (row.controlMeasures) cursor.text(`Control measures: ${row.controlMeasures}`, 9, [107, 114, 128]);
      }
    } else if (answer?.type === "photo") {
      cursor.text(answerSummary(answer), 9, [107, 114, 128]);
      for (const path of answer.photoPaths) {
        const dataUrl = await loadImageDataUrl(bucket, path);
        if (dataUrl) await cursor.image(dataUrl);
      }
    } else if (answer?.type === "signature") {
      cursor.text(`Signed by: ${answer.signerName || "-"}`, 9, [107, 114, 128]);
      if (answer.svgData) await cursor.image(answer.svgData, 60, 30);
    } else {
      cursor.text(answerSummary(answer), 9, [107, 114, 128]);
    }
    cursor.gap(3);
  }
}

export async function buildReportPdfBlob(params: {
  tenant: Tenant;
  template: ReportTemplate;
  instance: ReportInstance;
  signatures: ReportSignature[];
  bucket: string;
}): Promise<Blob> {
  const { tenant, template, instance, signatures, bucket } = params;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const cursor = new PdfCursor(doc);

  cursor.heading(tenant.name, 16);
  cursor.text(template.title, 11, [75, 85, 99]);
  cursor.gap(2);
  cursor.text(`Completed: ${instance.completed_at ? new Date(instance.completed_at).toLocaleString("en-AU") : "In progress"}`, 9, [156, 163, 175]);
  if (instance.geo_location) {
    const geo = instance.geo_location as ReportGeoLocation;
    cursor.text(`Location: ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}`, 9, [156, 163, 175]);
  }
  cursor.gap(4);

  const structure = template.structure_schema as ReportStructureSchema;
  for (const section of structure) {
    await renderSection(cursor, section, instance.form_data, bucket);
  }

  if (template.is_swms && signatures.length > 0) {
    cursor.rule();
    cursor.heading("Worker Sign-Off Roster", 12);
    cursor.gap(2);
    for (const sig of signatures) {
      cursor.ensureSpace(30);
      cursor.text(`${sig.signer_name} (${sig.signer_role.replace("_", " ")}) - ${new Date(sig.signed_at).toLocaleString("en-AU")}`, 9, [55, 65, 81]);
      if (sig.signature_svg_data) await cursor.image(sig.signature_svg_data, 60, 25);
      cursor.gap(2);
    }
  }

  return doc.output("blob");
}

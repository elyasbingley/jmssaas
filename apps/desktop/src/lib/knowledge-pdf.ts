import { jsPDF } from "jspdf";
import type { KnowledgeArticle, KnowledgeBlock, Tenant } from "@jmssaas/shared";
import { supabase } from "./supabase";

// Compiles a knowledge_article into a standalone PDF for "Download PDF" /
// "Email PDF" - the spec's own "downloaded or emailed... for anyone to
// easily read and forward around" is why this has to be a real,
// self-contained file (images embedded as PDF content) rather than a link
// back into the app. Same jsPDF cursor approach as report-pdf.ts, copied
// rather than shared since that file already copies its own pattern
// verbatim from quote-invoice-pdf-bytes.ts - matching this codebase's
// existing convention of a small per-document-type PDF builder over one
// shared abstraction.

const PAGE_WIDTH = 210; // A4 mm
const PAGE_HEIGHT = 297;
const MARGIN = 15;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BUCKET = "knowledge-files";

async function loadImageDataUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
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

  async image(dataUrl: string, maxWidth = CONTENT_WIDTH, maxHeight = 90) {
    // Contain-fit into (maxWidth, maxHeight) preserving the source's own
    // aspect ratio - same reasoning as quote-invoice-pdf-bytes.ts's
    // addContainedImage (jsPDF's addImage stretches otherwise).
    let w = maxWidth;
    let h = maxHeight;
    try {
      const props = this.doc.getImageProperties(dataUrl);
      const scale = Math.min(maxWidth / props.width, maxHeight / props.height);
      w = props.width * scale;
      h = props.height * scale;
    } catch {
      // Fall through with the untouched maxWidth/maxHeight box below.
    }
    this.ensureSpace(h + 4);
    try {
      this.doc.addImage(dataUrl, "JPEG", MARGIN, this.y, w, h, undefined, "MEDIUM");
    } catch {
      try {
        this.doc.addImage(dataUrl, "PNG", MARGIN, this.y, w, h, undefined, "MEDIUM");
      } catch {
        this.text("[Image could not be embedded]", 9, [156, 163, 175]);
        return;
      }
    }
    this.y += h + 4;
  }
}

async function renderBlock(cursor: PdfCursor, block: KnowledgeBlock) {
  switch (block.type) {
    case "text":
      for (const paragraph of block.body.split("\n")) {
        if (paragraph.trim()) cursor.text(paragraph);
        cursor.gap(2);
      }
      break;
    case "image": {
      const dataUrl = await loadImageDataUrl(block.storagePath);
      if (dataUrl) await cursor.image(dataUrl);
      if (block.caption) cursor.text(block.caption, 9, [107, 114, 128]);
      cursor.gap(3);
      break;
    }
    case "video_embed":
      // No video playback in a PDF - a captioned link is the closest
      // useful equivalent, same idea as a signature answer rendering as
      // a static image rather than anything interactive.
      cursor.text(`▶ Watch video: ${block.url}`, 10, [29, 78, 216]);
      if (block.caption) cursor.text(block.caption, 9, [107, 114, 128]);
      cursor.gap(3);
      break;
  }
}

export async function buildKnowledgeArticlePdfBlob(params: { tenant: Tenant; article: KnowledgeArticle }): Promise<Blob> {
  const { tenant, article } = params;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const cursor = new PdfCursor(doc);

  cursor.heading(tenant.name, 16);
  cursor.text(article.title, 12, [17, 24, 39]);
  cursor.gap(2);
  cursor.rule();
  cursor.gap(2);

  for (const block of article.content_blocks) {
    await renderBlock(cursor, block);
  }

  return doc.output("blob");
}

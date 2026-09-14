import { encode as encodeBase64 } from "base64-arraybuffer";
import type { KnowledgeArticle, Tenant } from "@jmssaas/shared";
import { escapeHtml } from "./pdf";
import { supabase } from "./supabase";

// Mobile port of apps/desktop/src/lib/knowledge-pdf.ts - HTML string handed
// to expo-print (see lib/print.ts) rather than jsPDF, same split as every
// other PDF this app builds (quote/invoice/shopping-list here vs. desktop's
// own jsPDF versions) - report-pdf.ts's loadImageDataUrl pattern (download
// -> arrayBuffer -> base64 data URL) is copied verbatim below for the same
// reason: an embedded <img> needs a self-contained data URL, not a signed
// URL that could expire before the PDF is actually opened/forwarded.

const BUCKET = "knowledge-files";

async function loadImageDataUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  const buffer = await data.arrayBuffer();
  const mime = data.type || "image/jpeg";
  return `data:${mime};base64,${encodeBase64(buffer)}`;
}

export async function buildKnowledgeArticlePdfHtml(params: { tenant: Tenant; article: KnowledgeArticle }): Promise<string> {
  const { tenant, article } = params;

  const blockHtml = await Promise.all(
    article.content_blocks.map(async (block) => {
      if (block.type === "text") {
        const paragraphs = block.body
          .split("\n")
          .filter((p) => p.trim())
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join("");
        return `<div class="block">${paragraphs}</div>`;
      }
      if (block.type === "image") {
        const dataUrl = block.storagePath ? await loadImageDataUrl(block.storagePath) : null;
        const img = dataUrl ? `<img src="${dataUrl}" />` : `<p class="muted">[Image could not be embedded]</p>`;
        const caption = block.caption ? `<p class="caption">${escapeHtml(block.caption)}</p>` : "";
        return `<div class="block">${img}${caption}</div>`;
      }
      // video_embed - no playback in a static PDF, a captioned link is the
      // closest useful equivalent (same idea as desktop's own PDF builder).
      const caption = block.caption ? `<p class="caption">${escapeHtml(block.caption)}</p>` : "";
      return `<div class="block"><p class="video-link">&#9654; Watch video: ${escapeHtml(block.url)}</p>${caption}</div>`;
    })
  );

  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: Helvetica, Arial, sans-serif; color: #1f2937; padding: 24px; }
          h1 { font-size: 20px; margin: 0 0 4px; }
          h2 { font-size: 15px; color: #6b7280; margin: 0 0 16px; font-weight: 600; }
          hr { border: none; border-top: 1px solid #e5e7eb; margin: 12px 0 20px; }
          .block { margin-bottom: 14px; }
          .block p { font-size: 12px; line-height: 1.5; margin: 0 0 6px; }
          .block img { max-width: 100%; max-height: 320px; object-fit: contain; }
          .caption, .muted { font-size: 10px; color: #6b7280; }
          .video-link { color: #1d4ed8; font-weight: 600; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(tenant.name)}</h1>
        <h2>${escapeHtml(article.title)}</h2>
        <hr />
        ${blockHtml.join("")}
      </body>
    </html>
  `;
}

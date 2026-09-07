// Knowledge base - the shape of knowledge_articles.content_blocks (a
// jsonb array built/edited by the block editor UI, same "no fixed columns
// for an editor's content" tradeoff ReportStructureSchema and
// PropertyAssetAttributes already make). Neither Postgres nor the outer
// zod schema (see schemas.ts) validates each block's internal shape
// beyond its own required fields - the editor UI only ever constructs one
// of these three variants.
//
// Video is embed-only (a pasted YouTube/Vimeo/Loom URL) rather than an
// uploaded file - see the knowledge_base migration's own comment on why.
// A PDF export renders a video block as a captioned link line (jsPDF
// can't play video), same idea as a photo answer rendering as an
// embedded image - see knowledge-pdf.ts.

export type KnowledgeBlockType = "text" | "image" | "video_embed";

export interface KnowledgeTextBlock {
  id: string;
  type: "text";
  body: string;
}

// storagePath is a path within the "knowledge-files" bucket (not a full
// URL), same convention as JobFile.storage_path - resolved to a signed
// URL for in-app viewing, or embedded as PDF content directly, never
// stored as a URL.
export interface KnowledgeImageBlock {
  id: string;
  type: "image";
  storagePath: string;
  caption?: string;
}

export interface KnowledgeVideoEmbedBlock {
  id: string;
  type: "video_embed";
  url: string;
  caption?: string;
}

export type KnowledgeBlock = KnowledgeTextBlock | KnowledgeImageBlock | KnowledgeVideoEmbedBlock;

// Recognises the common share-link shapes for YouTube/Vimeo/Loom and
// returns an embeddable player URL - used by the desktop/mobile article
// viewers to render an <iframe>, not by the PDF export (which only ever
// needs the original url for its captioned link line, not a player embed).
export function toEmbedUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtube.com" || host === "m.youtube.com") {
      const id = parsed.searchParams.get("v");
      if (id) return `https://www.youtube.com/embed/${id}`;
      const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/]+)/);
      if (shortsMatch) return `https://www.youtube.com/embed/${shortsMatch[1]}`;
      return null;
    }
    if (host === "youtu.be") {
      const id = parsed.pathname.slice(1);
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host === "vimeo.com") {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return id ? `https://player.vimeo.com/video/${id}` : null;
    }
    if (host === "loom.com") {
      const match = parsed.pathname.match(/^\/share\/([^/]+)/);
      return match ? `https://www.loom.com/embed/${match[1]}` : null;
    }
    return null;
  } catch {
    return null;
  }
}

// Notes module - markdown parsing helpers shared by desktop and mobile.
// These mirror (not duplicate the authority of) the regexes in the
// notes_module migration's notes_recompute_links_and_tags() trigger, which
// is the actual source of truth for what gets stored in note_links/
// note_tag_assignments once a note is saved - these client-side versions
// exist for immediate UI feedback (autocomplete while typing, a live
// "outgoing links" preview before save, live preview rendering) without a
// round trip. Keep the patterns in sync if either changes.

export const WIKILINK_REGEX = /\[\[([^\]|]+)(\|([^\]]*))?\]\]/g;
export const TAG_REGEX = /(?:^|\s)#([a-zA-Z0-9_][a-zA-Z0-9_/-]*)/g;

export interface ParsedWikilink {
  /** The full `[[...]]` match, for replace-in-place editing. */
  raw: string;
  /** The target note title (before any `|alias`). */
  target: string;
  /** Display text if `[[Target|Alias]]` was used, else null. */
  alias: string | null;
  index: number;
}

export function extractWikilinks(body: string): ParsedWikilink[] {
  const results: ParsedWikilink[] = [];
  for (const match of body.matchAll(WIKILINK_REGEX)) {
    const target = match[1]?.trim();
    if (!target) continue;
    results.push({
      raw: match[0],
      target,
      alias: match[3] ?? null,
      index: match.index ?? 0,
    });
  }
  return results;
}

export function extractTags(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(TAG_REGEX)) {
    const tag = match[1];
    if (tag) seen.add(tag);
  }
  return Array.from(seen);
}

export interface OutlineHeading {
  level: number;
  text: string;
  /** Stable id for scroll-to-heading, derived from position not text (titles can repeat). */
  id: string;
}

// Powers Step 3's Outline pane - a plain line-based scan for ATX-style
// (`#`/`##`/...) markdown headings, not a full markdown parser.
export function extractHeadings(body: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const lines = body.split("\n");
  lines.forEach((line, i) => {
    const match = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (match && match[1] && match[2]) {
      headings.push({ level: match[1].length, text: match[2].trim(), id: `heading-${i}` });
    }
  });
  return headings;
}

export type CalloutType = "info" | "warning" | "danger" | "success" | "note" | "tip";

const CALLOUT_TYPES: CalloutType[] = ["info", "warning", "danger", "success", "note", "tip"];

// Matches the first line of an Obsidian-style callout blockquote, e.g.
// "> [!warning] Optional title". Returns null for an ordinary blockquote.
// The renderer (desktop/mobile, not here - rendering is platform-specific)
// uses this to decide whether a `>` block gets the styled callout
// treatment and which theme colour to use.
export function parseCalloutHeader(firstLine: string): { type: CalloutType; title: string | null } | null {
  const match = /^>\s*\[!(\w+)\]\s*(.*)$/.exec(firstLine.trim());
  if (!match) return null;
  const type = match[1]?.toLowerCase();
  if (!type || !CALLOUT_TYPES.includes(type as CalloutType)) return null;
  return { type: type as CalloutType, title: match[2]?.trim() || null };
}

// Same `{token}` substitution convention as communication_templates
// (see process-scheduled-comms' renderTemplate) - reused here rather than
// inventing new templating syntax, for daily notes and note templates.
export function renderNoteTemplate(body: string, tokens: Record<string, string>): string {
  return body.replace(/\{(\w+)\}/g, (match, key: string) => (key in tokens ? tokens[key]! : match));
}

// Canonical daily-note title/date - ISO date, matching notes.daily_note_date.
// A friendlier display string is a UI-layer concern (Intl.DateTimeFormat),
// not this shared helper's job.
export function dailyNoteDateKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function buildDailyNoteTemplateTokens(date: Date = new Date()): Record<string, string> {
  return {
    date: dailyNoteDateKey(date),
    time: date.toTimeString().slice(0, 5),
  };
}

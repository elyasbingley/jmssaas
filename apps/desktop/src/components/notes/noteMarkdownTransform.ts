import { parseCalloutHeader, type CalloutType } from "@jmssaas/shared";

// Turns a note's raw markdown body into markdown react-markdown can render
// with clickable [[wikilinks]] and #tags, while leaving fenced/inline code
// untouched. Wikilinks/tags become plain markdown links with a custom
// scheme (`wikilink://`, `tagfilter://`) that the preview's `a` component
// intercepts - see NoteMarkdownPreview.tsx. Kept separate from
// @jmssaas/shared's notes.ts (which owns the *parsing* regexes/authority for
// what the server actually stores) since this is purely a presentation-layer
// rewrite of the same source text, not a second source of truth.

const WIKILINK_WITH_PREFIX = /\[\[([^\]|]+)(\|([^\]]*))?\]\]/g;
const TAG_WITH_PREFIX = /(^|\s)#([a-zA-Z0-9_][a-zA-Z0-9_/-]*)/g;

const CALLOUT_LABELS: Record<CalloutType, string> = {
  info: "ℹ INFO",
  warning: "⚠ WARNING",
  danger: "⛔ DANGER",
  success: "✓ SUCCESS",
  note: "📝 NOTE",
  tip: "💡 TIP",
};

function transformCalloutHeaders(segment: string): string {
  return segment
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith(">")) return line;
      const callout = parseCalloutHeader(trimmed);
      if (!callout) return line;
      const label = CALLOUT_LABELS[callout.type];
      const title = callout.title ? ` - ${callout.title}` : "";
      // Keep the leading "> " so this stays part of the same blockquote;
      // swap the raw "[!type] Title" marker for a bold, labelled line.
      return `> **${label}${title}**`;
    })
    .join("\n");
}

function transformWikilinksAndTags(segment: string): string {
  const withCallouts = transformCalloutHeaders(segment);
  const withLinks = withCallouts.replace(WIKILINK_WITH_PREFIX, (_full, target: string, _pipeAlias, alias?: string) => {
    const trimmedTarget = target.trim();
    const label = (alias ?? trimmedTarget).trim() || trimmedTarget;
    return `[${label}](wikilink://${encodeURIComponent(trimmedTarget)})`;
  });
  return withLinks.replace(TAG_WITH_PREFIX, (_full, prefix: string, tag: string) => `${prefix}[#${tag}](tagfilter://${encodeURIComponent(tag)})`);
}

/** Splits on a delimiter regex (with a capturing group) and returns
 * alternating [outside, delimiter, outside, delimiter, ...] segments. */
function splitKeepingDelimiters(text: string, pattern: RegExp): string[] {
  return text.split(pattern);
}

export function preprocessNoteMarkdown(body: string): string {
  // Leave fenced code blocks completely alone, transform everything else,
  // then do the same one level down for inline code spans.
  return splitKeepingDelimiters(body, /(```[\s\S]*?```)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part; // fenced code block - untouched
      return splitKeepingDelimiters(part, /(`[^`\n]*`)/g)
        .map((inner, j) => (j % 2 === 1 ? inner : transformWikilinksAndTags(inner)))
        .join("");
    })
    .join("");
}

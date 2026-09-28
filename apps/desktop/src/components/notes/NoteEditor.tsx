import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { NoteMarkdownPreview } from "./NoteMarkdownPreview";
import { getCaretCoordinates } from "./caretPosition";
import { type TitleLookupEntry } from "./notesData";

// Markdown source textarea + live preview, with [[wikilink]] autocomplete.
// "Edit / Split / Preview" mirrors Obsidian's own view-mode toggle - a
// superset of the spec's "Source/Preview toggle, or side-by-side" ask.

type ViewMode = "edit" | "split" | "preview";

const SUGGESTION_LIMIT = 8;

interface OpenWikilink {
  start: number; // index of the "[[" that opened this link
  query: string;
}

function findOpenWikilink(value: string, cursor: number): OpenWikilink | null {
  const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
  const line = value.slice(lineStart, cursor);
  const lastOpen = line.lastIndexOf("[[");
  if (lastOpen === -1) return null;
  const afterOpen = line.slice(lastOpen + 2);
  if (afterOpen.includes("]]") || afterOpen.includes("[[")) return null;
  return { start: lineStart + lastOpen, query: afterOpen };
}

export interface NoteEditorProps {
  body: string;
  onBodyChange: (value: string) => void;
  titleIndex: Map<string, TitleLookupEntry>;
  onNavigateToNote: (noteId: string) => void;
  onCreateAndNavigate: (title: string) => void;
  onFilterByTag: (tag: string) => void;
  readOnly?: boolean;
}

export function NoteEditor({ body, onBodyChange, titleIndex, onNavigateToNote, onCreateAndNavigate, onFilterByTag, readOnly }: NoteEditorProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCursorRef = useRef<number | null>(null);

  const [open, setOpen] = useState<OpenWikilink | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);

  const allTitles = useMemo(() => Array.from(titleIndex.values()), [titleIndex]);

  const suggestions = useMemo(() => {
    if (!open) return [];
    const q = open.query.trim().toLowerCase();
    const pool = q ? allTitles.filter((t) => t.title.toLowerCase().includes(q)) : allTitles;
    return pool.slice(0, SUGGESTION_LIMIT);
  }, [open, allTitles]);

  const recomputeOpenLink = (textarea: HTMLTextAreaElement) => {
    const cursor = textarea.selectionStart;
    const found = findOpenWikilink(textarea.value, cursor);
    setOpen(found);
    setHighlightIndex(0);
    if (found) {
      const c = getCaretCoordinates(textarea, cursor);
      setCoords({ top: c.top + c.height + 4, left: c.left });
    } else {
      setCoords(null);
    }
  };

  const insertSuggestion = (title: string) => {
    if (!open || !textareaRef.current) return;
    const textarea = textareaRef.current;
    const cursor = textarea.selectionStart;
    const newValue = `${body.slice(0, open.start)}[[${title}]]${body.slice(cursor)}`;
    const newCursor = open.start + title.length + 4;
    pendingCursorRef.current = newCursor;
    onBodyChange(newValue);
    setOpen(null);
    setCoords(null);
    // Restore focus/caret after the controlled value re-renders.
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(newCursor, newCursor);
      pendingCursorRef.current = null;
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertSuggestion(suggestions[highlightIndex]!.title);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(null);
        setCoords(null);
        return;
      }
    }
  };

  const showEditor = viewMode === "edit" || viewMode === "split";
  const showPreview = viewMode === "preview" || viewMode === "split";

  return (
    <div>
      <div className="mb-2 flex gap-1">
        {(["edit", "split", "preview"] as ViewMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setViewMode(m)}
            className="rounded border px-3 py-1 font-semibold uppercase tracking-wide"
            style={
              viewMode === m
                ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
            }
          >
            {m}
          </button>
        ))}
      </div>

      <div className={`grid gap-4 ${showEditor && showPreview ? "grid-cols-2" : "grid-cols-1"}`}>
        {showEditor ? (
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={body}
              readOnly={readOnly}
              onChange={(e) => {
                onBodyChange(e.target.value);
                recomputeOpenLink(e.target);
              }}
              onClick={(e) => recomputeOpenLink(e.currentTarget)}
              onKeyUp={(e) => recomputeOpenLink(e.currentTarget)}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                setOpen(null);
                setCoords(null);
              }}
              placeholder={"Write in markdown. Use [[Note Title]] to link, #tag for tags, > [!warning] for callouts..."}
              className="min-h-[420px] w-full rounded border p-3 font-mono focus:outline-none"
              style={{
                backgroundColor: "var(--jms-bg)",
                borderColor: "var(--jms-border)",
                color: "var(--jms-text)",
                fontSize: "var(--jms-font-body)",
                resize: "vertical",
              }}
            />
            {open && coords && suggestions.length > 0 ? (
              <div
                className="absolute z-20 max-h-56 w-64 overflow-y-auto rounded"
                style={{ top: coords.top, left: coords.left, border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", boxShadow: "0 0 12px var(--jms-accent-glow)" }}
              >
                {suggestions.map((s, i) => (
                  <button
                    key={s.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      insertSuggestion(s.title);
                    }}
                    className="block w-full truncate px-3 py-1.5 text-left"
                    style={
                      i === highlightIndex
                        ? { backgroundColor: "var(--jms-accent-glow)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                        : { color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }
                    }
                  >
                    {s.title}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {showPreview ? (
          <div
            className="min-h-[420px] overflow-y-auto rounded border p-3"
            style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)" }}
          >
            <NoteMarkdownPreview
              body={body}
              titleIndex={titleIndex}
              onNavigateToNote={onNavigateToNote}
              onCreateAndNavigate={onCreateAndNavigate}
              onFilterByTag={onFilterByTag}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

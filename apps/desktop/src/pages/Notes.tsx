import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate, useParams } from "react-router-dom";
import { dailyNoteDateKey } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { ThemedButton } from "../components/theme/ThemedButton";
import {
  NOTEBOOKS_KEY,
  NOTES_INDEX_KEY,
  NOTE_TAGS_KEY,
  NOTE_TAG_ASSIGNMENTS_KEY,
  NOTE_TEMPLATES_KEY,
  fetchNoteTags,
  fetchNoteTagAssignments,
  fetchNoteTemplates,
  fetchNotebooks,
  fetchNotesIndex,
  type NoteIndexRow,
} from "../components/notes/notesData";
import { NotebookTree } from "../components/notes/NotebookTree";
import { NewNoteModal } from "../components/notes/NewNoteModal";

// Notes module shell - Obsidian-style "vault" layout, kept conceptually
// separate from the admin-authored, published-article Knowledge module
// (see the notes_module migration's own top comment). Three persistent
// columns (notebooks/tags/actions, then the note list + search, then
// whatever the active route renders) so navigating between notes via
// wikilinks or the list never loses your place in the tree - the same
// nested-route + <Outlet/> shape Tasks.tsx/Channels.tsx use, just rendered
// inline as the main content instead of an overlay drawer, since here the
// "detail" *is* the primary content, not a peek panel.

interface SearchHit {
  id: string;
  title: string;
  body: string;
}

async function runFullTextSearch(query: string): Promise<SearchHit[]> {
  const { data, error } = await supabase
    .from("notes")
    .select("id, title, body")
    .eq("is_deleted", false)
    .textSearch("search_vector", query, { type: "websearch", config: "english" })
    .limit(20);
  if (error) throw error;
  return data as SearchHit[];
}

function snippet(body: string, max = 80): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

export default function NotesPage() {
  const navigate = useNavigate();
  const params = useParams();

  const { data: notebooks } = useQuery({ queryKey: NOTEBOOKS_KEY, queryFn: fetchNotebooks });
  const { data: notesIndex } = useQuery({ queryKey: NOTES_INDEX_KEY, queryFn: fetchNotesIndex });
  const { data: tags } = useQuery({ queryKey: NOTE_TAGS_KEY, queryFn: fetchNoteTags });
  const { data: tagAssignments } = useQuery({ queryKey: NOTE_TAG_ASSIGNMENTS_KEY, queryFn: fetchNoteTagAssignments });
  const { data: templates } = useQuery({ queryKey: NOTE_TEMPLATES_KEY, queryFn: fetchNoteTemplates });

  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [dailyNoteModal, setDailyNoteModal] = useState<{ dateKey: string } | null>(null);

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed.length < 2) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timeout = setTimeout(async () => {
      try {
        const hits = await runFullTextSearch(trimmed);
        if (!cancelled) setSearchResults(hits);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [search]);

  const noteCountByNotebook = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of notesIndex ?? []) {
      if (!n.notebook_id) continue;
      map.set(n.notebook_id, (map.get(n.notebook_id) ?? 0) + 1);
    }
    return map;
  }, [notesIndex]);

  const tagCounts = useMemo(() => {
    const byId = new Map((tags ?? []).map((t) => [t.id, t.name]));
    const counts = new Map<string, number>();
    for (const a of tagAssignments ?? []) {
      const name = byId.get(a.tag_id);
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [tags, tagAssignments]);

  const visibleNotes = useMemo((): NoteIndexRow[] => {
    const list = notesIndex ?? [];
    if (selectedNotebookId === null) return list;
    return list.filter((n) => n.notebook_id === selectedNotebookId);
  }, [notesIndex, selectedNotebookId]);

  const sortedNotes = useMemo(() => [...visibleNotes].sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [visibleNotes]);

  const handleDailyNote = async () => {
    const dateKey = dailyNoteDateKey();
    const existing = (notesIndex ?? []).find((n) => n.daily_note_date === dateKey);
    if (existing) {
      navigate(`/notes/note/${existing.id}`);
      return;
    }
    setDailyNoteModal({ dateKey });
  };

  const activeNoteId = params.noteId;

  return (
    <div className="flex h-full" style={{ fontFamily: "var(--jms-font)" }}>
      {/* Column 1: notebooks, tags, quick actions */}
      <div className="flex w-56 flex-shrink-0 flex-col gap-4 overflow-y-auto p-4" style={{ borderRight: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)" }}>
        <div>
          <h1 className="mb-3 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            Notes
          </h1>
          <div className="space-y-2">
            <ThemedButton onClick={() => setNewNoteOpen(true)} style={{ width: "100%", paddingBlock: 6 }}>
              + New note
            </ThemedButton>
            <ThemedButton variant="secondary" onClick={handleDailyNote} style={{ width: "100%", paddingBlock: 6 }}>
              Today's note
            </ThemedButton>
          </div>
        </div>

        <div className="space-y-1">
          <button onClick={() => navigate("/notes/table")} className="jms-nav-link block w-full rounded px-2 py-1 text-left font-semibold" style={{ fontSize: "var(--jms-font-body)" }}>
            Table view
          </button>
          <button onClick={() => navigate("/notes/cards")} className="jms-nav-link block w-full rounded px-2 py-1 text-left font-semibold" style={{ fontSize: "var(--jms-font-body)" }}>
            Card view
          </button>
          <button onClick={() => navigate("/notes/graph")} className="jms-nav-link block w-full rounded px-2 py-1 text-left font-semibold" style={{ fontSize: "var(--jms-font-body)" }}>
            Graph view
          </button>
        </div>

        <NotebookTree notebooks={notebooks ?? []} noteCountByNotebook={noteCountByNotebook} selectedId={selectedNotebookId} onSelect={setSelectedNotebookId} />

        {(tags ?? []).length > 0 ? (
          <div>
            <p className="mb-1 uppercase tracking-widest" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Tags
            </p>
            <div className="flex flex-wrap gap-1">
              {(tags ?? []).map((t) => (
                <button
                  key={t.id}
                  onClick={() => navigate(`/notes/tag/${encodeURIComponent(t.name)}`)}
                  className="rounded border px-2 py-0.5"
                  style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                >
                  #{t.name}
                  <span className="ml-1">{tagCounts.get(t.name) ?? 0}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* Column 2: search + note list */}
      <div className="flex w-64 flex-shrink-0 flex-col overflow-y-auto p-3" style={{ borderRight: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Full-text search notes..."
          className="mb-3 w-full rounded border px-3 py-1.5 focus:outline-none"
          style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
        />

        {search.trim().length >= 2 ? (
          <div>
            {searching ? (
              <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Searching...</p>
            ) : (searchResults ?? []).length === 0 ? (
              <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No matches.</p>
            ) : (
              <div className="space-y-1">
                {(searchResults ?? []).map((hit) => (
                  <button
                    key={hit.id}
                    onClick={() => navigate(`/notes/note/${hit.id}`)}
                    className={`jms-nav-link block w-full rounded px-2 py-1.5 text-left ${activeNoteId === hit.id ? "jms-nav-link-active" : ""}`}
                  >
                    <p className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                      {hit.title}
                    </p>
                    <p className="truncate" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                      {snippet(hit.body)}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {sortedNotes.length === 0 ? (
              <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No notes here yet.</p>
            ) : (
              sortedNotes.map((n) => (
                <button
                  key={n.id}
                  onClick={() => navigate(`/notes/note/${n.id}`)}
                  className={`jms-nav-link block w-full truncate rounded px-2 py-1.5 text-left font-semibold ${activeNoteId === n.id ? "jms-nav-link-active" : ""}`}
                  style={{ fontSize: "var(--jms-font-body)" }}
                >
                  {n.title || "Untitled"}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Column 3: routed content */}
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        <Outlet />
      </div>

      <NewNoteModal
        open={newNoteOpen}
        onClose={() => setNewNoteOpen(false)}
        notebooks={notebooks ?? []}
        templates={templates ?? []}
        defaultNotebookId={selectedNotebookId}
        onCreated={(id) => navigate(`/notes/note/${id}`)}
      />
      <NewNoteModal
        open={!!dailyNoteModal}
        onClose={() => setDailyNoteModal(null)}
        notebooks={notebooks ?? []}
        templates={templates ?? []}
        dailyNoteDate={dailyNoteModal?.dateKey}
        onCreated={(id) => navigate(`/notes/note/${id}`)}
      />
    </div>
  );
}

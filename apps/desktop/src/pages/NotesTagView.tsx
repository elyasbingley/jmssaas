import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  NOTES_INDEX_KEY,
  NOTE_TAGS_KEY,
  NOTE_TAG_ASSIGNMENTS_KEY,
  fetchNoteTagAssignments,
  fetchNoteTags,
  fetchNotesIndex,
} from "../components/notes/notesData";

// Browse-by-tag - the sidebar's #tag pills route here.
export default function NotesTagViewPage() {
  const { tagName } = useParams<{ tagName: string }>();
  const navigate = useNavigate();
  const decoded = decodeURIComponent(tagName ?? "");

  const { data: notesIndex } = useQuery({ queryKey: NOTES_INDEX_KEY, queryFn: fetchNotesIndex });
  const { data: tags } = useQuery({ queryKey: NOTE_TAGS_KEY, queryFn: fetchNoteTags });
  const { data: assignments } = useQuery({ queryKey: NOTE_TAG_ASSIGNMENTS_KEY, queryFn: fetchNoteTagAssignments });

  const notes = useMemo(() => {
    const tag = (tags ?? []).find((t) => t.name === decoded);
    if (!tag) return [];
    const noteIds = new Set((assignments ?? []).filter((a) => a.tag_id === tag.id).map((a) => a.note_id));
    return (notesIndex ?? []).filter((n) => noteIds.has(n.id)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [tags, assignments, notesIndex, decoded]);

  return (
    <div>
      <h2 className="mb-4 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        #{decoded}
      </h2>
      {notes.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No notes tagged #{decoded}.</p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {notes.map((n) => (
            <button
              key={n.id}
              onClick={() => navigate(`/notes/note/${n.id}`)}
              className="rounded p-3 text-left"
              style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
            >
              <p className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                {n.title || "Untitled"}
              </p>
              <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{new Date(n.updated_at).toLocaleDateString("en-AU")}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

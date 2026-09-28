import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { NOTES_INDEX_KEY, fetchNotesIndex } from "../components/notes/notesData";

// Default /notes landing content - a "recently updated" overview so the
// column-3 outlet is never blank before a note/view is picked.
export default function NotesHomePage() {
  const navigate = useNavigate();
  const { data: notesIndex, isLoading } = useQuery({ queryKey: NOTES_INDEX_KEY, queryFn: fetchNotesIndex });

  const recent = useMemo(() => [...(notesIndex ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 12), [notesIndex]);

  return (
    <div>
      <h2 className="mb-1 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Welcome back
      </h2>
      <p className="mb-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
        Pick a note from the list, jump into Today's note, or browse the Table / Card / Graph views on the left.
      </p>

      <p className="mb-2 uppercase tracking-widest" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Recently updated
      </p>
      {isLoading ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
      ) : recent.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No notes yet - create your first one from the sidebar.</p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {recent.map((n) => (
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

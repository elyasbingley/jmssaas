import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { extractTags, extractWikilinks, updateNoteSchema, type NoteAccessLevel } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedSelectField } from "../components/theme/ThemedFormField";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedFormField } from "../components/theme/ThemedFormField";
import { NoteEditor } from "../components/notes/NoteEditor";
import { PropertiesPanel } from "../components/notes/PropertiesPanel";
import { NoteHistoryModal } from "../components/notes/NoteHistoryModal";
import {
  ALL_NOTE_LINKS_KEY,
  NOTEBOOKS_KEY,
  NOTES_INDEX_KEY,
  NOTE_TAGS_KEY,
  NOTE_TAG_ASSIGNMENTS_KEY,
  NOTE_TEMPLATES_KEY,
  buildTitleIndex,
  fetchLatestNoteRevision,
  fetchNote,
  fetchNoteLinksTouching,
  fetchNoteTemplates,
  fetchNotebooks,
  fetchNotesIndex,
} from "../components/notes/notesData";

const ACCESS_OPTIONS: { value: NoteAccessLevel; label: string }[] = [
  { value: "tenant", label: "Everyone" },
  { value: "admin_only", label: "Admins only" },
];

export default function NoteDetailPage() {
  const { noteId } = useParams<{ noteId: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: note, isLoading } = useQuery({ queryKey: ["note", noteId], queryFn: () => fetchNote(noteId!), enabled: !!noteId });
  const { data: notesIndex } = useQuery({ queryKey: NOTES_INDEX_KEY, queryFn: fetchNotesIndex });
  const { data: notebooks } = useQuery({ queryKey: NOTEBOOKS_KEY, queryFn: fetchNotebooks });
  const { data: templates } = useQuery({ queryKey: NOTE_TEMPLATES_KEY, queryFn: fetchNoteTemplates });
  const { data: touchingLinks } = useQuery({ queryKey: ["note-links", noteId], queryFn: () => fetchNoteLinksTouching(noteId!), enabled: !!noteId });
  const { data: latestRevision } = useQuery({ queryKey: ["note-latest-revision", noteId], queryFn: () => fetchLatestNoteRevision(noteId!), enabled: !!noteId });

  const titleIndex = useMemo(() => buildTitleIndex(notesIndex ?? []), [notesIndex]);
  const notesById = useMemo(() => new Map((notesIndex ?? []).map((n) => [n.id, n])), [notesIndex]);

  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [notebookId, setNotebookId] = useState("");
  const [visibility, setVisibility] = useState<NoteAccessLevel>("tenant");
  const [editAccess, setEditAccess] = useState<NoteAccessLevel>("tenant");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateError, setTemplateError] = useState<string | null>(null);

  // Only reset the draft when we've actually switched notes - a background
  // refetch of the *same* note (after our own save) must never clobber
  // whatever the user is still typing.
  useEffect(() => {
    if (!note) return;
    setDraftTitle(note.title);
    setDraftBody(note.body);
    setNotebookId(note.notebook_id ?? "");
    setVisibility(note.visibility);
    setEditAccess(note.edit_access);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id]);

  const dirty =
    !!note &&
    (draftTitle !== note.title ||
      draftBody !== note.body ||
      (notebookId || null) !== note.notebook_id ||
      visibility !== note.visibility ||
      editAccess !== note.edit_access);

  const save = useMutation({
    mutationFn: async () => {
      if (!note || !profile) throw new Error("Not signed in");
      const result = updateNoteSchema.safeParse({
        title: draftTitle,
        body: draftBody,
        notebook_id: notebookId || null,
        visibility,
        edit_access: editAccess,
        // The revision we last read - see the notes_module migration's
        // notes_handle_revision() trigger. Always sent, never omitted.
        revision: note.revision,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid note");

      const { error } = await supabase
        .from("notes")
        .update({
          title: result.data.title,
          body: result.data.body,
          notebook_id: result.data.notebook_id,
          visibility: result.data.visibility,
          edit_access: result.data.edit_access,
          revision: result.data.revision,
          updated_by: profile.id,
        })
        .eq("id", note.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["note", noteId] });
      queryClient.invalidateQueries({ queryKey: NOTES_INDEX_KEY });
      queryClient.invalidateQueries({ queryKey: ["note-links", noteId] });
      queryClient.invalidateQueries({ queryKey: ALL_NOTE_LINKS_KEY });
      queryClient.invalidateQueries({ queryKey: NOTE_TAGS_KEY });
      queryClient.invalidateQueries({ queryKey: NOTE_TAG_ASSIGNMENTS_KEY });
      queryClient.invalidateQueries({ queryKey: ["note-latest-revision", noteId] });
    },
  });

  // Debounced autosave - a manual Save button (below) is always available
  // too. Only fires while there's an actual difference from the last
  // loaded note, so it goes idle again the instant a save lands.
  useEffect(() => {
    if (!dirty || !draftTitle.trim() || save.isPending) return;
    const t = setTimeout(() => save.mutate(), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftTitle, draftBody, notebookId, visibility, editAccess]);

  const createAndNavigate = async (title: string) => {
    if (!profile || !note) return;
    setLinkError(null);
    try {
      if (dirty) await save.mutateAsync();
      const { data, error } = await supabase
        .from("notes")
        .insert({ tenant_id: profile.tenant_id, title, body: "", visibility: "tenant", edit_access: "tenant", created_by: profile.id, updated_by: profile.id })
        .select()
        .single();
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: NOTES_INDEX_KEY });
      navigate(`/notes/note/${data.id}`);
    } catch (e) {
      setLinkError(getErrorMessage(e, "Failed to create that note"));
    }
  };

  const remove = useMutation({
    mutationFn: async () => {
      if (!note) return;
      const { error } = await supabase.from("notes").update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq("id", note.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NOTES_INDEX_KEY });
      navigate("/notes");
    },
  });

  const saveAsTemplate = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const { error } = await supabase.from("note_templates").insert({ tenant_id: profile.tenant_id, name: templateName, body: draftBody, created_by: profile.id });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NOTE_TEMPLATES_KEY });
      setTemplateModalOpen(false);
      setTemplateName("");
    },
    onError: (e) => setTemplateError(getErrorMessage(e, "Failed to save template")),
  });

  const outgoing = useMemo(() => {
    const seen = new Set<string>();
    return extractWikilinks(draftBody).filter((w) => {
      const k = w.target.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [draftBody]);

  const liveTags = useMemo(() => extractTags(draftBody), [draftBody]);

  const backlinks = useMemo(() => (touchingLinks ?? []).filter((l) => l.target_note_id === noteId && l.source_note_id !== noteId), [touchingLinks, noteId]);

  if (isLoading || !note) {
    return <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading note...</p>;
  }

  // Desktop is admin-only end to end (see RequireAdmin) and is_admin() is
  // always true for RLS purposes here, so edit_access never actually blocks
  // a desktop user - this UI still shows the control since it's real,
  // enforced, mobile-relevant data.
  const canEdit = true;
  const isConflict = latestRevision?.reason === "conflict_lost";
  const saveStatus = save.isPending ? "Saving..." : save.isError ? "Save failed" : dirty ? "Unsaved changes" : "Saved";

  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1">
        {isConflict ? (
          <div
            className="mb-4 flex items-center justify-between gap-3 rounded p-3"
            style={{ border: "1px solid var(--jms-warning)", backgroundColor: "var(--jms-surface)" }}
          >
            <p style={{ color: "var(--jms-warning)", fontSize: "var(--jms-font-body)" }}>
              A previous version of this note was overwritten by a conflicting edit.
            </p>
            <button onClick={() => setHistoryOpen(true)} className="font-semibold hover:underline" style={{ color: "var(--jms-warning)", fontSize: "var(--jms-font-label)" }}>
              View history to restore
            </button>
          </div>
        ) : null}

        <input
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          placeholder="Untitled note"
          className="mb-2 w-full bg-transparent uppercase tracking-widest focus:outline-none"
          style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}
        />

        {liveTags.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-1">
            {liveTags.map((t) => (
              <button
                key={t}
                onClick={() => navigate(`/notes/tag/${encodeURIComponent(t)}`)}
                className="rounded border px-2 py-0.5"
                style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
              >
                #{t}
              </button>
            ))}
          </div>
        ) : null}

        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="w-48">
            <ThemedSelectField label="Notebook" value={notebookId} onChange={setNotebookId} placeholder="Unfiled" options={(notebooks ?? []).map((n) => ({ value: n.id, label: n.name }))} />
          </div>
          <div className="w-40">
            <ThemedSelectField label="Visible to" value={visibility} onChange={(v) => setVisibility((v || "tenant") as NoteAccessLevel)} options={ACCESS_OPTIONS} />
          </div>
          <div className="w-40">
            <ThemedSelectField label="Editable by" value={editAccess} onChange={(v) => setEditAccess((v || "tenant") as NoteAccessLevel)} options={ACCESS_OPTIONS} />
          </div>
          <div className="mb-4 flex-1" />
          <span className="mb-4" style={{ color: dirty ? "var(--jms-warning)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {saveStatus}
          </span>
          <ThemedButton onClick={() => save.mutate()} disabled={!dirty || save.isPending} style={{ marginBottom: 16 }}>
            Save
          </ThemedButton>
          <ThemedButton variant="secondary" onClick={() => setHistoryOpen(true)} style={{ marginBottom: 16 }}>
            History
          </ThemedButton>
          <ThemedButton variant="secondary" onClick={() => setTemplateModalOpen(true)} style={{ marginBottom: 16 }}>
            Save as template
          </ThemedButton>
          <ThemedButton
            variant="danger"
            style={{ marginBottom: 16 }}
            onClick={() => {
              if (window.confirm(`Delete "${note.title}"? It can be recovered from the database but not from this app.`)) remove.mutate();
            }}
          >
            Delete
          </ThemedButton>
        </div>

        {linkError ? (
          <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {linkError}
          </p>
        ) : null}
        {save.isError ? (
          <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {getErrorMessage(save.error, "Failed to save note")}
          </p>
        ) : null}

        <NoteEditor
          body={draftBody}
          onBodyChange={setDraftBody}
          titleIndex={titleIndex}
          onNavigateToNote={(id) => navigate(`/notes/note/${id}`)}
          onCreateAndNavigate={createAndNavigate}
          onFilterByTag={(tag) => navigate(`/notes/tag/${encodeURIComponent(tag)}`)}
          readOnly={!canEdit}
        />
      </div>

      <div className="w-72 flex-shrink-0 space-y-4">
        <div className="rounded p-3" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <p className="mb-2 uppercase tracking-widest" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Properties
          </p>
          <PropertiesPanel noteId={note.id} canEdit={canEdit} />
        </div>

        <div className="rounded p-3" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <p className="mb-2 uppercase tracking-widest" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Outgoing links
          </p>
          {outgoing.length === 0 ? (
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>None yet - type [[Note Title]] in the editor.</p>
          ) : (
            <div className="space-y-1">
              {outgoing.map((w) => {
                const resolved = titleIndex.get(w.target.toLowerCase());
                return (
                  <button
                    key={w.target}
                    onClick={() => (resolved ? navigate(`/notes/note/${resolved.id}`) : createAndNavigate(w.target))}
                    className="block w-full truncate text-left"
                    style={
                      resolved
                        ? { color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                        : { color: "var(--jms-danger)", fontSize: "var(--jms-font-body)", borderBottom: "1px dashed var(--jms-danger)" }
                    }
                  >
                    {w.alias ?? w.target}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded p-3" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <p className="mb-2 uppercase tracking-widest" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Backlinks
          </p>
          {backlinks.length === 0 ? (
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No other notes link here yet.</p>
          ) : (
            <div className="space-y-1">
              {backlinks.map((l) => {
                const source = notesById.get(l.source_note_id);
                return (
                  <button
                    key={l.id}
                    onClick={() => navigate(`/notes/note/${l.source_note_id}`)}
                    className="block w-full truncate text-left"
                    style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
                  >
                    {source?.title ?? "Untitled"}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <NoteHistoryModal
        noteId={note.id}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        currentRevision={note.revision}
        onRestored={(title, body) => {
          // Push the restored content straight into the draft - the
          // note?.id-gated sync effect above deliberately won't do this on
          // its own (see that effect's comment), and leaving the old draft
          // in place would let the next autosave silently undo the restore.
          setDraftTitle(title);
          setDraftBody(body);
          setHistoryOpen(false);
        }}
      />

      <ThemedModal open={templateModalOpen} onClose={() => setTemplateModalOpen(false)} title="Save as template">
        <ThemedFormField label="Template name" value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="e.g. Meeting notes" />
        {templateError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {templateError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setTemplateModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveAsTemplate.mutate()} disabled={saveAsTemplate.isPending || !templateName.trim()}>
            {saveAsTemplate.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}

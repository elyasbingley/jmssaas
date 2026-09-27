import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { buildDailyNoteTemplateTokens, createNoteSchema, renderNoteTemplate, type Note, type NoteNotebook, type NoteTemplate } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { ThemedModal } from "../theme/ThemedModal";
import { ThemedButton } from "../theme/ThemedButton";
import { ThemedFormField, ThemedSelectField } from "../theme/ThemedFormField";
import { NOTES_INDEX_KEY } from "./notesData";

// Shared by "+ New note" and "Today's note" (see NotesPage) - a daily note
// is just a regular note with daily_note_date set, optionally seeded from
// a template via the same {token} substitution used everywhere else in
// this module (renderNoteTemplate).
export function NewNoteModal({
  open,
  onClose,
  notebooks,
  templates,
  defaultNotebookId,
  dailyNoteDate,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  notebooks: NoteNotebook[];
  templates: NoteTemplate[];
  defaultNotebookId?: string | null;
  dailyNoteDate?: string;
  onCreated: (noteId: string) => void;
}) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [notebookId, setNotebookId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(dailyNoteDate ? new Date(`${dailyNoteDate}T00:00:00`).toLocaleDateString("en-AU", { weekday: "long", year: "numeric", month: "long", day: "numeric" }) : "");
    setNotebookId(defaultNotebookId ?? "");
    setTemplateId("");
    setError(null);
  }, [open, dailyNoteDate, defaultNotebookId]);

  const create = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const template = templates.find((t) => t.id === templateId);
      const body = template ? renderNoteTemplate(template.body, buildDailyNoteTemplateTokens(dailyNoteDate ? new Date(`${dailyNoteDate}T00:00:00`) : new Date())) : "";

      const result = createNoteSchema.safeParse({
        title,
        body,
        notebook_id: notebookId || undefined,
        daily_note_date: dailyNoteDate,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid note");

      const { data, error: dbError } = await supabase
        .from("notes")
        .insert({
          tenant_id: profile.tenant_id,
          title: result.data.title,
          body: result.data.body,
          notebook_id: result.data.notebook_id ?? null,
          daily_note_date: result.data.daily_note_date ?? null,
          visibility: result.data.visibility,
          edit_access: result.data.edit_access,
          created_by: profile.id,
          updated_by: profile.id,
        })
        .select()
        .single();
      if (dbError) throw dbError;
      return data as Note;
    },
    onSuccess: (note) => {
      queryClient.invalidateQueries({ queryKey: NOTES_INDEX_KEY });
      onCreated(note.id);
      onClose();
    },
    onError: (e) => setError(getErrorMessage(e, "Failed to create note")),
  });

  return (
    <ThemedModal open={open} onClose={onClose} title={dailyNoteDate ? "New daily note" : "New note"}>
      <ThemedFormField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled note" />
      <ThemedSelectField
        label="Notebook (optional)"
        value={notebookId}
        onChange={setNotebookId}
        placeholder="Unfiled"
        options={notebooks.map((n) => ({ value: n.id, label: n.name }))}
      />
      <ThemedSelectField
        label="Start from template (optional)"
        value={templateId}
        onChange={setTemplateId}
        placeholder="Blank note"
        options={templates.map((t) => ({ value: t.id, label: t.name }))}
      />
      {error ? (
        <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-3">
        <button onClick={onClose} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          Cancel
        </button>
        <ThemedButton onClick={() => create.mutate()} disabled={create.isPending || !title.trim()}>
          {create.isPending ? "Creating..." : "Create"}
        </ThemedButton>
      </div>
    </ThemedModal>
  );
}

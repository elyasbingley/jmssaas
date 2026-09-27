import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Note } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { getErrorMessage } from "../../lib/errors";
import { ThemedModal } from "../theme/ThemedModal";
import { ThemedButton } from "../theme/ThemedButton";
import { ThemedBadge } from "../theme/ThemedBadge";
import { fetchNoteRevisions } from "./notesData";

// History panel (note_revisions) - also where a conflict-losing edit
// (reason = 'conflict_lost', see the notes_module migration's
// notes_handle_revision() trigger) shows up and can be restored. Nothing
// here is ever destroyed by a restore: it's just another ordinary revision-
// checked update, which itself gets snapshotted if it clashes with a newer
// edit made while this modal was open.
export function NoteHistoryModal({
  noteId,
  open,
  onClose,
  currentRevision,
  onRestored,
}: {
  noteId: string;
  open: boolean;
  onClose: () => void;
  currentRevision: number;
  // Called with the restored title/body so the caller can push it straight
  // into its draft state - the note query is also invalidated/refetched,
  // but the editor's draft intentionally doesn't re-sync from every
  // refetch (see NoteDetail's own comment), so without this the on-screen
  // editor would keep showing the pre-restore text and could autosave
  // right back over the restore on the next debounce tick.
  onRestored: (title: string, body: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data: revisions, isLoading } = useQuery({
    queryKey: ["note-revisions", noteId],
    queryFn: () => fetchNoteRevisions(noteId),
    enabled: open,
  });

  const restore = useMutation({
    mutationFn: async ({ title, body }: { title: string; body: string }) => {
      const { error } = await supabase.from("notes").update({ title, body, revision: currentRevision }).eq("id", noteId);
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      // Patch the cache with the revision we know the trigger just landed
      // on (currentRevision + 1, since old.revision matched what we sent),
      // so the note query is immediately consistent with the draft state
      // onRestored is about to push in - no race with the background
      // refetch below, which is why the trigger's own advance-by-1
      // guarantee (see the notes_module migration) matters here.
      queryClient.setQueryData(["note", noteId], (old: Note | undefined) =>
        old ? { ...old, title: variables.title, body: variables.body, revision: currentRevision + 1 } : old
      );
      queryClient.invalidateQueries({ queryKey: ["note", noteId] });
      queryClient.invalidateQueries({ queryKey: ["note-revisions", noteId] });
      onRestored(variables.title, variables.body);
      onClose();
    },
  });

  return (
    <ThemedModal open={open} onClose={onClose} title="Note history">
      {isLoading ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
      ) : (revisions ?? []).length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No earlier revisions yet - this note has only ever had one version.</p>
      ) : (
        <div className="max-h-96 space-y-2 overflow-y-auto">
          {(revisions ?? []).map((r) => (
            <div key={r.id} className="rounded p-3" style={{ border: "1px solid var(--jms-border)" }}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                    {new Date(r.edited_at).toLocaleString("en-AU")}
                  </span>
                  <span style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>rev {r.revision}</span>
                  {r.reason === "conflict_lost" ? <ThemedBadge label="Conflict - overwritten" color="var(--jms-warning)" /> : null}
                </div>
                <ThemedButton
                  variant="secondary"
                  style={{ paddingBlock: 4, paddingInline: 10 }}
                  onClick={() => restore.mutate({ title: r.title, body: r.body })}
                  disabled={restore.isPending}
                >
                  Restore this version
                </ThemedButton>
              </div>
              <p className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                {r.title}
              </p>
              <p className="truncate" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                {r.body.slice(0, 140) || "(empty)"}
              </p>
            </div>
          ))}
        </div>
      )}
      {restore.isError ? (
        <p className="mt-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {getErrorMessage(restore.error, "Failed to restore that version")}
        </p>
      ) : null}
    </ThemedModal>
  );
}

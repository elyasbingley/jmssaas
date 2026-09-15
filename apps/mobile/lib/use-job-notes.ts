import { useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { usePowerSync, useQuery } from "@powersync/react";
import { createJobNoteSchema, type JobNote } from "@jmssaas/shared";
import { useAuth } from "./auth-context";

// Shared by the Job Card's "Job Notes" quick action (a fast add-only modal)
// and the Diary screen's full Notes list, so both read/write the exact same
// query instead of drifting apart.
export function useJobNotes(jobCardId: string) {
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const { data: notes } = useQuery<JobNote>(
    "SELECT * FROM job_notes WHERE job_card_id = ? ORDER BY created_at DESC",
    [jobCardId]
  );

  const [noteText, setNoteText] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);

  const addNote = async () => {
    const result = createJobNoteSchema.safeParse({ job_card_id: jobCardId, body: noteText });
    if (!result.success) {
      setNoteError(result.error.issues[0]?.message ?? "Note can't be empty");
      return false;
    }
    if (!profile) return false;

    await powersync.execute(
      "INSERT INTO job_notes (id, tenant_id, job_card_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [uuidv4(), profile.tenant_id, jobCardId, profile.id, result.data.body, new Date().toISOString()]
    );
    setNoteText("");
    setNoteError(null);
    return true;
  };

  return { notes, noteText, setNoteText, noteError, addNote };
}

import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { useAuth } from "../lib/auth-context";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { attachMessageToJob, type AttachSource } from "../lib/attach-to-job";
import { ThemedPickerModal } from "./theme/ThemedPickerModal";

// Choose an existing job to attach a message to (see lib/attach-to-job.ts).
// The sender's own client's jobs are listed first, then the newest 1000
// jobs; the picker's search box filters by number, title or client.

type JobOption = { id: string; number: string | null; title: string; client_id: string; clients: { name: string } | null };

export function AttachToJobPicker(props: {
  visible: boolean;
  source: AttachSource | null;
  clientId?: string | null;
  email?: string | null;
  currentJobId?: string | null;
  onClose: () => void;
  onAttached?: () => void;
}) {
  const { profile } = useAuth();
  const [jobs, setJobs] = useState<JobOption[]>([]);

  useEffect(() => {
    if (!props.visible) return;
    let cancelled = false;
    (async () => {
      const [jobResult, clientResult] = await Promise.all([
        supabase.from("job_cards").select("id, number, title, client_id, clients(name)").order("created_at", { ascending: false }).limit(1000),
        props.email ? supabase.from("clients").select("id").ilike("email", props.email) : Promise.resolve({ data: [] as { id: string }[] }),
      ]);
      const clientIds = new Set<string>([...(clientResult.data ?? []).map((c) => c.id), ...(props.clientId ? [props.clientId] : [])]);
      const all = ((jobResult.data ?? []) as unknown as JobOption[]).filter((j) => j.id !== props.currentJobId);
      if (!cancelled) setJobs([...all.filter((j) => clientIds.has(j.client_id)), ...all.filter((j) => !clientIds.has(j.client_id))]);
    })();
    return () => {
      cancelled = true;
    };
  }, [props.visible, props.email, props.clientId, props.currentJobId]);

  const attach = (job: JobOption) => {
    if (!profile || !props.source) return;
    const source = props.source;
    Alert.alert(`Attach to ${job.number ?? "this job"}?`, "It's added to the job as a note, and any attachments or voicemail go into the job's files.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Attach",
        onPress: async () => {
          try {
            const result = await attachMessageToJob(source, job.id, profile);
            Alert.alert("Attached", `Added to ${result.jobNumber ?? "the job"}.`);
            props.onAttached?.();
          } catch (e) {
            Alert.alert("Couldn't attach", getErrorMessage(e, "Failed to attach to the job"));
          }
        },
      },
    ]);
  };

  return (
    <ThemedPickerModal
      visible={props.visible}
      title="Attach to which job?"
      items={jobs}
      getKey={(j) => j.id}
      getLabel={(j) => `${j.number ?? "-"} · ${j.title} · ${j.clients?.name ?? "Unknown client"}`}
      onSelect={attach}
      onClose={props.onClose}
    />
  );
}

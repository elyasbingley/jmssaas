import { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { createClientSchema, type Client, type InboxAttachment, type InboxMessage, type JobCard } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { useIsOnline } from "../../lib/connectivity";
import { useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../lib/errors";
import { FormField } from "../../components/FormField";
import { PickerModal } from "../../components/PickerModal";
import { RequiresConnectionNotice } from "../../components/RequiresConnectionNotice";

const ATTACHMENT_BUCKET = "inbox-attachments";
const JOB_FILES_BUCKET = "job-files";

type JobWithClient = JobCard & { clients: { name: string } | null };

// Same copy-not-reference approach as desktop's InboxMessage.tsx: job_files
// rows always point into job-files (JobDetail.tsx hardcodes it), so a
// message's attachments need an actual copy out of the private
// inbox-attachments bucket, not just a new row pointing at the old path.
// download()/.arrayBuffer() then upload() is the same round-trip
// SupabaseRemoteStorageAdapter in lib/attachments.ts uses for job photos.
async function copyAttachmentsToJob(params: { attachments: InboxAttachment[]; tenantId: string; jobCardId: string; uploadedBy: string }) {
  for (const attachment of params.attachments) {
    const { data: blob, error: downloadError } = await supabase.storage.from(ATTACHMENT_BUCKET).download(attachment.storage_path);
    if (downloadError || !blob) throw downloadError ?? new Error(`Failed to download ${attachment.file_name}`);
    const bytes = await blob.arrayBuffer();

    const storagePath = `${params.tenantId}/${params.jobCardId}/${crypto.randomUUID()}-${attachment.file_name}`;
    const { error: uploadError } = await supabase.storage
      .from(JOB_FILES_BUCKET)
      .upload(storagePath, bytes, { contentType: attachment.mime_type ?? undefined });
    if (uploadError) throw uploadError;

    const { error: insertError } = await supabase.from("job_files").insert({
      tenant_id: params.tenantId,
      job_card_id: params.jobCardId,
      storage_path: storagePath,
      file_name: attachment.file_name,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      uploaded_by: params.uploadedBy,
    });
    if (insertError) throw insertError;
  }
}

export default function InboxMessageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();

  const { data: message, refetch: refetchMessage } = useSupabaseFetch<InboxMessage | null>(async () => {
    if (!isOnline) return null;
    const { data, error } = await supabase.from("inbox_messages").select("*").eq("id", id).single();
    if (error) throw error;
    return data as InboxMessage;
  }, [isOnline, id]);
  const { data: attachments } = useSupabaseFetch<InboxAttachment[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("inbox_attachments").select("*").eq("message_id", id);
    if (error) throw error;
    return data as InboxAttachment[];
  }, [isOnline, id]);
  const { data: clients } = useSupabaseFetch<Client[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("clients").select("*").order("name");
    if (error) throw error;
    return data as Client[];
  }, [isOnline]);
  const { data: jobs } = useSupabaseFetch<JobWithClient[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("job_cards").select("*, clients(name)").order("created_at", { ascending: false }).limit(200);
    if (error) throw error;
    return data as JobWithClient[];
  }, [isOnline]);

  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        (attachments ?? []).map(async (a) => {
          const { data } = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUrl(a.storage_path, 3600);
          return [a.id, data?.signedUrl ?? ""] as const;
        })
      );
      if (!cancelled) setAttachmentUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [attachments]);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const dismiss = async () => {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    try {
      const { error } = await supabase.from("inbox_messages").update({ status: "dismissed" }).eq("id", id);
      if (error) throw error;
      router.back();
    } catch (e) {
      setActionError(getErrorMessage(e, "Failed to dismiss"));
    } finally {
      setBusy(false);
    }
  };

  const [jobPickerVisible, setJobPickerVisible] = useState(false);
  const [attachJob, setAttachJob] = useState<JobWithClient | null>(null);

  const attachToExisting = async () => {
    if (!profile || !attachJob) return;
    setBusy(true);
    setActionError(null);
    try {
      await copyAttachmentsToJob({ attachments: attachments ?? [], tenantId: profile.tenant_id, jobCardId: attachJob.id, uploadedBy: profile.id });
      const { error } = await supabase.from("inbox_messages").update({ status: "attached", linked_job_id: attachJob.id }).eq("id", id);
      if (error) throw error;
      await refetchMessage();
    } catch (e) {
      setActionError(getErrorMessage(e, "Failed to attach to job"));
    } finally {
      setBusy(false);
    }
  };

  // Prefilled from the AI-drafted suggestion when one exists (needs_review
  // messages), otherwise from the subject/body - same fallback desktop's
  // InboxMessage.tsx uses. Either way this form is what actually creates
  // the job, never the suggestion by itself (see the inbox migration).
  const suggestion = message?.parsed_job_suggestion ?? null;
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [clientPickerVisible, setClientPickerVisible] = useState(false);
  const [existingClient, setExistingClient] = useState<Client | null>(null);
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (suggestion) {
      setClientName(suggestion.client_name ?? "");
      setClientEmail(suggestion.client_email ?? "");
      setClientPhone(suggestion.client_phone ?? "");
      setJobTitle(suggestion.title ?? "");
      const addressParts = [suggestion.address_line1, suggestion.suburb, suggestion.state, suggestion.postcode].filter(Boolean).join(", ");
      setJobDescription([suggestion.description, addressParts ? `Address: ${addressParts}` : ""].filter(Boolean).join("\n\n"));
      setShowCreateForm(true);
    } else if (message) {
      setJobTitle(message.subject ?? "");
      setJobDescription(message.body_text ?? "");
    }
  }, [suggestion, message]);

  const createJob = async () => {
    if (!profile || !message) return;
    if (!jobTitle.trim()) {
      setCreateError("Title is required");
      return;
    }
    setBusy(true);
    setCreateError(null);
    try {
      let clientId = existingClient?.id ?? "";
      if (!clientId) {
        const result = createClientSchema.safeParse({ name: clientName, email: clientEmail, phone: clientPhone });
        if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Enter a client name");
        const { data: newClient, error: clientError } = await supabase
          .from("clients")
          .insert({ ...result.data, tenant_id: profile.tenant_id, created_by: profile.id })
          .select("id")
          .single();
        if (clientError) throw clientError;
        clientId = newClient.id;
      }

      const { data: job, error: jobError } = await supabase
        .from("job_cards")
        .insert({ tenant_id: profile.tenant_id, client_id: clientId, title: jobTitle.trim(), description: jobDescription || null, created_by: profile.id })
        .select("id")
        .single();
      if (jobError) throw jobError;

      await copyAttachmentsToJob({ attachments: attachments ?? [], tenantId: profile.tenant_id, jobCardId: job.id, uploadedBy: profile.id });
      const { error: updateError } = await supabase.from("inbox_messages").update({ status: "attached", linked_job_id: job.id }).eq("id", id);
      if (updateError) throw updateError;
      router.replace(`/sales/jobs/${job.id}`);
    } catch (e) {
      setCreateError(getErrorMessage(e, "Failed to create job"));
    } finally {
      setBusy(false);
    }
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Inbox" />
      </View>
    );
  }
  if (!message) {
    return <View style={styles.container} />;
  }

  const canAct = message.status === "unprocessed" || message.status === "needs_review";

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Text style={styles.title}>{message.subject || "(no subject)"}</Text>
      <Text style={styles.meta}>
        {message.from_name ? `${message.from_name} · ` : ""}
        {message.from_email} · {new Date(message.received_at).toLocaleString("en-AU")}
      </Text>
      {message.body_text ? <Text style={styles.body}>{message.body_text}</Text> : null}

      {attachments && attachments.length > 0 ? (
        <View style={styles.attachmentRow}>
          {attachments.map((a) => (
            <Pressable key={a.id} style={styles.attachmentChip} onPress={() => attachmentUrls[a.id] && Linking.openURL(attachmentUrls[a.id])}>
              <Text style={styles.attachmentChipText}>📎 {a.file_name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {!canAct ? (
        <Text style={styles.resolvedText}>
          {message.status === "attached" ? "Attached to a job." : "Dismissed."}
        </Text>
      ) : (
        <>
          {actionError ? <Text style={styles.error}>{actionError}</Text> : null}

          {attachments && attachments.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Attach to an existing job</Text>
              <Pressable style={styles.pickerField} onPress={() => setJobPickerVisible(true)}>
                <Text style={attachJob ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
                  {attachJob ? `${attachJob.title} - ${attachJob.clients?.name ?? "Unknown client"}` : "Select a job"}
                </Text>
              </Pressable>
              <Pressable style={[styles.button, !attachJob && styles.buttonDisabled]} disabled={!attachJob || busy} onPress={attachToExisting}>
                <Text style={styles.buttonText}>{busy ? "Attaching..." : "Attach"}</Text>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.section}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>{suggestion ? "AI-drafted job (review before creating)" : "Create a new job from this message"}</Text>
              {suggestion ? (
                <View style={styles.confidenceBadge}>
                  <Text style={styles.confidenceBadgeText}>{suggestion.confidence} confidence</Text>
                </View>
              ) : null}
            </View>
            {!showCreateForm ? (
              <Pressable onPress={() => setShowCreateForm(true)}>
                <Text style={styles.link}>+ New job</Text>
              </Pressable>
            ) : (
              <>
                <Pressable style={styles.pickerField} onPress={() => setClientPickerVisible(true)}>
                  <Text style={existingClient ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
                    {existingClient ? existingClient.name : "Use an existing client (optional)"}
                  </Text>
                </Pressable>
                {!existingClient ? (
                  <>
                    <FormField label="Client name" value={clientName} onChangeText={setClientName} />
                    <FormField label="Email (optional)" value={clientEmail} onChangeText={setClientEmail} keyboardType="email-address" autoCapitalize="none" />
                    <FormField label="Phone (optional)" value={clientPhone} onChangeText={setClientPhone} keyboardType="phone-pad" />
                  </>
                ) : null}
                <FormField label="Job title" value={jobTitle} onChangeText={setJobTitle} />
                <FormField
                  label="Description"
                  value={jobDescription}
                  onChangeText={setJobDescription}
                  multiline
                  style={styles.multiline}
                />
                {createError ? <Text style={styles.error}>{createError}</Text> : null}
                <Pressable style={styles.button} disabled={busy} onPress={createJob}>
                  <Text style={styles.buttonText}>{busy ? "Creating..." : "Create job"}</Text>
                </Pressable>
              </>
            )}
          </View>

          <Pressable onPress={dismiss} disabled={busy}>
            <Text style={styles.dismissLink}>Dismiss</Text>
          </Pressable>
        </>
      )}

      <PickerModal
        visible={jobPickerVisible}
        title="Select job"
        items={jobs ?? []}
        getKey={(j) => j.id}
        getLabel={(j) => `${j.title} - ${j.clients?.name ?? "Unknown client"}`}
        onSelect={setAttachJob}
        onClose={() => setJobPickerVisible(false)}
      />
      <PickerModal
        visible={clientPickerVisible}
        title="Select client"
        items={clients ?? []}
        getKey={(c) => c.id}
        getLabel={(c) => c.company_name || c.name}
        onSelect={setExistingClient}
        onClose={() => setClientPickerVisible(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  title: { fontSize: 19, fontWeight: "700", color: "#111827" },
  meta: { fontSize: 13, color: "#6b7280", marginTop: 4, marginBottom: 12 },
  body: { fontSize: 14, color: "#374151", lineHeight: 20, marginBottom: 12 },
  attachmentRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  attachmentChip: { backgroundColor: "#f3f4f6", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  attachmentChipText: { fontSize: 13, fontWeight: "600", color: "#1d4ed8" },
  resolvedText: { fontSize: 14, color: "#6b7280" },
  section: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 12, padding: 14, gap: 10, marginBottom: 16 },
  sectionHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { fontSize: 12, fontWeight: "700", color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.4 },
  confidenceBadge: { backgroundColor: "#fef3c7", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  confidenceBadgeText: { fontSize: 11, fontWeight: "700", color: "#b45309" },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  pickerFieldText: { fontSize: 16, color: "#111827" },
  pickerFieldPlaceholder: { fontSize: 16, color: "#9ca3af" },
  multiline: { minHeight: 80, textAlignVertical: "top" },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingVertical: 12, alignItems: "center" },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontWeight: "700" },
  link: { color: "#1d4ed8", fontWeight: "600" },
  dismissLink: { color: "#dc2626", fontWeight: "600", textAlign: "center", marginTop: 4 },
  error: { color: "#dc2626", marginBottom: 4 },
});

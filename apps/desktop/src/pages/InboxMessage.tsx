import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createClientSchema, type Client, type InboxAttachment, type InboxMessage, type JobCard } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedFormField, ThemedSelectField, ThemedTextAreaField } from "../components/theme/ThemedFormField";
import { ThemedButton } from "../components/theme/ThemedButton";

const ATTACHMENT_BUCKET = "inbox-attachments";
const JOB_FILES_BUCKET = "job-files";

async function fetchMessage(id: string): Promise<InboxMessage> {
  const { data, error } = await supabase.from("inbox_messages").select("*").eq("id", id).single();
  if (error) throw error;
  return data as InboxMessage;
}
async function fetchAttachments(messageId: string): Promise<InboxAttachment[]> {
  const { data, error } = await supabase.from("inbox_attachments").select("*").eq("message_id", messageId);
  if (error) throw error;
  return data as InboxAttachment[];
}
async function fetchClients(): Promise<Client[]> {
  const { data, error } = await supabase.from("clients").select("*").order("name");
  if (error) throw error;
  return data as Client[];
}
async function fetchOpenJobs(): Promise<(JobCard & { clients: { name: string } | null })[]> {
  const { data, error } = await supabase.from("job_cards").select("*, clients(name)").order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  return data as (JobCard & { clients: { name: string } | null })[];
}

// Copies every attachment out of the private inbox-attachments bucket into
// job-files - job_files rows always point into that bucket (JobDetail.tsx
// hardcodes it, same as the reports_safety_engine migration's own comment
// on why report-files stays separate), so a message's files need an actual
// copy, not just a new row pointing at the old path.
async function copyAttachmentsToJob(params: {
  attachments: InboxAttachment[];
  tenantId: string;
  jobCardId: string;
  uploadedBy: string;
}) {
  for (const attachment of params.attachments) {
    const { data: blob, error: downloadError } = await supabase.storage.from(ATTACHMENT_BUCKET).download(attachment.storage_path);
    if (downloadError || !blob) throw downloadError ?? new Error(`Failed to download ${attachment.file_name}`);

    const storagePath = `${params.tenantId}/${params.jobCardId}/${crypto.randomUUID()}-${attachment.file_name}`;
    const { error: uploadError } = await supabase.storage
      .from(JOB_FILES_BUCKET)
      .upload(storagePath, blob, { contentType: attachment.mime_type ?? undefined });
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

export default function InboxMessagePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: message } = useQuery({ queryKey: ["inbox-message", id], queryFn: () => fetchMessage(id!), enabled: !!id });
  const { data: attachments } = useQuery({ queryKey: ["inbox-attachments", id], queryFn: () => fetchAttachments(id!), enabled: !!id });
  const { data: clients } = useQuery({ queryKey: ["clients-for-inbox"], queryFn: fetchClients });
  const { data: jobs } = useQuery({ queryKey: ["jobs-for-inbox"], queryFn: fetchOpenJobs });

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

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["inbox-message", id] });
    queryClient.invalidateQueries({ queryKey: ["inbox-messages"] });
  };

  const dismiss = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("inbox_messages").update({ status: "dismissed" }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      navigate("/inbox");
    },
  });

  const [attachJobId, setAttachJobId] = useState("");
  const [attachError, setAttachError] = useState<string | null>(null);

  const attachToExisting = useMutation({
    mutationFn: async () => {
      if (!profile || !message || !attachJobId) throw new Error("Pick a job first");
      await copyAttachmentsToJob({ attachments: attachments ?? [], tenantId: profile.tenant_id, jobCardId: attachJobId, uploadedBy: profile.id });
      const { error } = await supabase.from("inbox_messages").update({ status: "attached", linked_job_id: attachJobId }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      setAttachError(null);
    },
    onError: (e) => setAttachError(getErrorMessage(e, "Failed to attach to job")),
  });

  // Prefilled from the AI-drafted suggestion when one exists (needs_review
  // messages), otherwise blank - either way this form is what actually
  // creates the job, never the suggestion by itself (see the inbox
  // migration's own comment on why).
  const suggestion = message?.parsed_job_suggestion ?? null;
  const [existingClientId, setExistingClientId] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

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

  const createJob = useMutation({
    mutationFn: async () => {
      if (!profile || !message) throw new Error("Not signed in");
      if (!jobTitle.trim()) throw new Error("Title is required");

      let clientId = existingClientId;
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
      return job.id as string;
    },
    onSuccess: (jobId) => {
      invalidate();
      navigate(`/jobs/${jobId}`);
    },
    onError: (e) => setCreateError(getErrorMessage(e, "Failed to create job")),
  });

  if (!message) {
    return (
      <div className="p-8" style={{ color: "var(--jms-text-muted)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}>
        Loading...
      </div>
    );
  }

  const canAct = message.status === "unprocessed" || message.status === "needs_review";

  return (
    <div className="mx-auto max-w-3xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/inbox" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Inbox
      </Link>

      <div className="mb-6 rounded p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <h1 className="font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-title)" }}>
          {message.subject || "(no subject)"}
        </h1>
        <p className="mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          {message.from_name ? `${message.from_name} · ` : ""}
          {message.from_email} &middot; {new Date(message.received_at).toLocaleString("en-AU")}
        </p>
        {message.body_text ? (
          <p className="whitespace-pre-wrap" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            {message.body_text}
          </p>
        ) : null}

        {attachments && attachments.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {attachments.map((a) => (
              <a
                key={a.id}
                href={attachmentUrls[a.id] || undefined}
                target="_blank"
                rel="noreferrer"
                className="rounded px-3 py-1.5 font-semibold"
                style={{ border: "1px solid var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
              >
                📎 {a.file_name}
              </a>
            ))}
          </div>
        ) : null}
      </div>

      {!canAct ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          {message.status === "attached" ? (
            <>
              Attached to{" "}
              <Link to={`/jobs/${message.linked_job_id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                this job
              </Link>
              .
            </>
          ) : (
            "Dismissed."
          )}
        </p>
      ) : (
        <>
          {attachments && attachments.length > 0 ? (
            <div className="mb-6 rounded p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
              <h2 className="mb-3 font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
                Attach to an existing job
              </h2>
              <ThemedSelectField
                label="Job"
                value={attachJobId}
                onChange={setAttachJobId}
                options={(jobs ?? []).map((j) => ({ value: j.id, label: `${j.title} - ${j.clients?.name ?? "Unknown client"}` }))}
                placeholder="Select a job"
              />
              {attachError ? (
                <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
                  {attachError}
                </p>
              ) : null}
              <ThemedButton onClick={() => attachToExisting.mutate()} disabled={!attachJobId || attachToExisting.isPending}>
                {attachToExisting.isPending ? "Attaching..." : "Attach"}
              </ThemedButton>
            </div>
          ) : null}

          <div className="mb-6 rounded p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
                {suggestion ? "AI-drafted job (review before creating)" : "Create a new job from this message"}
              </h2>
              {suggestion ? (
                <span
                  className="rounded-full border px-2 py-0.5 font-semibold"
                  style={{ borderColor: "var(--jms-warning)", color: "var(--jms-warning)", fontSize: "var(--jms-font-label)" }}
                >
                  {suggestion.confidence} confidence
                </span>
              ) : null}
              {!showCreateForm ? (
                <button onClick={() => setShowCreateForm(true)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
                  + New job
                </button>
              ) : null}
            </div>

            {showCreateForm ? (
              <>
                <ThemedSelectField
                  label="Use an existing client (optional)"
                  value={existingClientId}
                  onChange={setExistingClientId}
                  options={(clients ?? []).map((c) => ({ value: c.id, label: c.company_name || c.name }))}
                  placeholder="Create a new client below"
                />
                {!existingClientId ? (
                  <>
                    <ThemedFormField label="Client name" value={clientName} onChange={(e) => setClientName(e.target.value)} />
                    <div className="grid grid-cols-2 gap-3">
                      <ThemedFormField label="Email (optional)" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} />
                      <ThemedFormField label="Phone (optional)" value={clientPhone} onChange={(e) => setClientPhone(e.target.value)} />
                    </div>
                  </>
                ) : null}
                <ThemedFormField label="Job title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
                <ThemedTextAreaField label="Description" rows={4} value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} />
                {createError ? (
                  <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
                    {createError}
                  </p>
                ) : null}
                <ThemedButton onClick={() => createJob.mutate()} disabled={createJob.isPending}>
                  {createJob.isPending ? "Creating..." : "Create job"}
                </ThemedButton>
              </>
            ) : null}
          </div>

          <button onClick={() => dismiss.mutate()} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}

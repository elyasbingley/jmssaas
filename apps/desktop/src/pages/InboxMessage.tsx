import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { quickCreateClientSchema, type Client, type InboxAttachment, type InboxMessage } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedFormField, ThemedSelectField, ThemedTextAreaField } from "../components/theme/ThemedFormField";
import { ThemedButton } from "../components/theme/ThemedButton";
import { AttachToJobDialog } from "../components/AttachToJobDialog";
import { copyFilesToJob } from "../lib/attach-to-job";

const ATTACHMENT_BUCKET = "inbox-attachments";

type MessageWithJob = InboxMessage & { job_cards: { number: string | null; title: string } | null };

async function fetchMessage(id: string): Promise<MessageWithJob> {
  const { data, error } = await supabase.from("inbox_messages").select("*, job_cards(number, title)").eq("id", id).single();
  if (error) throw error;
  return data as MessageWithJob;
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
export default function InboxMessagePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: message } = useQuery({ queryKey: ["inbox-message", id], queryFn: () => fetchMessage(id!), enabled: !!id });
  const { data: attachments } = useQuery({ queryKey: ["inbox-attachments", id], queryFn: () => fetchAttachments(id!), enabled: !!id });
  const { data: clients } = useQuery({ queryKey: ["clients-for-inbox"], queryFn: fetchClients });

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

  const [attachOpen, setAttachOpen] = useState(false);

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
        const result = quickCreateClientSchema.safeParse({ name: clientName, email: clientEmail, phone: clientPhone });
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

      await copyFilesToJob({ bucket: ATTACHMENT_BUCKET, files: attachments ?? [], tenantId: profile.tenant_id, jobCardId: job.id, uploadedBy: profile.id });
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

      {attachOpen ? (
        <AttachToJobDialog
          source={{ kind: "inbox", messageId: message.id }}
          summary={`${message.from_name || message.from_email}: ${message.subject || "(no subject)"}`}
          email={message.from_email}
          currentJobId={message.linked_job_id}
          onClose={() => setAttachOpen(false)}
        />
      ) : null}

      {!canAct ? (
        <div className="flex flex-wrap items-center gap-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          <span>
            {message.status === "attached" && message.linked_job_id ? (
              <>
                Attached to{" "}
                <Link to={`/jobs/${message.linked_job_id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                  {message.job_cards ? `${message.job_cards.number ?? "job"} - ${message.job_cards.title}` : "a job"}
                </Link>
                .
              </>
            ) : message.status === "attached" ? (
              "Attached to a job that has since been deleted."
            ) : (
              "Dismissed."
            )}
          </span>
          <button onClick={() => setAttachOpen(true)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)" }}>
            {message.status === "attached" ? "Attach to another job" : "Attach to a job"}
          </button>
        </div>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
            <div>
              <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
                Attach to an existing job
              </h2>
              <p className="mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                Adds this email to the job as a note{attachments && attachments.length > 0 ? `, and its ${attachments.length === 1 ? "attachment" : `${attachments.length} attachments`} to the job's files` : ""}.
              </p>
            </div>
            <ThemedButton onClick={() => setAttachOpen(true)}>Choose job</ThemedButton>
          </div>

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

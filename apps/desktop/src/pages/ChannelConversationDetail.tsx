import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  createClientSchema,
  splitTextWithLinks,
  type ChannelConversation,
  type ChannelMessage,
  type InboxMessage,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { sendChannelMessage, type ChannelMediaAttachment } from "../lib/channels";
import { uploadChannelMedia } from "../lib/uploads";
import { ThemedFormField, ThemedTextAreaField } from "../components/theme/ThemedFormField";
import { ThemedButton } from "../components/theme/ThemedButton";
import { decodeEmailConversationId } from "./Channels";

const CHANNEL_ICONS: Record<string, string> = { sms: "💬", whatsapp: "🟢", messenger: "🔵", instagram: "📷" };
const CHANNEL_LABELS: Record<string, string> = { sms: "SMS", whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" };

// Renders a message body with any http(s) URLs (splitTextWithLinks, shared
// with mobile) as clickable links - a bare URL in plain text isn't
// clickable in a browser either without this.
function LinkifiedText({ body }: { body: string }) {
  return (
    <p className="whitespace-pre-wrap">
      {splitTextWithLinks(body).map((seg, i) =>
        seg.isUrl ? (
          <a key={i} href={seg.text} target="_blank" rel="noreferrer" className="underline" style={{ color: "var(--jms-accent)" }}>
            {seg.text}
          </a>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </p>
  );
}

async function fetchConversation(id: string): Promise<ChannelConversation & { clients: { id: string; name: string } | null }> {
  const { data, error } = await supabase.from("channel_conversations").select("*, clients(id, name)").eq("id", id).single();
  if (error) throw error;
  return data as ChannelConversation & { clients: { id: string; name: string } | null };
}
async function fetchMessages(conversationId: string): Promise<ChannelMessage[]> {
  const { data, error } = await supabase.from("channel_messages").select("*").eq("conversation_id", conversationId).order("created_at");
  if (error) throw error;
  return data as ChannelMessage[];
}
async function fetchInboxMessagesFor(email: string): Promise<InboxMessage[]> {
  const { data, error } = await supabase.from("inbox_messages").select("*").eq("from_email", email).order("received_at", { ascending: false });
  if (error) throw error;
  return data as InboxMessage[];
}

// Shared by both the real-channel and virtual-email panels below - "make
// a job/task from this conversation" is the same idea Inbox's own
// InboxMessage.tsx create-job form already covers, just triggered from a
// different screen and (for a real channel) matching by phone instead of
// email.
function CreateJobTaskSection(props: {
  prefillName: string;
  prefillEmail: string;
  prefillPhone: string;
  prefillTitle: string;
  prefillDescription: string;
  onClientLinked?: (clientId: string) => void;
}) {
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [clientName, setClientName] = useState(props.prefillName);
  const [jobTitle, setJobTitle] = useState(props.prefillTitle);
  const [jobDescription, setJobDescription] = useState(props.prefillDescription);
  const [error, setError] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [jobCreatedId, setJobCreatedId] = useState<string | null>(null);
  const [taskCreated, setTaskCreated] = useState(false);

  const createJob = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const result = createClientSchema.safeParse({ name: clientName, email: props.prefillEmail, phone: props.prefillPhone });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Enter a name");
      if (!jobTitle.trim()) throw new Error("Title is required");

      const { data: newClient, error: clientError } = await supabase
        .from("clients")
        .insert({ ...result.data, tenant_id: profile.tenant_id, created_by: profile.id })
        .select("id")
        .single();
      if (clientError) throw clientError;

      const { data: job, error: jobError } = await supabase
        .from("job_cards")
        .insert({ tenant_id: profile.tenant_id, client_id: newClient.id, title: jobTitle.trim(), description: jobDescription || null, created_by: profile.id })
        .select("id")
        .single();
      if (jobError) throw jobError;

      props.onClientLinked?.(newClient.id);
      return job.id as string;
    },
    onSuccess: (jobId) => setJobCreatedId(jobId),
    onError: (e) => setError(getErrorMessage(e, "Failed to create job")),
  });

  const createTask = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      if (!jobTitle.trim()) throw new Error("Title is required");
      const { error: taskInsertError } = await supabase.from("tasks").insert({
        tenant_id: profile.tenant_id,
        title: jobTitle.trim(),
        description: jobDescription || null,
        status: "todo",
        priority: "medium",
        created_by: profile.id,
      });
      if (taskInsertError) throw taskInsertError;
    },
    onSuccess: () => setTaskCreated(true),
    onError: (e) => setTaskError(getErrorMessage(e, "Failed to create task")),
  });

  if (jobCreatedId) {
    return (
      <div className="rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
        Job created.{" "}
        <Link to={`/jobs/${jobCreatedId}`} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)" }}>
          View job
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
      {!open ? (
        <div className="flex gap-3">
          <button onClick={() => setOpen(true)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
            + Create job
          </button>
          <button
            onClick={() => createTask.mutate()}
            disabled={createTask.isPending}
            className="font-semibold hover:underline disabled:opacity-60"
            style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
          >
            {createTask.isPending ? "Creating..." : "+ Create task"}
          </button>
        </div>
      ) : (
        <>
          <h2 className="mb-3 font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
            Create a job from this conversation
          </h2>
          <ThemedFormField label="Client name" value={clientName} onChange={(e) => setClientName(e.target.value)} />
          <ThemedFormField label="Job title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
          <ThemedTextAreaField label="Description" rows={4} value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} />
          {error ? (
            <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-3">
            <button onClick={() => setOpen(false)} className="px-3 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              Cancel
            </button>
            <ThemedButton onClick={() => createJob.mutate()} disabled={createJob.isPending}>
              {createJob.isPending ? "Creating..." : "Create job"}
            </ThemedButton>
          </div>
        </>
      )}
      {taskCreated ? (
        <p className="mt-2" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
          Task created.
        </p>
      ) : null}
      {taskError ? (
        <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {taskError}
        </p>
      ) : null}
    </div>
  );
}

function RealConversationDetail({ conversationId }: { conversationId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: conversation } = useQuery({ queryKey: ["channel-conversation", conversationId], queryFn: () => fetchConversation(conversationId) });
  const { data: messages } = useQuery({ queryKey: ["channel-messages", conversationId], queryFn: () => fetchMessages(conversationId) });

  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries: [string, string][] = [];
      for (const m of messages ?? []) {
        for (const media of m.media) {
          const { data } = await supabase.storage.from("channel-media").createSignedUrl(media.storage_path, 3600);
          if (data?.signedUrl) entries.push([media.storage_path, data.signedUrl]);
        }
      }
      if (!cancelled) setMediaUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [messages]);

  useEffect(() => {
    if (conversation && conversation.unread_count > 0) {
      supabase
        .from("channel_conversations")
        .update({ unread_count: 0 })
        .eq("id", conversationId)
        .then(() => queryClient.invalidateQueries({ queryKey: ["channel-conversations"] }));
    }
  }, [conversation?.id]);

  const { profile } = useAuth();
  const [reply, setReply] = useState("");
  const [attachment, setAttachment] = useState<ChannelMediaAttachment | null>(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const handleAttach = async (file: File) => {
    if (!profile) return;
    setUploadingAttachment(true);
    setSendError(null);
    try {
      const uploaded = await uploadChannelMedia({ tenantId: profile.tenant_id, conversationId, file });
      setAttachment({ storage_path: uploaded.storagePath, file_name: uploaded.fileName, mime_type: uploaded.mimeType });
    } catch (e) {
      setSendError(getErrorMessage(e, "Failed to attach file"));
    } finally {
      setUploadingAttachment(false);
    }
  };

  const send = useMutation({
    mutationFn: () => sendChannelMessage(conversationId, reply.trim(), attachment ?? undefined),
    onSuccess: () => {
      setReply("");
      setAttachment(null);
      setSendError(null);
      queryClient.invalidateQueries({ queryKey: ["channel-messages", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["channel-conversations"] });
    },
    onError: (e) => setSendError(getErrorMessage(e, "Failed to send")),
  });

  if (!conversation)
    return (
      <div className="p-5" style={{ color: "var(--jms-text-muted)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}>
        Loading...
      </div>
    );

  const canSend = conversation.channel_type === "sms" || conversation.channel_type === "whatsapp" || conversation.channel_type === "messenger";
  const title = conversation.clients?.name || conversation.contact_name || conversation.external_contact;

  return (
    <div className="flex h-full flex-col" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="p-5" style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)" }}>
        <button onClick={() => navigate("/channels")} className="mb-2 hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
          &larr; Back to Channels
        </button>
        <h1 className="font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-title)" }}>
          {CHANNEL_ICONS[conversation.channel_type]} {title}
        </h1>
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          {CHANNEL_LABELS[conversation.channel_type]} &middot; {conversation.external_contact}
        </p>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-5">
        {(messages ?? []).map((m) => (
          <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
            <div
              className="max-w-[80%] rounded-lg px-3 py-2"
              style={
                m.direction === "outbound"
                  ? { backgroundColor: "var(--jms-accent-glow)", border: "1px solid var(--jms-accent)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }
                  : { backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }
              }
            >
              {m.body ? <LinkifiedText body={m.body} /> : null}
              {m.media.map((media) =>
                mediaUrls[media.storage_path] ? (
                  <a
                    key={media.storage_path}
                    href={mediaUrls[media.storage_path]}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block underline"
                    style={{ color: "var(--jms-accent)" }}
                  >
                    📎 {media.file_name}
                  </a>
                ) : null
              )}
              <p className="mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                {new Date(m.created_at).toLocaleString("en-AU")}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="p-4" style={{ borderTop: "1px solid var(--jms-border)" }}>
        {canSend ? (
          <>
            {attachment ? (
              <div
                className="mb-2 flex items-center gap-2 rounded px-3 py-1.5"
                style={{ backgroundColor: "var(--jms-surface)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
              >
                <span className="flex-1 truncate">📎 {attachment.file_name}</span>
                <button onClick={() => setAttachment(null)} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)" }}>
                  Remove
                </button>
              </div>
            ) : null}
            <div className="flex gap-2">
              <label
                className="flex cursor-pointer items-center rounded px-3 text-lg"
                style={{ border: "1px solid var(--jms-border)", color: "var(--jms-text-muted)" }}
              >
                📎
                <input
                  type="file"
                  className="hidden"
                  disabled={uploadingAttachment}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleAttach(file);
                    e.target.value = "";
                  }}
                />
              </label>
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={2}
                placeholder="Type a reply..."
                className="flex-1 rounded border px-3 py-2 focus:outline-none"
                style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
              />
              <ThemedButton onClick={() => send.mutate()} disabled={send.isPending || uploadingAttachment || (!reply.trim() && !attachment)}>
                {send.isPending ? "Sending..." : uploadingAttachment ? "Attaching..." : "Send"}
              </ThemedButton>
            </div>
            {sendError ? (
              <p className="mt-1" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
                {sendError}
              </p>
            ) : null}
          </>
        ) : (
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Sending isn't available on {CHANNEL_LABELS[conversation.channel_type]} yet - see Settings &gt; Channels.
          </p>
        )}
      </div>

      <div className="p-4" style={{ borderTop: "1px solid var(--jms-border)" }}>
        <CreateJobTaskSection
          prefillName={conversation.clients?.name || conversation.contact_name || ""}
          prefillEmail=""
          prefillPhone={conversation.channel_type === "sms" || conversation.channel_type === "whatsapp" ? conversation.external_contact : ""}
          prefillTitle=""
          prefillDescription=""
          onClientLinked={(clientId) => {
            supabase.from("channel_conversations").update({ client_id: clientId }).eq("id", conversationId).then();
          }}
        />
      </div>
    </div>
  );
}

function EmailConversationDetail({ email }: { email: string }) {
  const navigate = useNavigate();
  const { data: messages } = useQuery({ queryKey: ["inbox-messages-for-email", email], queryFn: () => fetchInboxMessagesFor(email) });
  const latest = messages?.[0];

  return (
    <div className="flex h-full flex-col" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="p-5" style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)" }}>
        <button onClick={() => navigate("/channels")} className="mb-2 hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
          &larr; Back to Channels
        </button>
        <h1 className="font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-title)" }}>
          ✉️ {latest?.from_name || email}
        </h1>
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>Email &middot; {email}</p>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-5">
        {(messages ?? []).map((m) => (
          <div key={m.id} className="rounded-lg p-3" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
            <div className="mb-1 flex items-center justify-between">
              <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                {m.subject || "(no subject)"}
              </p>
              <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{new Date(m.received_at).toLocaleString("en-AU")}</p>
            </div>
            {m.body_text ? (
              <p className="whitespace-pre-wrap" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                {m.body_text}
              </p>
            ) : null}
            <Link to={`/inbox/${m.id}`} className="mt-2 inline-block font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
              Open in Inbox &rarr;
            </Link>
          </div>
        ))}
      </div>

      <div className="p-4" style={{ borderTop: "1px solid var(--jms-border)" }}>
        <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          Replying, attaching files, and AI-drafted job suggestions all still happen from the Inbox screen - open a
          message above to use them.
        </p>
        <CreateJobTaskSection
          prefillName={latest?.from_name || ""}
          prefillEmail={email}
          prefillPhone=""
          prefillTitle={latest?.subject || ""}
          prefillDescription={latest?.body_text || ""}
        />
      </div>
    </div>
  );
}

export default function ChannelConversationDetailPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  const email = decodeEmailConversationId(id);
  if (email) return <EmailConversationDetail email={email} />;
  return <RealConversationDetail conversationId={id} />;
}

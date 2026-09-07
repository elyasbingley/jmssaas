import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  createClientSchema,
  type ChannelConversation,
  type ChannelMessage,
  type InboxMessage,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { sendChannelMessage } from "../lib/channels";
import { FormField, TextAreaField } from "../components/FormField";
import { decodeEmailConversationId } from "./Channels";

const CHANNEL_ICONS: Record<string, string> = { sms: "💬", whatsapp: "🟢", messenger: "🔵", instagram: "📷" };
const CHANNEL_LABELS: Record<string, string> = { sms: "SMS", whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" };

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
      <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700">
        Job created.{" "}
        <Link to={`/jobs/${jobCreatedId}`} className="font-semibold text-blue-700 hover:underline">
          View job
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      {!open ? (
        <div className="flex gap-3">
          <button onClick={() => setOpen(true)} className="text-sm font-semibold text-blue-700 hover:underline">
            + Create job
          </button>
          <button
            onClick={() => createTask.mutate()}
            disabled={createTask.isPending}
            className="text-sm font-semibold text-blue-700 hover:underline disabled:opacity-60"
          >
            {createTask.isPending ? "Creating..." : "+ Create task"}
          </button>
        </div>
      ) : (
        <>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Create a job from this conversation</h2>
          <FormField label="Client name" value={clientName} onChange={(e) => setClientName(e.target.value)} />
          <FormField label="Job title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
          <TextAreaField label="Description" rows={4} value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} />
          {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
          <div className="flex justify-end gap-3">
            <button onClick={() => setOpen(false)} className="px-3 py-2 text-sm font-semibold text-gray-600">
              Cancel
            </button>
            <button
              onClick={() => createJob.mutate()}
              disabled={createJob.isPending}
              className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {createJob.isPending ? "Creating..." : "Create job"}
            </button>
          </div>
        </>
      )}
      {taskCreated ? <p className="mt-2 text-sm text-green-700">Task created.</p> : null}
      {taskError ? <p className="mt-2 text-sm text-red-600">{taskError}</p> : null}
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

  const [reply, setReply] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () => sendChannelMessage(conversationId, reply.trim()),
    onSuccess: () => {
      setReply("");
      setSendError(null);
      queryClient.invalidateQueries({ queryKey: ["channel-messages", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["channel-conversations"] });
    },
    onError: (e) => setSendError(getErrorMessage(e, "Failed to send")),
  });

  if (!conversation) return <div className="p-5 text-sm text-gray-500">Loading...</div>;

  const canSend = conversation.channel_type === "sms" || conversation.channel_type === "whatsapp";
  const title = conversation.clients?.name || conversation.contact_name || conversation.external_contact;

  return (
    <div className="flex h-full flex-col">
      <div className="bg-blue-700 p-5 text-white">
        <button onClick={() => navigate("/channels")} className="mb-2 text-sm text-blue-100 hover:underline">
          &larr; Back to Channels
        </button>
        <h1 className="text-lg font-bold">
          {CHANNEL_ICONS[conversation.channel_type]} {title}
        </h1>
        <p className="text-sm text-blue-100">
          {CHANNEL_LABELS[conversation.channel_type]} &middot; {conversation.external_contact}
        </p>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-5">
        {(messages ?? []).map((m) => (
          <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                m.direction === "outbound" ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-900"
              }`}
            >
              {m.body ? <p className="whitespace-pre-wrap">{m.body}</p> : null}
              {m.media.map((media) =>
                mediaUrls[media.storage_path] ? (
                  <a key={media.storage_path} href={mediaUrls[media.storage_path]} target="_blank" rel="noreferrer" className="mt-1 block underline">
                    📎 {media.file_name}
                  </a>
                ) : null
              )}
              <p className={`mt-1 text-xs ${m.direction === "outbound" ? "text-blue-100" : "text-gray-400"}`}>
                {new Date(m.created_at).toLocaleString("en-AU")}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-gray-200 p-4">
        {canSend ? (
          <>
            <div className="flex gap-2">
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={2}
                placeholder="Type a reply..."
                className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
              <button
                onClick={() => send.mutate()}
                disabled={send.isPending || !reply.trim()}
                className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
              >
                {send.isPending ? "Sending..." : "Send"}
              </button>
            </div>
            {sendError ? <p className="mt-1 text-sm text-red-600">{sendError}</p> : null}
          </>
        ) : (
          <p className="text-sm text-gray-500">
            Sending isn't available on {CHANNEL_LABELS[conversation.channel_type]} yet - see Settings &gt; Channels.
          </p>
        )}
      </div>

      <div className="border-t border-gray-200 p-4">
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
    <div className="flex h-full flex-col">
      <div className="bg-blue-700 p-5 text-white">
        <button onClick={() => navigate("/channels")} className="mb-2 text-sm text-blue-100 hover:underline">
          &larr; Back to Channels
        </button>
        <h1 className="text-lg font-bold">✉️ {latest?.from_name || email}</h1>
        <p className="text-sm text-blue-100">Email &middot; {email}</p>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-5">
        {(messages ?? []).map((m) => (
          <div key={m.id} className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-900">{m.subject || "(no subject)"}</p>
              <p className="text-xs text-gray-400">{new Date(m.received_at).toLocaleString("en-AU")}</p>
            </div>
            {m.body_text ? <p className="whitespace-pre-wrap text-sm text-gray-700">{m.body_text}</p> : null}
            <Link to={`/inbox/${m.id}`} className="mt-2 inline-block text-sm font-semibold text-blue-700 hover:underline">
              Open in Inbox &rarr;
            </Link>
          </div>
        ))}
      </div>

      <div className="border-t border-gray-200 p-4">
        <p className="mb-3 text-sm text-gray-500">
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

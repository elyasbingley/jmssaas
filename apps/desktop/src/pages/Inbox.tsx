import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { InboxAttachment, InboxMessage, InboxMessageStatus } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";

type Tab = "queue" | "attached" | "dismissed";

const TAB_STATUSES: Record<Tab, InboxMessageStatus[]> = {
  queue: ["unprocessed", "needs_review"],
  attached: ["attached"],
  dismissed: ["dismissed"],
};

const STATUS_LABELS: Record<InboxMessageStatus, string> = {
  unprocessed: "New",
  needs_review: "Needs review",
  attached: "Attached",
  dismissed: "Dismissed",
};
const STATUS_COLORS: Record<InboxMessageStatus, string> = {
  unprocessed: "bg-blue-100 text-blue-700",
  needs_review: "bg-amber-100 text-amber-700",
  attached: "bg-green-100 text-green-700",
  dismissed: "bg-gray-100 text-gray-500",
};

async function fetchMessages(): Promise<(InboxMessage & { inbox_attachments: InboxAttachment[] })[]> {
  const { data, error } = await supabase.from("inbox_messages").select("*, inbox_attachments(*)").order("received_at", { ascending: false });
  if (error) throw error;
  return data as (InboxMessage & { inbox_attachments: InboxAttachment[] })[];
}

export default function InboxPage() {
  const [tab, setTab] = useState<Tab>("queue");
  const { data: messages, isLoading } = useQuery({ queryKey: ["inbox-messages"], queryFn: fetchMessages });

  const filtered = useMemo(() => (messages ?? []).filter((m) => TAB_STATUSES[tab].includes(m.status)), [messages, tab]);
  const queueCount = useMemo(() => (messages ?? []).filter((m) => TAB_STATUSES.queue.includes(m.status)).length, [messages]);

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Inbox</h1>
        <p className="text-sm text-gray-500">
          Emails forwarded to your Inbox address - attach a file to a job, or review an AI-drafted job from a text request.
          See Settings &gt; Company Details for your Inbox address and forwarding instructions.
        </p>
      </div>

      <div className="mb-4 flex gap-1 border-b border-gray-200">
        {(["queue", "attached", "dismissed"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`border-b-2 px-4 py-2 text-sm font-semibold ${
              tab === t ? "border-blue-700 text-blue-700" : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t === "queue" ? `Queue${queueCount ? ` (${queueCount})` : ""}` : t === "attached" ? "Attached" : "Dismissed"}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing here.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          {filtered.map((message) => (
            <Link
              key={message.id}
              to={`/inbox/${message.id}`}
              className="flex items-center justify-between gap-4 border-b border-gray-100 px-4 py-3 last:border-0 hover:bg-gray-50"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-gray-900">{message.subject || "(no subject)"}</p>
                <p className="truncate text-sm text-gray-500">
                  {message.from_name ? `${message.from_name} · ` : ""}
                  {message.from_email}
                </p>
              </div>
              {message.inbox_attachments.length > 0 ? (
                <span className="flex-shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                  📎 {message.inbox_attachments.length}
                </span>
              ) : null}
              <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[message.status]}`}>
                {STATUS_LABELS[message.status]}
              </span>
              <span className="flex-shrink-0 text-xs text-gray-400">{new Date(message.received_at).toLocaleDateString("en-AU")}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

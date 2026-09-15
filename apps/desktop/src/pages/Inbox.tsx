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
// Status colours read from theme tokens - no fixed semantic hex needed
// here, this can shift with the tenant's chosen accent like everything
// else on the page.
const STATUS_COLOR_VAR: Record<InboxMessageStatus, string> = {
  unprocessed: "var(--jms-accent)",
  needs_review: "var(--jms-warning)",
  attached: "var(--jms-accent)",
  dismissed: "var(--jms-text-muted)",
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
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-6">
        <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
          Inbox
        </h1>
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Emails forwarded to your Inbox address - attach a file to a job, or review an AI-drafted job from a text request.
          See Settings &gt; Company Details for your Inbox address and forwarding instructions.
        </p>
      </div>

      <div className="mb-4 flex gap-1" style={{ borderBottom: "1px solid var(--jms-border)" }}>
        {(["queue", "attached", "dismissed"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="border-b-2 px-4 py-2 font-semibold"
            style={{
              borderColor: tab === t ? "var(--jms-accent)" : "transparent",
              color: tab === t ? "var(--jms-accent)" : "var(--jms-text-muted)",
              fontSize: "var(--jms-font-body)",
            }}
          >
            {t === "queue" ? `Queue${queueCount ? ` (${queueCount})` : ""}` : t === "attached" ? "Attached" : "Dismissed"}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Nothing here.</p>
      ) : (
        <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          {filtered.map((message) => (
            <Link
              key={message.id}
              to={`/inbox/${message.id}`}
              className="jms-nav-link flex items-center justify-between gap-4 px-4 py-3 last:border-0"
              style={{ borderBottom: "1px solid var(--jms-border)" }}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                  {message.subject || "(no subject)"}
                </p>
                <p className="truncate" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  {message.from_name ? `${message.from_name} · ` : ""}
                  {message.from_email}
                </p>
              </div>
              {message.inbox_attachments.length > 0 ? (
                <span
                  className="flex-shrink-0 rounded-full border px-2 py-0.5 font-semibold"
                  style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                >
                  📎 {message.inbox_attachments.length}
                </span>
              ) : null}
              <span
                className="flex-shrink-0 rounded-full border px-2 py-0.5 font-semibold"
                style={{ borderColor: STATUS_COLOR_VAR[message.status], color: STATUS_COLOR_VAR[message.status], fontSize: "var(--jms-font-label)" }}
              >
                {STATUS_LABELS[message.status]}
              </span>
              <span className="flex-shrink-0" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                {new Date(message.received_at).toLocaleDateString("en-AU")}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

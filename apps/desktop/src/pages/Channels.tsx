import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useMatch, useNavigate } from "react-router-dom";
import type { ChannelConversation, ChannelTypeOrEmail, InboxMessage } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { SidePanel } from "../components/SidePanel";

// Consolidates every way a client talks to the business into one list:
// real conversations (SMS live via Twilio; WhatsApp/Messenger/Instagram
// rows exist once connected - see channel_connections/Settings.tsx) plus
// a virtual "email" conversation per distinct sender, grouped here from
// the existing inbox_messages table rather than duplicated into a new
// one - see the channels migration's own comment on why. Clicking a row
// opens the same right-side-panel pattern Tasks.tsx uses (nested route +
// useMatch + <Outlet/>), now via the small shared SidePanel component.

const EMAIL_ID_PREFIX = "email:";
export function emailConversationId(fromEmail: string): string {
  return `${EMAIL_ID_PREFIX}${encodeURIComponent(fromEmail)}`;
}
export function decodeEmailConversationId(id: string): string | null {
  return id.startsWith(EMAIL_ID_PREFIX) ? decodeURIComponent(id.slice(EMAIL_ID_PREFIX.length)) : null;
}

interface UnifiedRow {
  id: string;
  channelType: ChannelTypeOrEmail;
  title: string;
  subtitle: string;
  preview: string | null;
  timestamp: string;
  unread: boolean;
}

const CHANNEL_ICONS: Record<ChannelTypeOrEmail, string> = {
  email: "✉️",
  sms: "💬",
  whatsapp: "🟢",
  messenger: "🔵",
  instagram: "📷",
};
const CHANNEL_LABELS: Record<ChannelTypeOrEmail, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
};

async function fetchConversations(): Promise<(ChannelConversation & { clients: { name: string } | null })[]> {
  const { data, error } = await supabase.from("channel_conversations").select("*, clients(name)").order("last_message_at", { ascending: false });
  if (error) throw error;
  return data as (ChannelConversation & { clients: { name: string } | null })[];
}

async function fetchInboxMessages(): Promise<InboxMessage[]> {
  const { data, error } = await supabase.from("inbox_messages").select("*").order("received_at", { ascending: false });
  if (error) throw error;
  return data as InboxMessage[];
}

export default function ChannelsPage() {
  const navigate = useNavigate();
  const drawerMatch = useMatch("/channels/:id");

  const { data: conversations, isLoading: conversationsLoading } = useQuery({ queryKey: ["channel-conversations"], queryFn: fetchConversations });
  const { data: inboxMessages, isLoading: inboxLoading } = useQuery({ queryKey: ["inbox-messages-for-channels"], queryFn: fetchInboxMessages });

  const [channelFilter, setChannelFilter] = useState<ChannelTypeOrEmail | "all">("all");
  const [search, setSearch] = useState("");

  const rows = useMemo((): UnifiedRow[] => {
    const realRows: UnifiedRow[] = (conversations ?? []).map((c) => ({
      id: c.id,
      channelType: c.channel_type,
      title: c.clients?.name || c.contact_name || c.external_contact,
      subtitle: c.external_contact,
      preview: c.last_message_preview,
      timestamp: c.last_message_at,
      unread: c.unread_count > 0,
    }));

    // Group inbox_messages by sender - most recent message represents the
    // "conversation" row; unread mirrors the same needs-review/unprocessed
    // queue Inbox itself surfaces.
    const emailBySender = new Map<string, InboxMessage[]>();
    for (const m of inboxMessages ?? []) {
      const list = emailBySender.get(m.from_email) ?? [];
      list.push(m);
      emailBySender.set(m.from_email, list);
    }
    const emailRows: UnifiedRow[] = [...emailBySender.entries()].map(([fromEmail, messages]) => {
      const latest = messages[0]!; // already sorted desc by received_at from the query
      return {
        id: emailConversationId(fromEmail),
        channelType: "email",
        title: latest.from_name || fromEmail,
        subtitle: fromEmail,
        preview: latest.subject || latest.body_text,
        timestamp: latest.received_at,
        unread: latest.status === "unprocessed" || latest.status === "needs_review",
      };
    });

    const merged = [...realRows, ...emailRows].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const trimmedSearch = search.trim().toLowerCase();
    return merged.filter((r) => {
      if (channelFilter !== "all" && r.channelType !== channelFilter) return false;
      if (trimmedSearch && !r.title.toLowerCase().includes(trimmedSearch) && !r.subtitle.toLowerCase().includes(trimmedSearch)) return false;
      return true;
    });
  }, [conversations, inboxMessages, channelFilter, search]);

  const isLoading = conversationsLoading || inboxLoading;

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col p-6">
        <div className="mb-4">
          <h1 className="text-xl font-bold text-gray-900">Channels</h1>
          <p className="text-sm text-gray-500">Every conversation with a client, in one place - reply, or turn one into a job or task.</p>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {(["all", "sms", "whatsapp", "messenger", "instagram", "email"] as (ChannelTypeOrEmail | "all")[]).map((f) => (
            <button
              key={f}
              onClick={() => setChannelFilter(f)}
              className={`rounded-full px-3 py-1.5 text-sm font-semibold ${channelFilter === f ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"}`}
            >
              {f === "all" ? "All" : `${CHANNEL_ICONS[f]} ${CHANNEL_LABELS[f]}`}
            </button>
          ))}
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ml-auto rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        {isLoading ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-gray-500">No conversations yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            {rows.map((row) => (
              <button
                key={row.id}
                onClick={() => navigate(`/channels/${row.id}`)}
                className="flex w-full items-center gap-3 border-b border-gray-100 px-4 py-3 text-left last:border-0 hover:bg-gray-50"
              >
                <span className="flex-shrink-0 text-xl">{CHANNEL_ICONS[row.channelType]}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`truncate font-semibold ${row.unread ? "text-gray-900" : "text-gray-700"}`}>{row.title}</span>
                    {row.unread ? <span className="h-2 w-2 flex-shrink-0 rounded-full bg-blue-600" /> : null}
                  </div>
                  <p className="truncate text-sm text-gray-500">{row.preview || row.subtitle}</p>
                </div>
                <span className="flex-shrink-0 text-xs text-gray-400">{new Date(row.timestamp).toLocaleDateString("en-AU")}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <SidePanel open={!!drawerMatch} onClose={() => navigate("/channels")}>
        <Outlet />
      </SidePanel>
    </div>
  );
}

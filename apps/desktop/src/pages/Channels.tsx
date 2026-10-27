import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useMatch, useNavigate } from "react-router-dom";
import type { ChannelConversation, ChannelTypeOrEmail, InboxMessage, Tenant } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { startChannelConversation } from "../lib/channels";
import { SidePanel } from "../components/SidePanel";
import { ThemedButton } from "../components/theme/ThemedButton";
import { SendSmsModal } from "../components/channels/SendSmsModal";

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

async function fetchTenant(tenantId: string): Promise<Tenant> {
  const { data, error } = await supabase.from("tenants").select("*").eq("id", tenantId).single();
  if (error) throw error;
  return data as Tenant;
}

export default function ChannelsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const drawerMatch = useMatch("/channels/:id");
  const { profile } = useAuth();

  const { data: conversations, isLoading: conversationsLoading } = useQuery({ queryKey: ["channel-conversations"], queryFn: fetchConversations });
  const { data: inboxMessages, isLoading: inboxLoading } = useQuery({ queryKey: ["inbox-messages-for-channels"], queryFn: fetchInboxMessages });
  const { data: tenant } = useQuery({
    queryKey: ["tenant", profile?.tenant_id],
    queryFn: () => fetchTenant(profile!.tenant_id),
    enabled: !!profile,
  });

  const [channelFilter, setChannelFilter] = useState<ChannelTypeOrEmail | "all">("all");
  const [search, setSearch] = useState("");

  // "+ New Message" - start a brand new outbound SMS or WhatsApp
  // conversation, either to an existing client or a manually-typed number
  // (SendSmsModal's own mode="picker"). Same "check the number's configured
  // before the modal ever opens" idea as QuoteDetail's "Send Quote via SMS"
  // button, now per channel - availableChannelTypes only lists the ones
  // the tenant has actually set up in Settings > Channels.
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const [newMessageError, setNewMessageError] = useState<string | null>(null);
  const [newMessageChannelType, setNewMessageChannelType] = useState<"sms" | "whatsapp">("sms");

  const availableNewMessageChannels = useMemo((): ("sms" | "whatsapp")[] => {
    const types: ("sms" | "whatsapp")[] = [];
    if (tenant?.sms_phone_number) types.push("sms");
    if (tenant?.whatsapp_phone_number) types.push("whatsapp");
    return types;
  }, [tenant]);

  const openNewMessage = () => {
    setNewMessageError(null);
    if (availableNewMessageChannels.length === 0) {
      setNewMessageError("Set up your SMS or WhatsApp number in Settings > Company Settings before sending a message");
      return;
    }
    setNewMessageChannelType(availableNewMessageChannels[0]!);
    setNewMessageOpen(true);
  };

  const handleSendNewMessage = async (payload: { phone: string; body: string; clientId?: string; contactName?: string }) => {
    const result = await startChannelConversation({
      channelType: newMessageChannelType,
      toPhone: payload.phone,
      body: payload.body,
      clientId: payload.clientId,
      contactName: payload.contactName,
    });
    queryClient.invalidateQueries({ queryKey: ["channel-conversations"] });
    navigate(`/channels/${result.conversationId}`);
  };

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
    <div className="flex h-full" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="flex min-w-0 flex-1 flex-col p-6">
        <div className="mb-4">
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            Channels
          </h1>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Every conversation with a client, in one place - reply, or turn one into a job or task.
          </p>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <ThemedButton onClick={openNewMessage} style={{ paddingBlock: 6, paddingInline: 14 }}>
            + New Message
          </ThemedButton>
          <Link
            to="/whatsapp-broadcast"
            className="jms-nav-link rounded border px-3 py-1.5 font-semibold"
            style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
          >
            📢 Broadcast
          </Link>
          {(["all", "sms", "whatsapp", "messenger", "instagram", "email"] as (ChannelTypeOrEmail | "all")[]).map((f) => (
            <button
              key={f}
              onClick={() => setChannelFilter(f)}
              className="rounded-full border px-3 py-1.5 font-semibold"
              style={
                channelFilter === f
                  ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                  : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
              }
            >
              {f === "all" ? "All" : `${CHANNEL_ICONS[f]} ${CHANNEL_LABELS[f]}`}
            </button>
          ))}
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ml-auto rounded border px-3 py-1.5 focus:outline-none"
            style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
          />
        </div>
        {newMessageError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {newMessageError}
          </p>
        ) : null}

        {isLoading ? (
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
        ) : rows.length === 0 ? (
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No conversations yet.</p>
        ) : (
          <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
            {rows.map((row) => (
              <button
                key={row.id}
                onClick={() => navigate(`/channels/${row.id}`)}
                className="jms-nav-link flex w-full items-center gap-3 px-4 py-3 text-left last:border-0"
                style={{ borderBottom: "1px solid var(--jms-border)" }}
              >
                <span className="flex-shrink-0 text-xl">{CHANNEL_ICONS[row.channelType]}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="truncate font-semibold"
                      style={{ color: row.unread ? "var(--jms-text)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
                    >
                      {row.title}
                    </span>
                    {row.unread ? <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: "var(--jms-accent)" }} /> : null}
                  </div>
                  <p className="truncate" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                    {row.preview || row.subtitle}
                  </p>
                </div>
                <span className="flex-shrink-0" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  {new Date(row.timestamp).toLocaleDateString("en-AU")}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <SidePanel open={!!drawerMatch} onClose={() => navigate("/channels")}>
        <Outlet />
      </SidePanel>

      <SendSmsModal
        open={newMessageOpen}
        onClose={() => setNewMessageOpen(false)}
        title="New message"
        sendLabel={newMessageChannelType === "whatsapp" ? "Send WhatsApp" : "Send SMS"}
        mode="picker"
        channelType={newMessageChannelType}
        onChannelTypeChange={setNewMessageChannelType}
        availableChannelTypes={availableNewMessageChannels}
        renderContextBase={
          tenant
            ? {
                company: {
                  name: tenant.name,
                  phone: tenant.phone,
                  email: tenant.email,
                  bank_account_name: tenant.bank_account_name,
                  bank_bsb: tenant.bank_bsb,
                  bank_account_number: tenant.bank_account_number,
                  google_review_link: tenant.google_review_link,
                },
              }
            : {}
        }
        onSend={handleSendNewMessage}
      />
    </div>
  );
}

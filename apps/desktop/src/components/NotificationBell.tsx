import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Notification } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";

// The top bar's bell: the same notifications the phone shows on its
// Notifications tab (notifications table - quote viewed/accepted, new
// messages and emails, website sign-ups, recurring jobs to book...), with
// an unread count. Opening one marks it read and goes to what it's about.

const KEY = ["notifications"];

// Where each kind of notification leads on the desktop.
function linkFor(n: Notification): string | null {
  const d = (n.data ?? {}) as unknown as Record<string, string | number | undefined>;
  switch (n.type) {
    case "channel_message":
      return d.conversation_id ? `/channels/${d.conversation_id}` : "/channels";
    case "inbox_message":
      return d.message_id ? `/inbox/${d.message_id}` : "/inbox";
    case "quote_accepted":
    case "quote_viewed":
      return d.quote_id ? `/quotes/${d.quote_id}` : "/quotes";
    case "invoice_accepted":
      return d.invoice_id ? `/invoices/${d.invoice_id}` : "/invoices";
    case "lead_signup":
      return d.job_card_id ? `/jobs/${d.job_card_id}` : "/jobs";
    case "recurring_jobs":
      return d.count === 1 && d.job_card_id ? `/jobs/${d.job_card_id}` : "/jobs";
    default:
      return null;
  }
}

const ICONS: Record<string, string> = {
  channel_message: "💬",
  inbox_message: "📥",
  quote_accepted: "✅",
  quote_viewed: "👀",
  invoice_accepted: "💲",
  lead_signup: "🙋",
  recurring_jobs: "🔁",
};

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export function NotificationBell() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: items } = useQuery({
    queryKey: [...KEY, profile?.id],
    enabled: !!profile,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("notifications").select("*").eq("profile_id", profile!.id).order("created_at", { ascending: false }).limit(40);
      if (error) throw error;
      return data as Notification[];
    },
  });
  const unread = (items ?? []).filter((n) => !n.read_at).length;

  const markRead = useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 0) return;
      const { error } = await supabase.from("notifications").update({ read_at: new Date().toISOString() }).in("id", ids);
      if (error) throw error;
    },
    onMutate: (ids) => {
      // Show them read straight away.
      queryClient.setQueryData<Notification[]>([...KEY, profile?.id], (old) => (old ?? []).map((n) => (ids.includes(n.id) ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n)));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const openOne = (n: Notification) => {
    if (!n.read_at) markRead.mutate([n.id]);
    const to = linkFor(n);
    setOpen(false);
    if (to) navigate(to);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-9 w-9 items-center justify-center rounded-full"
        style={{ color: open ? "var(--jms-accent)" : "var(--jms-text-muted)", backgroundColor: open ? "var(--jms-accent-glow)" : "transparent" }}
        aria-label={unread ? `Notifications (${unread} unread)` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Notifications"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 ? (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-bold"
            style={{ backgroundColor: "var(--jms-danger)", color: "#fff", fontSize: 10, lineHeight: 1 }}
            data-testid="notifications-badge"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-96 overflow-hidden rounded-lg"
          style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", boxShadow: "0 8px 24px rgba(0,0,0,0.35)" }}
          role="dialog"
          aria-label="Notifications"
          data-testid="notifications-panel"
        >
          <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: "1px solid var(--jms-border)" }}>
            <p className="font-semibold uppercase tracking-wide" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}>
              Notifications
            </p>
            {unread > 0 ? (
              <button
                onClick={() => markRead.mutate((items ?? []).filter((n) => !n.read_at).map((n) => n.id))}
                className="font-semibold hover:underline"
                style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
              >
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {!items ? (
              <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                Loading...
              </p>
            ) : items.length === 0 ? (
              <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                No notifications yet. You'll see quotes viewed and accepted, new messages and emails, website sign-ups and recurring jobs to book here.
              </p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => openOne(n)}
                  className="jms-nav-link flex w-full items-start gap-2 px-3 py-2 text-left"
                  style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: n.read_at ? "transparent" : "var(--jms-accent-glow)" }}
                  data-testid="notification-row"
                >
                  <span aria-hidden>{ICONS[n.type] ?? "🔔"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                      {n.title}
                    </span>
                    <span className="block" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                      {n.body}
                    </span>
                    <span className="block" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                      {ago(n.created_at)}
                    </span>
                  </span>
                  {!n.read_at ? <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: "var(--jms-accent)" }} aria-label="unread" /> : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

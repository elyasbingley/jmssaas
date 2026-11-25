import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { GlobalSearch } from "./GlobalSearch";
import { NotificationBell } from "./NotificationBell";
import { ThemedModal } from "./theme/ThemedModal";
import { ThemedButton } from "./theme/ThemedButton";

// The app shell, ServiceM8 style: one bar across the top with Dashboard,
// Jobs, Invoicing, Analytics and More (every other module lives on the More
// page and the Dashboard tiles), search, Inbox and Channels with unread
// counts, the notifications bell, and the signed-in person's menu.

const NAV: { to: string; label: string; match: (path: string) => boolean }[] = [
  { to: "/", label: "Dashboard", match: (p) => p === "/" },
  { to: "/jobs", label: "Jobs", match: (p) => p.startsWith("/jobs") },
  { to: "/invoices", label: "Invoicing", match: (p) => p.startsWith("/invoices") },
  { to: "/analytics", label: "Analytics", match: (p) => p.startsWith("/analytics") },
];
const isMore = (p: string) => p !== "/" && !NAV.some((n) => n.match(p));

function navClass(active: boolean) {
  return `rounded-md px-3 py-1.5 font-semibold whitespace-nowrap ${active ? "jms-nav-link-active" : "jms-nav-link"}`;
}

function IconLink({ to, label, count, children }: { to: string; label: string; count: number; children: ReactNode }) {
  const { pathname } = useLocation();
  const active = pathname.startsWith(to);
  return (
    <Link
      to={to}
      className="relative flex h-9 w-9 items-center justify-center rounded-full"
      style={{ color: active ? "var(--jms-accent)" : "var(--jms-text-muted)", backgroundColor: active ? "var(--jms-accent-glow)" : "transparent" }}
      aria-label={count ? `${label} (${count} unread)` : label}
      title={label}
    >
      {children}
      {count > 0 ? (
        <span
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-bold"
          style={{ backgroundColor: "var(--jms-danger)", color: "#fff", fontSize: 10, lineHeight: 1 }}
          data-testid={`${label.toLowerCase()}-badge`}
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}

function UserMenu() {
  const { profile, session, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);
  const name = profile?.full_name || session?.user.email || "Account";
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md px-2 py-1.5 font-semibold"
        style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="max-w-[12rem] truncate">{name}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg"
          style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", boxShadow: "0 8px 24px rgba(0,0,0,0.35)" }}
          role="menu"
        >
          <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--jms-border)" }}>
            <p className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
              {profile?.full_name}
            </p>
            <p className="truncate" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              {session?.user.email}
            </p>
          </div>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setChanging(true);
            }}
            className="jms-nav-link block w-full px-3 py-2 text-left"
            style={{ fontSize: "var(--jms-font-body)" }}
          >
            Change password
          </button>
          <button role="menuitem" onClick={() => void signOut()} className="jms-nav-link block w-full px-3 py-2 text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            Sign out
          </button>
        </div>
      ) : null}
      {changing ? <ChangePasswordModal onClose={() => setChanging(false)} /> : null}
    </div>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { session } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const inputStyle = { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
  const label = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;

  const save = async () => {
    setError(null);
    if (next.length < 8) return setError("Use at least 8 characters.");
    if (next !== confirm) return setError("The new passwords don't match.");
    if (next === current) return setError("Pick a password different from your current one.");
    const email = session?.user.email;
    if (!email) return setError("You're not signed in.");
    setSaving(true);
    try {
      // Check the current password first, so a computer left signed in
      // can't have its password changed by someone else.
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password: current });
      if (signInError) throw new Error("Your current password isn't right.");
      const { error: updateError } = await supabase.auth.updateUser({ password: next });
      if (updateError) throw updateError;
      setDone(true);
    } catch (e) {
      setError(getErrorMessage(e, "Couldn't change your password"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ThemedModal open onClose={onClose} title="Change password">
      {done ? (
        <div style={{ fontSize: "var(--jms-font-body)", color: "var(--jms-text)" }}>
          <p className="mb-4">Your password has been changed. Use it next time you sign in, on the desktop and the phone.</p>
          <ThemedButton onClick={onClose}>Done</ThemedButton>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="mb-1 block uppercase tracking-wide" style={label} htmlFor="pw-current">
            Current password
          </label>
          <input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className="mb-3 w-full rounded border px-3 py-2" style={inputStyle} />
          <label className="mb-1 block uppercase tracking-wide" style={label} htmlFor="pw-new">
            New password
          </label>
          <input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className="mb-3 w-full rounded border px-3 py-2" style={inputStyle} />
          <label className="mb-1 block uppercase tracking-wide" style={label} htmlFor="pw-confirm">
            New password again
          </label>
          <input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="mb-3 w-full rounded border px-3 py-2" style={inputStyle} />
          <p className="mb-3" style={label}>
            At least 8 characters.
          </p>
          {error ? <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{error}</p> : null}
          <div className="flex justify-end gap-2">
            <ThemedButton type="button" variant="secondary" onClick={onClose}>
              Cancel
            </ThemedButton>
            <ThemedButton type="submit" disabled={saving || !current || !next || !confirm}>
              {saving ? "Saving..." : "Change password"}
            </ThemedButton>
          </div>
        </form>
      )}
    </ThemedModal>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { profile } = useAuth();
  // Unread counts for the Inbox and Channels icons, refreshed every minute.
  const { data: counts } = useQuery({
    queryKey: ["topbar-unread", profile?.tenant_id],
    enabled: !!profile,
    refetchInterval: 60_000,
    queryFn: async () => {
      const [inbox, channels] = await Promise.all([
        supabase.from("inbox_messages").select("id", { count: "exact", head: true }).in("status", ["unprocessed", "needs_review"]),
        supabase.from("channel_conversations").select("unread_count").gt("unread_count", 0),
      ]);
      return {
        inbox: inbox.count ?? 0,
        channels: ((channels.data ?? []) as { unread_count: number }[]).reduce((sum, c) => sum + (c.unread_count ?? 0), 0),
      };
    },
  });

  return (
    <div className="flex min-h-screen flex-col" style={{ backgroundColor: "var(--jms-bg)", fontFamily: "var(--jms-font)" }}>
      <header
        className="sticky top-0 z-40 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2"
        style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
      >
        <Link to="/" className="mr-2 flex items-center gap-2 whitespace-nowrap" aria-label="Bingley Job Management - Dashboard">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-lg font-bold"
            style={{ backgroundColor: "var(--jms-accent)", color: "var(--jms-bg)", fontSize: 13 }}
            aria-hidden
          >
            JMS
          </span>
          <span className="hidden uppercase tracking-widest lg:inline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
            Bingley
          </span>
        </Link>
        <nav className="flex items-center gap-1" style={{ fontSize: "var(--jms-font-body)" }} aria-label="Main">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"} className={() => navClass(item.match(pathname))}>
              {item.label}
            </NavLink>
          ))}
          <NavLink to="/more" className={() => navClass(isMore(pathname))}>
            More
          </NavLink>
        </nav>
        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2">
          <GlobalSearch />
          <IconLink to="/inbox" label="Inbox" count={counts?.inbox ?? 0}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M22 12h-6l-2 3h-4l-2-3H2" />
              <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
            </svg>
          </IconLink>
          <IconLink to="/channels" label="Channels" count={counts?.channels ?? 0}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              <path d="M8 9h8M8 13h5" />
            </svg>
          </IconLink>
          <NotificationBell />
          <UserMenu />
        </div>
      </header>
      <main className="flex-1" style={{ backgroundColor: "var(--jms-bg)" }}>
        {children}
      </main>
    </div>
  );
}

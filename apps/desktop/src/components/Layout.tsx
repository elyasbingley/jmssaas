import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../lib/auth-context";
import { GlobalSearch } from "./GlobalSearch";

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

const navSections: { heading: string | null; items: NavItem[] }[] = [
  {
    heading: null,
    items: [
      { to: "/", label: "Dashboard", end: true },
      { to: "/channels", label: "Channels" },
      { to: "/inbox", label: "Inbox" },
      { to: "/dispatch", label: "Dispatch" },
      { to: "/tasks", label: "Tasks" },
      { to: "/knowledge", label: "Knowledge" },
      { to: "/reports", label: "Reports" },
    ],
  },
  {
    heading: "Sales",
    items: [
      { to: "/jobs", label: "Jobs" },
      { to: "/quotes", label: "Quotes" },
      { to: "/invoices", label: "Invoices" },
      { to: "/clients", label: "Clients" },
      { to: "/price-book", label: "Price Book" },
      { to: "/job-costing", label: "Job Costing" },
      { to: "/analytics", label: "Analytics" },
      { to: "/inventory", label: "Inventory" },
      { to: "/real-estate", label: "Real Estate & Strata" },
      { to: "/membership", label: "Membership" },
      { to: "/google-reviews", label: "Google Reviews" },
      { to: "/b2b-referrals", label: "B2B & Referrals" },
    ],
  },
  {
    heading: "Operations",
    items: [{ to: "/subcontractors", label: "Subcontractors" }],
  },
  {
    heading: null,
    items: [
      { to: "/calendar", label: "Calendar" },
      { to: "/team", label: "Team" },
    ],
  },
  {
    heading: null,
    items: [
      // No `end` - deliberately lights up for every /settings/* subpage too
      // (Company Details, Dashboard, UI Settings, Automation & Messaging,
      // Job Setup, ...), since they're all reached through the single
      // Settings tile grid now (see SettingsHub.tsx) rather than each
      // having their own nav link.
      { to: "/settings", label: "Settings" },
    ],
  },
];

const linkClasses = ({ isActive }: { isActive: boolean }) => `block rounded px-3 py-2 font-medium ${isActive ? "jms-nav-link-active" : "jms-nav-link"}`;

export function Layout({ children }: { children: ReactNode }) {
  const { profile, signOut } = useAuth();

  return (
    <div className="flex min-h-screen" style={{ backgroundColor: "var(--jms-bg)", fontFamily: "var(--jms-font)" }}>
      <aside
        className="flex w-56 flex-shrink-0 flex-col"
        style={{ borderRight: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
      >
        <div className="px-4 py-4" style={{ borderBottom: "1px solid var(--jms-border)" }}>
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
            Bingley Job Management
          </h1>
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto p-3" style={{ fontSize: "var(--jms-font-body)" }}>
          {navSections.map((section, i) => (
            <div key={i}>
              {section.heading ? (
                <p
                  className="mb-1 px-3 uppercase tracking-wide"
                  style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                >
                  {section.heading}
                </p>
              ) : null}
              <div className="space-y-1">
                {section.items.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end} className={linkClasses}>
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="p-3" style={{ borderTop: "1px solid var(--jms-border)" }}>
          <p className="truncate px-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {profile?.full_name}
          </p>
          <button onClick={() => void signOut()} className="jms-nav-link mt-1 w-full rounded px-3 py-2 text-left font-medium">
            Sign out
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex flex-shrink-0 items-center justify-between px-4 py-2"
          style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
        >
          <GlobalSearch />
        </header>
        <main className="flex-1 overflow-y-auto" style={{ backgroundColor: "var(--jms-bg)" }}>
          {children}
        </main>
      </div>
    </div>
  );
}

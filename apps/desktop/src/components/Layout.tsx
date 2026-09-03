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
      { to: "/dispatch", label: "Dispatch" },
      { to: "/tasks", label: "Tasks" },
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
      // No `end` - deliberately lights up for every /settings/* subpage too
      // (Company Details, Automation & Messaging, Job Setup, ...), since
      // they're all reached through the single Settings tile grid now (see
      // SettingsHub.tsx) rather than each having their own nav link.
      { to: "/settings", label: "Settings" },
    ],
  },
];

const linkClasses = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-3 py-2 text-sm font-medium ${
    isActive ? "bg-blue-700 text-white" : "text-gray-700 hover:bg-gray-100"
  }`;

export function Layout({ children }: { children: ReactNode }) {
  const { profile, signOut } = useAuth();

  return (
    <div className="flex min-h-screen bg-gray-50">
      <aside className="flex w-56 flex-shrink-0 flex-col border-r border-gray-300 bg-white">
        <div className="border-b border-gray-300 px-4 py-4">
          <h1 className="text-sm font-bold text-gray-900">Bingley Job Management</h1>
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto p-3">
          {navSections.map((section, i) => (
            <div key={i}>
              {section.heading ? (
                <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
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
        <div className="border-t border-gray-300 p-3">
          <p className="truncate px-3 text-xs text-gray-500">{profile?.full_name}</p>
          <button
            onClick={() => void signOut()}
            className="mt-1 w-full rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            Sign out
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-shrink-0 items-center justify-between border-b border-gray-300 bg-white px-4 py-2">
          <GlobalSearch />
        </header>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

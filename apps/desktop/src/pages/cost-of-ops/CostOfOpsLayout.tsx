import { Link, NavLink, Outlet } from "react-router-dom";

// Shared shell for the 5 Cost of Ops tabs - each one is its own route/page
// (matching Settings' existing sub-sections, e.g. /settings/automation),
// just grouped under one nav entry instead of 5 flat sidebar items. Each
// tab page independently queries cost_of_ops_settings/operating_expenses/
// labour_cost_entries via useQuery (same "every page fetches its own data"
// convention as the rest of this app) rather than this layout fetching once
// and passing down via context.

const TABS = [
  { to: "/settings/cost-of-ops/operating-expenses", label: "Operating Expenses" },
  { to: "/settings/cost-of-ops/labour", label: "Labour" },
  { to: "/settings/cost-of-ops/cost-of-operations", label: "Cost of Operations" },
  { to: "/settings/cost-of-ops/profitability", label: "Profitability" },
  { to: "/settings/cost-of-ops/quote-checker", label: "Quote Checker" },
];

export default function CostOfOpsLayout() {
  return (
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Settings
      </Link>
      <div className="mb-6">
        <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
          Cost of Ops
        </h1>
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          What it actually costs to run the business, and what charge-out rate that implies.
        </p>
      </div>

      <div className="mb-6 flex gap-1" style={{ borderBottom: "1px solid var(--jms-border)" }}>
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className="border-b-2 px-4 py-2 font-semibold uppercase tracking-wide"
            style={({ isActive }) =>
              isActive
                ? { borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                : { borderColor: "transparent", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>

      <Outlet />
    </div>
  );
}

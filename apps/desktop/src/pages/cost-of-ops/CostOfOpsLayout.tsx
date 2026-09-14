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
    <div className="p-8">
      <Link to="/settings" className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to Settings
      </Link>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Cost of Ops</h1>
        <p className="text-sm text-gray-500">What it actually costs to run the business, and what charge-out rate that implies.</p>
      </div>

      <div className="mb-6 flex gap-1 border-b border-gray-300">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `border-b-2 px-4 py-2 text-sm font-semibold ${
                isActive ? "border-blue-700 text-blue-700" : "border-transparent text-gray-500 hover:text-gray-700"
              }`
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

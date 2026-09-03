import { Navigate, Link, useSearchParams } from "react-router-dom";

// Master Settings page - a tile grid (same pattern as Price Book's category
// tiles) replacing the old flat list of nav links, one tile per settings
// area. Google Calendar/Xero OAuth connect flows redirect the browser back
// to a fixed URL configured as an Edge Function secret (see google-oauth-
// callback/xero-oauth-callback's own comments) - that secret is set to
// this app's bare "/settings" and can't be changed from here, so rather
// than break those connect flows by moving Company Details off "/settings"
// outright, this page detects their query params and forwards straight to
// Company Details (which still handles them) with the query string intact.
// Every other visit to "/settings" (i.e. actually clicking the nav link)
// lands on the tile grid below instead.

const TILES = [
  { to: "/settings/company", label: "Company Details", emoji: "🏢" },
  { to: "/settings/automation", label: "Automation & Messaging", emoji: "💬" },
  { to: "/settings/job-setup", label: "Job Setup", emoji: "🛠️" },
  { to: "/settings/job-templates", label: "Job Templates", emoji: "📝" },
  { to: "/settings/bundles", label: "Bundles", emoji: "📦" },
  { to: "/settings/inventory-setup", label: "Inventory Setup", emoji: "📋" },
  { to: "/settings/cost-of-ops", label: "Cost of Ops", emoji: "📊" },
] as const;

const OAUTH_CALLBACK_PARAMS = ["xero", "stripe_connect", "google_calendar"];

export default function SettingsHubPage() {
  const [searchParams] = useSearchParams();

  if (OAUTH_CALLBACK_PARAMS.some((p) => searchParams.has(p))) {
    return <Navigate to={`/settings/company?${searchParams.toString()}`} replace />;
  }

  return (
    <div className="p-8">
      <h1 className="mb-6 text-xl font-bold text-gray-900">Settings</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        {TILES.map((tile) => (
          <Link
            key={tile.to}
            to={tile.to}
            className="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-xl bg-gray-100 p-4 text-center hover:bg-gray-200"
          >
            <span className="text-3xl">{tile.emoji}</span>
            <span className="font-bold text-gray-900">{tile.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

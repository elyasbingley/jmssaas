import { useCallback, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useSearchParams } from "react-router-dom";
import { ANALYTICS_PRESETS, comparisonRange, dayKeyOfDate, presetRange, type AnalyticsPreset, type DateRange } from "@jmssaas/shared";
import { getErrorMessage } from "../../lib/errors";
import { useAnalyticsData, type AnalyticsContext, type Drill } from "./data";
import { DrillModal, formatDay } from "./ui";

// Shell for every Analytics report: a report menu down the side, one
// timeframe picker above, and the report itself in the Outlet. The core
// rows (jobs, quotes, invoices, clients...) are loaded once here and
// handed to each report through the Outlet context, so moving between
// reports doesn't refetch and every report is working from the same rows.
//
// The timeframe lives in the URL (?range=28d, or ?from=&to= for a custom
// one) so it survives moving between reports and a page reload.

interface NavItem {
  to: string;
  label: string;
  // False for reports that show the position as of today, or a fixed
  // span of their own - the timeframe picker is greyed out on those.
  usesRange: boolean;
}

const NAV: { heading: string | null; items: NavItem[] }[] = [
  { heading: null, items: [{ to: "/analytics", label: "Dashboard", usesRange: true }] },
  {
    heading: "Jobs",
    items: [
      { to: "/analytics/jobs/category", label: "By Category", usesRange: true },
      { to: "/analytics/jobs/status", label: "By Status", usesRange: true },
      { to: "/analytics/jobs/month", label: "By Month", usesRange: true },
      { to: "/analytics/jobs/win-lose", label: "Win / Lose Rate", usesRange: true },
      { to: "/analytics/jobs/price-book", label: "Price Book Usage", usesRange: true },
      { to: "/analytics/jobs/profitability", label: "Profitability", usesRange: true },
    ],
  },
  { heading: "Clients", items: [{ to: "/analytics/clients/top", label: "Top Clients", usesRange: true }] },
  {
    heading: "Revenue",
    items: [
      { to: "/analytics/revenue/category", label: "By Category", usesRange: true },
      { to: "/analytics/revenue/month", label: "By Month", usesRange: false },
      { to: "/analytics/revenue/suburb", label: "By Suburb", usesRange: true },
      { to: "/analytics/revenue/receivables", label: "Aged Receivables", usesRange: true },
      { to: "/analytics/revenue/pipeline", label: "Quote Pipeline", usesRange: false },
      { to: "/analytics/revenue/target", label: "FY Target", usesRange: false },
      { to: "/analytics/revenue/cost-of-ops", label: "Cost of Ops Coverage", usesRange: false },
    ],
  },
  {
    heading: "Feedback",
    items: [
      { to: "/analytics/feedback/month", label: "By Month", usesRange: true },
      { to: "/analytics/feedback/recent", label: "Recent", usesRange: false },
    ],
  },
  {
    heading: "Timesheets",
    items: [
      { to: "/analytics/timesheets/mine", label: "My Timesheet", usesRange: true },
      { to: "/analytics/timesheets/activity", label: "Activity Timesheet", usesRange: true },
      { to: "/analytics/timesheets/all", label: "All Timesheets", usesRange: true },
      { to: "/analytics/timesheets/weekly", label: "Weekly Timesheets", usesRange: true },
      { to: "/analytics/timesheets/graph", label: "Weekly Timesheets Graph", usesRange: true },
    ],
  },
  { heading: "Leads", items: [{ to: "/analytics/leads", label: "Lead Sources", usesRange: true }] },
];

const DEFAULT_PRESET: Exclude<AnalyticsPreset, "custom"> = "28d";
const isDay = (value: string | null): value is string => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);

export default function AnalyticsLayout() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { ix, error } = useAnalyticsData();
  const [drill, setDrill] = useState<Drill | null>(null);
  const closeDrill = useCallback(() => setDrill(null), []);

  const today = dayKeyOfDate(new Date());
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const rangeParam = searchParams.get("range");
  const custom = isDay(fromParam) && isDay(toParam) && fromParam <= toParam;
  const preset: AnalyticsPreset = custom ? "custom" : ANALYTICS_PRESETS.find((p) => p.value === rangeParam)?.value ?? DEFAULT_PRESET;
  const range: DateRange = useMemo(
    () => (preset === "custom" ? { from: fromParam!, to: toParam! } : presetRange(preset, today)),
    [preset, fromParam, toParam, today]
  );
  const compare = useMemo(() => comparisonRange(preset, range, today), [preset, range, today]);

  const setPreset = (value: Exclude<AnalyticsPreset, "custom">) => setSearchParams({ range: value }, { replace: true });
  const setCustom = (next: DateRange) => {
    if (next.from <= next.to) setSearchParams({ from: next.from, to: next.to }, { replace: true });
  };

  const current = NAV.flatMap((group) => group.items).find((item) => item.to === location.pathname);
  const usesRange = current?.usesRange ?? true;

  const context: AnalyticsContext | null = ix ? { ix, preset, range, compare, today, openDrill: setDrill } : null;

  return (
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-5">
        <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
          Analytics
        </h1>
      </div>

      <div className="flex items-start gap-6">
        <nav className="w-48 shrink-0" aria-label="Analytics reports">
          {NAV.map((group) => (
            <div key={group.heading ?? "top"} className="mb-4">
              {group.heading ? (
                <p className="mb-1 px-3 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  {group.heading}
                </p>
              ) : null}
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={{ pathname: item.to, search: location.search }}
                  end
                  className={({ isActive }) => `block rounded-md px-3 py-1.5 ${isActive ? "jms-nav-link-active font-semibold" : "jms-nav-link"}`}
                  style={{ fontSize: "var(--jms-font-body)" }}
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          <div
            className="mb-5 flex flex-wrap items-end gap-3 rounded-lg p-3"
            style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", opacity: usesRange ? 1 : 0.55 }}
          >
            <div className="flex flex-wrap gap-1">
              {ANALYTICS_PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setPreset(p.value)}
                  disabled={!usesRange}
                  aria-pressed={preset === p.value}
                  className="rounded-full border px-3 py-1.5 font-semibold"
                  style={
                    preset === p.value
                      ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                      : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex items-end gap-2">
              {(["from", "to"] as const).map((edge) => (
                <label key={edge} className="block">
                  <span className="mb-1 block font-semibold capitalize" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                    {edge}
                  </span>
                  <input
                    type="date"
                    value={range[edge]}
                    max={edge === "from" ? range.to : undefined}
                    min={edge === "to" ? range.from : undefined}
                    disabled={!usesRange}
                    onChange={(e) => e.target.value && setCustom({ ...range, [edge]: e.target.value })}
                    className="rounded-md px-3 py-1.5"
                    style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
                  />
                </label>
              ))}
            </div>
            <p className="ml-auto text-right" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              {usesRange ? (
                <>
                  Compared with {formatDay(compare.from)} - {formatDay(compare.to)}
                </>
              ) : (
                "This report isn't affected by the timeframe."
              )}
            </p>
          </div>

          {error ? (
            <div className="rounded-lg p-5" style={{ border: "1px solid var(--jms-danger)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
              <p className="font-semibold" style={{ color: "var(--jms-danger)" }}>
                Analytics couldn't load.
              </p>
              <p className="mt-1">{getErrorMessage(error, "Unknown error")}</p>
              <p className="mt-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                If this mentions a missing column, the latest database migration hasn't been applied yet (npx supabase db push).
              </p>
            </div>
          ) : context ? (
            <Outlet context={context} />
          ) : (
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
          )}
        </div>
      </div>

      {ix ? <DrillModal drill={drill} ix={ix} onClose={closeDrill} /> : null}
    </div>
  );
}

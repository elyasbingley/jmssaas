import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  addDays,
  dayKeyOfDate,
  debtors as debtorRows,
  formatCentsAsAud,
  invoiceOwingCents,
  invoicedByMonth,
  isOverdue,
  isUnpaidInvoice,
  itemsByStatus,
  moneyComingIn,
  presetRange,
  revenueByCategory,
  revenueByLeadSource,
  revenueInRange,
  averageDaysToPay,
  daysBetween,
  type AnalyticsIndex,
  type AnalyticsInvoice,
  type DateRange,
  type InvoiceStatus,
} from "@jmssaas/shared";
import { useAnalyticsData, type Drill } from "./analytics/data";
import { ACCENT, Columns, DrillModal, Empty, Panel, RankedBars, StatTile, compactAud, downloadCsv, formatDay } from "./analytics/ui";

// Invoicing (top bar): a Summary of where the money is - items by status,
// what's coming in and when, who owes the most, and where the money comes
// from - plus the invoice lists by status. Same numbers as Analytics: it
// reads the same data (useAnalyticsData) and definitions
// (packages/shared/src/invoicing.ts).

type Tab = "summary" | "all" | "draft" | "awaiting" | "overdue" | "paid";
const TABS: { key: Tab; label: string }[] = [
  { key: "summary", label: "Summary" },
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "awaiting", label: "Awaiting payment" },
  { key: "overdue", label: "Overdue" },
  { key: "paid", label: "Paid" },
];

type RangeKey = "12m" | "fy" | "last_quarter" | "28d";
const RANGES: { key: RangeKey; label: string; phrase: string }[] = [
  { key: "12m", label: "Last 12 months", phrase: "in the last 12 months" },
  { key: "fy", label: "This financial year", phrase: "this financial year" },
  { key: "last_quarter", label: "Last quarter", phrase: "last quarter" },
  { key: "28d", label: "Last 28 days", phrase: "in the last 28 days" },
];

const STATUS_LABELS: Record<InvoiceStatus, string> = { draft: "Draft", sent: "Sent", paid: "Paid", overdue: "Overdue", void: "Void" };
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const body = { color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
const aud = (cents: number) => formatCentsAsAud(cents);

export default function InvoicesPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "summary") as Tab;
  const { ix, error } = useAnalyticsData();
  const today = dayKeyOfDate(new Date());
  const [drill, setDrill] = useState<Drill | null>(null);

  return (
    <div className="mx-auto max-w-7xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
          Invoicing
        </h1>
        <div className="flex gap-2">
          <Link to="/quotes" className="rounded border px-4 py-2 font-semibold uppercase tracking-wide" style={{ borderColor: "var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-button)" }}>
            Quotes
          </Link>
          <Link
            to="/invoices/new"
            className="rounded px-4 py-2 font-semibold uppercase tracking-wide"
            style={{ backgroundColor: "var(--jms-accent)", color: "var(--jms-bg)", boxShadow: "0 0 10px var(--jms-accent-glow)", fontSize: "var(--jms-font-button)" }}
          >
            + New invoice
          </Link>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap gap-1" style={{ borderBottom: "1px solid var(--jms-border)" }} role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setParams(t.key === "summary" ? {} : { tab: t.key }, { replace: true })}
            className="border-b-2 px-4 py-2 font-semibold uppercase tracking-wide"
            style={tab === t.key ? { borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" } : { borderColor: "transparent", ...muted }}
          >
            {t.label}
            {ix && t.key !== "summary" ? <span style={{ color: "var(--jms-text-muted)" }}> ({listFor(ix, t.key, today).length})</span> : null}
          </button>
        ))}
      </div>

      {error ? <p style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>Couldn't load invoices.</p> : null}
      {!ix ? (
        <p style={muted}>Loading...</p>
      ) : tab === "summary" ? (
        <Summary ix={ix} today={today} openDrill={setDrill} goTab={(t) => setParams({ tab: t }, { replace: true })} />
      ) : (
        <InvoiceList ix={ix} tab={tab} today={today} />
      )}
      {ix ? <DrillModal drill={drill} ix={ix} onClose={() => setDrill(null)} /> : null}
    </div>
  );
}

function listFor(ix: AnalyticsIndex, tab: Tab, today: string): AnalyticsInvoice[] {
  const all = [...ix.invoices].sort((a, b) => b.issue_date.localeCompare(a.issue_date) || b.invoice_number.localeCompare(a.invoice_number));
  switch (tab) {
    case "draft":
      return all.filter((i) => i.status === "draft");
    case "awaiting":
      return all.filter((i) => isUnpaidInvoice(i) && invoiceOwingCents(i) > 0 && !isOverdue(i, today));
    case "overdue":
      return all.filter((i) => isUnpaidInvoice(i) && invoiceOwingCents(i) > 0 && isOverdue(i, today)).sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));
    case "paid":
      return all.filter((i) => i.status === "paid").sort((a, b) => (b.paid_at ?? "").localeCompare(a.paid_at ?? ""));
    default:
      return all;
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function Summary({ ix, today, openDrill, goTab }: { ix: AnalyticsIndex; today: string; openDrill: (d: Drill) => void; goTab: (t: Tab) => void }) {
  const navigate = useNavigate();
  const [rangeKey, setRangeKey] = useState<RangeKey>("12m");
  const range: DateRange = rangeKey === "12m" ? { from: addDays(today, -364), to: today } : presetRange(rangeKey, today);
  const rangeLabel = RANGES.find((r) => r.key === rangeKey)!.phrase;

  const status = useMemo(() => itemsByStatus(ix, today), [ix, today]);
  const coming = useMemo(() => moneyComingIn(ix, today), [ix, today]);
  const owed = useMemo(() => debtorRows(ix, today), [ix, today]);
  const months = useMemo(() => invoicedByMonth(ix, today, 12), [ix, today]);
  const byCategory = useMemo(() => revenueByCategory(ix, range), [ix, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const bySource = useMemo(() => revenueByLeadSource(ix, range), [ix, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const pay = useMemo(() => averageDaysToPay(ix, today, 90), [ix, today]);

  const owingTotal = owed.reduce((s, d) => s + d.cents, 0);
  const overdueTotal = owed.reduce((s, d) => s + d.overdueCents, 0);
  const monthStart = `${today.slice(0, 7)}-01`;
  const invoicedThisMonth = revenueInRange(ix, { from: monthStart, to: today });
  const rangeTotal = revenueInRange(ix, range);
  const statusByKey = Object.fromEntries(status.map((s) => [s.key, s]));

  const statusTarget: Record<string, () => void> = {
    open_quotes: () => navigate("/quotes"),
    accepted_not_invoiced: () => openDrill({ title: "Accepted - not invoiced yet", subtitle: "Accepted quotes whose job has no invoice", quotes: statusByKey.accepted_not_invoiced!.quotes }),
    draft_invoices: () => goTab("draft"),
    awaiting_payment: () => goTab("awaiting"),
    overdue: () => goTab("overdue"),
    paid_this_month: () => goTab("paid"),
  };

  const share = (cents: number, total: number) => (total > 0 ? `${Math.round((cents / total) * 100)}%` : "");

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Owed to you" value={aud(owingTotal)} sub={`${owed.reduce((s, d) => s + d.invoices.length, 0)} unpaid invoices`} onClick={() => goTab("awaiting")} />
        <StatTile label="Overdue" value={aud(overdueTotal)} tone={overdueTotal > 0 ? "danger" : undefined} sub={`${statusByKey.overdue!.count} invoices past due`} onClick={() => goTab("overdue")} />
        <StatTile label="Invoiced this month" value={aud(invoicedThisMonth)} sub={`Paid this month ${aud(statusByKey.paid_this_month!.cents)}`} />
        <StatTile label="Average days to pay" value={pay.average === null ? "-" : `${pay.average} days`} sub={pay.count ? `From ${pay.count} invoices paid in the last 90 days` : "No invoices paid in the last 90 days"} />
      </div>

      <div className="grid grid-cols-1 gap-x-5 xl:grid-cols-2">
        <Panel title="Items by status" note="Click a row to see them.">
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)", color: "var(--jms-text)" }} data-testid="items-by-status">
            <thead style={muted}>
              <tr style={{ borderBottom: "1px solid var(--jms-border)" }}>
                <th className="py-2 pr-3 font-semibold uppercase">Status</th>
                <th className="py-2 pr-3 text-right font-semibold uppercase">Count</th>
                <th className="py-2 text-right font-semibold uppercase">Amount</th>
              </tr>
            </thead>
            <tbody>
              {status.map((row) => (
                <tr key={row.key} className="jms-analytics-hit" onClick={statusTarget[row.key]} style={{ borderBottom: "1px solid var(--jms-border)" }} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && statusTarget[row.key]!()}>
                  <td className="py-2 pr-3">
                    <span className="font-semibold" style={{ color: row.key === "overdue" && row.cents > 0 ? "var(--jms-danger)" : "var(--jms-text)" }}>
                      {row.label}
                    </span>
                    <span className="block" style={muted}>
                      {row.hint}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right align-top" style={muted}>
                    {row.count}
                  </td>
                  <td className="py-2 text-right align-top font-semibold" style={{ whiteSpace: "nowrap" }}>
                    {aud(row.cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Money coming in" note={`${aud(owingTotal)} owed, by when it's due. Click a column for the invoices.`}>
          {owingTotal === 0 ? (
            <Empty>Nothing owed right now.</Empty>
          ) : (
            <Columns
              periods={coming.map((b) => ({
                key: b.key,
                label: b.short,
                values: [b.cents],
                onSelect: () => openDrill({ title: `Owing: ${b.label.toLowerCase()}`, subtitle: `${aud(b.cents)} still owing`, invoices: b.invoices }),
              }))}
              series={[{ name: "Owing", color: ACCENT }]}
              format={aud}
              tick={compactAud}
            />
          )}
        </Panel>

        <Panel
          title="Top 10 debtors"
          note={owed.length ? `Who owes the most - ${owed.length} client${owed.length === 1 ? "" : "s"} owe ${aud(owingTotal)} in total. Click a client to open them.` : undefined}
          actions={
            owed.length ? (
              <button
                onClick={() =>
                  downloadCsv(
                    `debtors-${today}.csv`,
                    ["Client", "Owing", "Overdue", "Oldest days late", "Invoices"],
                    owed.map((d) => [d.name, (d.cents / 100).toFixed(2), (d.overdueCents / 100).toFixed(2), d.oldestDaysLate ?? "", d.invoices.map((i) => i.invoice_number).join(" ")])
                  )
                }
                className="rounded border px-3 py-1 font-semibold"
                style={{ borderColor: "var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
              >
                Export CSV
              </button>
            ) : null
          }
        >
          {owed.length === 0 ? (
            <Empty>No one owes you anything.</Empty>
          ) : (
            <RankedBars
              limit={10}
              format={aud}
              rows={owed.map((d) => ({
                key: d.clientId,
                label: d.name,
                value: d.cents,
                detail: [share(d.cents, owingTotal), d.oldestDaysLate === null ? "not due yet" : d.oldestDaysLate === 0 ? "overdue" : `${d.oldestDaysLate} day${d.oldestDaysLate === 1 ? "" : "s"} late`].filter(Boolean).join(" · "),
                onSelect: () => navigate(`/clients/${d.clientId}`),
              }))}
            />
          )}
        </Panel>

        <Panel title="Invoiced per month" note="Invoices issued each month, last 12 months, including GST (drafts and voids left out). Click a month for its invoices.">
          <Columns
            periods={months.map((m) => ({ key: m.month, label: m.label, values: [m.cents], onSelect: () => openDrill({ title: `Invoiced in ${m.label}`, invoices: m.invoices }) }))}
            series={[{ name: "Invoiced", color: ACCENT }]}
            format={aud}
            tick={compactAud}
          />
        </Panel>
      </div>

      <Panel
        title="Where the money comes from"
        note={`${aud(rangeTotal)} invoiced ${rangeLabel}, by the job's category and by how the client found you. Click a bar for its invoices.`}
        actions={
          <select value={rangeKey} onChange={(e) => setRangeKey(e.target.value as RangeKey)} className="rounded border px-2 py-1" style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", ...body }} aria-label="Period">
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        }
      >
        {rangeTotal === 0 ? (
          <Empty>Nothing invoiced {rangeLabel}.</Empty>
        ) : (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <div>
              <p className="mb-2 font-semibold uppercase tracking-wide" style={muted}>
                By category
              </p>
              <RankedBars
                limit={8}
                format={aud}
                rows={byCategory.map((r) => ({
                  key: r.key,
                  label: r.label,
                  value: r.cents,
                  detail: share(r.cents, rangeTotal),
                  onSelect: () => openDrill({ title: r.label, subtitle: `Invoices issued ${rangeLabel}`, invoices: r.invoices }),
                }))}
              />
            </div>
            <div>
              <p className="mb-2 font-semibold uppercase tracking-wide" style={muted}>
                By lead source
              </p>
              <RankedBars
                limit={8}
                format={aud}
                rows={bySource.map((r) => ({
                  key: r.key,
                  label: r.label,
                  value: r.cents,
                  detail: share(r.cents, rangeTotal),
                  onSelect: () => openDrill({ title: r.label, subtitle: `Invoices issued ${rangeLabel}`, invoices: r.invoices }),
                }))}
              />
            </div>
          </div>
        )}
        <p className="mt-3" style={muted}>
          More breakdowns (by suburb, client, month across years) are in{" "}
          <Link to="/analytics/revenue/category" className="underline">
            Analytics
          </Link>
          .
        </p>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function InvoiceList({ ix, tab, today }: { ix: AnalyticsIndex; tab: Tab; today: string }) {
  const [search, setSearch] = useState("");
  const rows = listFor(ix, tab, today);
  const q = search.trim().toLowerCase();
  const shown = q ? rows.filter((i) => `${i.invoice_number} ${ix.clientById.get(i.client_id)?.name ?? ""}`.toLowerCase().includes(q)) : rows;
  const owingTabs = tab === "awaiting" || tab === "overdue";
  const total = shown.reduce((s, i) => s + (owingTabs ? invoiceOwingCents(i) : i.total_cents), 0);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by number or client..."
          aria-label="Filter invoices"
          className="w-72 rounded border px-3 py-1.5 focus:outline-none"
          style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", ...body }}
        />
        <span style={muted}>
          {shown.length} invoice{shown.length === 1 ? "" : "s"} · {aud(total)} {owingTabs ? "owing" : "total"}
        </span>
      </div>
      <div className="overflow-x-auto rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {shown.length === 0 ? (
          <p className="p-6" style={muted}>
            No invoices here.
          </p>
        ) : (
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)", color: "var(--jms-text)" }} data-testid="invoice-list">
            <thead className="uppercase" style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              <tr>
                <th className="px-4 py-2 font-semibold">Number</th>
                <th className="px-4 py-2 font-semibold">Client</th>
                <th className="px-4 py-2 font-semibold">Issued</th>
                <th className="px-4 py-2 font-semibold">{tab === "paid" ? "Paid" : "Due"}</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 text-right font-semibold">Total</th>
                <th className="px-4 py-2 text-right font-semibold">Owing</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((inv) => {
                const late = isOverdue(inv, today) && inv.due_date ? daysBetween(inv.due_date, today) : null;
                const owing = isUnpaidInvoice(inv) ? invoiceOwingCents(inv) : 0;
                const overdue = isOverdue(inv, today);
                return (
                  <tr key={inv.id} className="jms-nav-link" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                    <td className="px-4 py-2.5">
                      <Link to={`/invoices/${inv.id}`} className="font-medium hover:underline" style={{ color: "var(--jms-accent)" }}>
                        {inv.invoice_number}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <Link to={`/clients/${inv.client_id}`} className="hover:underline" style={{ color: "var(--jms-text)" }}>
                        {ix.clientById.get(inv.client_id)?.name ?? "Unknown client"}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5" style={muted}>
                      {formatDay(inv.issue_date)}
                    </td>
                    <td className="px-4 py-2.5" style={muted}>
                      {tab === "paid" ? formatDay(inv.paid_at ? dayKeyOfDate(new Date(inv.paid_at)) : null) : formatDay(inv.due_date)}
                      {late !== null ? <span style={{ color: "var(--jms-danger)" }}> · {late} days late</span> : null}
                    </td>
                    <td className="px-4 py-2.5 font-semibold" style={{ color: overdue ? "var(--jms-danger)" : inv.status === "draft" || inv.status === "void" ? "var(--jms-text-muted)" : "var(--jms-accent)" }}>
                      {overdue ? "Overdue" : STATUS_LABELS[inv.status]}
                    </td>
                    <td className="px-4 py-2.5 text-right">{aud(inv.total_cents)}</td>
                    <td className="px-4 py-2.5 text-right font-semibold">{owing ? aud(owing) : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

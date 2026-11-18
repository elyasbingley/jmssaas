import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  agedReceivables,
  invoiceOwingCents,
  computeKpis,
  daysBetween,
  formatCentsAsAud,
  fyTargetProgress,
  quotePipeline,
  revenueByCategory,
  revenueByMonthAcrossYears,
  revenueBySuburb,
  topClients,
  type RevenueGroupRow,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { useAnalytics } from "./data";
import { CumulativeLines, DataTable, Delta, Empty, ExportButton, PageHeading, Panel, RankedBars, StatTile, compactAud, dollars, downloadCsv, formatDay, formatPercent } from "./ui";

function RevenueGroupReport({ rows, groupHeader, filename, barLimit, linkTo }: { rows: RevenueGroupRow[]; groupHeader: string; filename: string; barLimit?: number; linkTo?: (row: RevenueGroupRow) => string | null }) {
  const { range, openDrill } = useAnalytics();
  const period = `${formatDay(range.from)} - ${formatDay(range.to)}`;
  const total = rows.reduce((sum, r) => sum + r.cents, 0);
  const share = (cents: number) => (total > 0 ? (cents / total) * 100 : 0);
  const [limit, setLimit] = useState(25);
  if (rows.length === 0) return <Empty>No invoices were issued in this timeframe.</Empty>;
  const drill = (r: RevenueGroupRow) => () => openDrill({ title: r.label, subtitle: `Invoices issued ${period}`, invoices: r.invoices });
  const shown = rows.slice(0, limit);
  return (
    <>
      <Panel title={`Invoiced revenue, by ${groupHeader.toLowerCase()}`}>
        <RankedBars
          limit={barLimit}
          format={formatCentsAsAud}
          rows={rows.map((r) => ({ key: r.key, label: r.label, value: r.cents, detail: formatPercent(share(r.cents)), onSelect: drill(r) }))}
        />
      </Panel>
      <Panel
        actions={
          <ExportButton
            onClick={() =>
              downloadCsv(
                `${filename}-${range.from}-to-${range.to}.csv`,
                [groupHeader, "Invoices", "Jobs", "Revenue inc GST ($)", "Share (%)"],
                rows.map((r) => [r.label, r.invoices.length, r.jobIds.size, dollars(r.cents), Number(share(r.cents).toFixed(1))])
              )
            }
          />
        }
      >
        <DataTable
          rows={shown}
          rowKey={(r) => r.key}
          columns={[
            {
              header: groupHeader,
              render: (r) => {
                const to = linkTo?.(r);
                return to ? (
                  <Link to={to} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                    {r.label}
                  </Link>
                ) : (
                  r.label
                );
              },
            },
            { header: "Invoices", align: "right", render: (r) => r.invoices.length, onSelect: drill },
            { header: "Jobs", align: "right", render: (r) => r.jobIds.size },
            { header: "Revenue", align: "right", render: (r) => formatCentsAsAud(r.cents), onSelect: drill },
            { header: "Share", align: "right", render: (r) => formatPercent(share(r.cents), 1) },
          ]}
          footer={["Total", rows.reduce((s, r) => s + r.invoices.length, 0), "", formatCentsAsAud(total), ""]}
        />
        {rows.length > limit ? (
          <button onClick={() => setLimit(rows.length)} className="mt-3 font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
            Show all {rows.length}
          </button>
        ) : null}
      </Panel>
    </>
  );
}

export function TopClientsPage() {
  const { ix, range } = useAnalytics();
  const rows = useMemo(() => topClients(ix, range), [ix, range]);
  return (
    <>
      <PageHeading title="Top clients" description="Clients ranked by what was invoiced to them in the timeframe, inc. GST." />
      <RevenueGroupReport rows={rows} groupHeader="Client" filename="top-clients" barLimit={15} linkTo={(r) => (ix.clientById.has(r.key) ? `/clients/${r.key}` : null)} />
    </>
  );
}

export function RevenueByCategoryPage() {
  const { ix, range } = useAnalytics();
  const rows = useMemo(() => revenueByCategory(ix, range), [ix, range]);
  return (
    <>
      <PageHeading
        title="Revenue by category"
        description="Invoiced revenue in the timeframe (inc. GST), by the service category of the job each invoice belongs to. Categories are your own - set them in Settings > Job Setup."
      />
      <RevenueGroupReport rows={rows} groupHeader="Category" filename="revenue-by-category" />
    </>
  );
}

export function RevenueBySuburbPage() {
  const { ix, range } = useAnalytics();
  const rows = useMemo(() => revenueBySuburb(ix, range), [ix, range]);
  return (
    <>
      <PageHeading
        title="Revenue by suburb"
        description="Where the work was: invoiced revenue in the timeframe (inc. GST) by the suburb of the job's site address, falling back to the client's own address when the job has no site."
      />
      <RevenueGroupReport rows={rows} groupHeader="Suburb" filename="revenue-by-suburb" barLimit={15} />
    </>
  );
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function RevenueByMonthPage() {
  const { ix, today, openDrill } = useAnalytics();
  const thisYear = Number(today.slice(0, 4));
  const years = useMemo(() => [4, 3, 2, 1, 0].map((back) => thisYear - back), [thisYear]);
  const grid = useMemo(() => revenueByMonthAcrossYears(ix, years), [ix, years]);
  const max = Math.max(1, ...grid.flat().map((cell) => cell.cents));
  const yearTotals = years.map((_, col) => grid.reduce((sum, row) => sum + (row[col]?.cents ?? 0), 0));
  const currentMonth = Number(today.slice(5, 7)) - 1;

  return (
    <>
      <PageHeading
        title="Revenue by month"
        description="Invoiced revenue (inc. GST) for each calendar month, side by side over the last five years, so the same month can be compared year on year. Darker cells are bigger months."
      />
      <Panel
        actions={
          <ExportButton
            onClick={() =>
              downloadCsv(
                "revenue-by-month-5-years.csv",
                ["Month", ...years.map(String)],
                grid.map((row, month) => [MONTH_NAMES[month]!, ...row.map((cell) => dollars(cell.cents))])
              )
            }
          />
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full" style={{ fontSize: "var(--jms-font-body)", borderCollapse: "separate", borderSpacing: 2 }}>
            <thead className="uppercase" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              <tr>
                <th className="px-2 py-2 text-left font-semibold">Month</th>
                {years.map((year) => (
                  <th key={year} className="px-2 py-2 text-right font-semibold">
                    {year}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((row, month) => (
                <tr key={month}>
                  <td className="px-2 py-2" style={{ color: "var(--jms-text)" }}>
                    {MONTH_NAMES[month]}
                  </td>
                  {row.map((cell, col) => {
                    const future = years[col] === thisYear && month > currentMonth;
                    return (
                      <td key={col} className="p-0 text-right tabular-nums">
                        {cell.invoices.length > 0 ? (
                          <button
                            onClick={() => openDrill({ title: `Revenue - ${MONTH_NAMES[month]} ${years[col]}`, invoices: cell.invoices })}
                            className="jms-analytics-hit block w-full rounded px-2 py-2 text-right"
                            title={`${cell.invoices.length} invoice${cell.invoices.length === 1 ? "" : "s"}`}
                            style={{ color: "var(--jms-text)", backgroundColor: `color-mix(in srgb, var(--jms-accent) ${Math.round(6 + (cell.cents / max) * 34)}%, transparent)` }}
                          >
                            {formatCentsAsAud(cell.cents)}
                          </button>
                        ) : (
                          <span className="block px-2 py-2" style={{ color: "var(--jms-text-muted)" }}>
                            {future ? "" : "-"}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold" style={{ color: "var(--jms-text)" }}>
                <td className="px-2 py-2">Year total</td>
                {yearTotals.map((cents, col) => (
                  <td key={col} className="px-2 py-2 text-right tabular-nums">
                    {formatCentsAsAud(cents)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </Panel>
    </>
  );
}

export function AgedReceivablesPage() {
  const { ix, range, compare, today, openDrill } = useAnalytics();
  const buckets = useMemo(() => agedReceivables(ix, today), [ix, today]);
  const k = useMemo(() => computeKpis(ix, range), [ix, range]);
  const prev = useMemo(() => computeKpis(ix, compare), [ix, compare]);
  const invoices = buckets.flatMap((b) => b.invoices);
  const total = buckets.reduce((sum, b) => sum + b.cents, 0);
  const overdue = invoices.filter((inv) => inv.status === "overdue" || (inv.due_date !== null && inv.due_date < today));
  const clientName = (id: string) => ix.clientById.get(id)?.name ?? "Unknown client";

  return (
    <>
      <PageHeading
        title="Aged receivables"
        description="Every invoice that has been issued and not yet paid, as of today, by how long ago it was issued. Days to payment is the average for invoices paid in the timeframe above."
      />
      <div className="mb-5 grid grid-cols-3 gap-4">
        <StatTile label="Unpaid, right now" value={formatCentsAsAud(total)} sub={`${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`} />
        <StatTile
          label="Past due date"
          value={formatCentsAsAud(overdue.reduce((sum, inv) => sum + invoiceOwingCents(inv), 0))}
          sub={`${overdue.length} invoice${overdue.length === 1 ? "" : "s"}`}
          tone={overdue.length > 0 ? "danger" : undefined}
          onClick={overdue.length ? () => openDrill({ title: "Invoices past their due date", invoices: overdue }) : undefined}
        />
        <StatTile
          label="Days to payment"
          value={k.daysToPayment === null ? "-" : k.daysToPayment.toFixed(1)}
          sub={k.paidInvoices.length > 0 ? `Average over ${k.paidInvoices.length} paid in the timeframe` : "No invoices paid in the timeframe"}
          delta={<Delta current={k.daysToPayment} previous={prev.daysToPayment} goodWhenUp={false} unit="days" />}
          onClick={k.paidInvoices.length ? () => openDrill({ title: "Invoices paid", invoices: k.paidInvoices }) : undefined}
        />
      </div>
      {invoices.length === 0 ? (
        <Empty>Nothing is outstanding - every issued invoice has been paid.</Empty>
      ) : (
        <>
          <Panel title="Unpaid by age">
            <RankedBars
              format={formatCentsAsAud}
              rows={buckets.map((b) => ({
                key: b.key,
                label: b.label,
                value: b.cents,
                detail: `${b.invoices.length} invoice${b.invoices.length === 1 ? "" : "s"}`,
                onSelect: b.invoices.length ? () => openDrill({ title: `Unpaid - ${b.label}`, invoices: b.invoices }) : undefined,
              }))}
            />
          </Panel>
          <Panel
            title="Unpaid invoices, oldest first"
            actions={
              <ExportButton
                onClick={() =>
                  downloadCsv(
                    `aged-receivables-${today}.csv`,
                    ["Invoice", "Client", "Issued", "Due", "Days old", "Status", "Amount inc GST ($)", "Paid ($)", "Owing ($)"],
                    invoices.map((inv) => [inv.invoice_number, clientName(inv.client_id), inv.issue_date, inv.due_date ?? "", daysBetween(inv.issue_date, today), inv.status, dollars(inv.total_cents), dollars(inv.amount_paid_cents ?? 0), dollars(invoiceOwingCents(inv))])
                  )
                }
              />
            }
          >
            <DataTable
              rows={[...invoices].sort((a, b) => a.issue_date.localeCompare(b.issue_date))}
              rowKey={(inv) => inv.id}
              columns={[
                {
                  header: "Invoice",
                  render: (inv) => (
                    <Link to={`/invoices/${inv.id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                      {inv.invoice_number}
                    </Link>
                  ),
                },
                { header: "Client", render: (inv) => clientName(inv.client_id) },
                { header: "Issued", render: (inv) => formatDay(inv.issue_date) },
                {
                  header: "Due",
                  render: (inv) =>
                    inv.due_date && inv.due_date < today ? (
                      <span style={{ color: "var(--jms-danger)" }}>{formatDay(inv.due_date)} (overdue)</span>
                    ) : (
                      formatDay(inv.due_date)
                    ),
                },
                { header: "Days old", align: "right", render: (inv) => daysBetween(inv.issue_date, today) },
                { header: "Amount", align: "right", render: (inv) => formatCentsAsAud(inv.total_cents) },
                { header: "Owing", align: "right", render: (inv) => formatCentsAsAud(invoiceOwingCents(inv)) },
              ]}
              footer={["Total", "", "", "", "", "", formatCentsAsAud(total)]}
            />
          </Panel>
        </>
      )}
    </>
  );
}

export function QuotePipelinePage() {
  const { ix, today, openDrill } = useAnalytics();
  const buckets = useMemo(() => quotePipeline(ix, today), [ix, today]);
  const quotes = buckets.flatMap((b) => b.quotes);
  const total = buckets.reduce((sum, b) => sum + b.cents, 0);
  const oldest = quotes.reduce((max, q) => Math.max(max, daysBetween(q.issue_date, today)), 0);
  const clientName = (id: string) => ix.clientById.get(id)?.name ?? "Unknown client";

  return (
    <>
      <PageHeading
        title="Quote pipeline"
        description="Quotes that have been sent and are still waiting on the client, as of today - what they're worth and how long each has been waiting. The oldest ones are the follow-up list."
      />
      <div className="mb-5 grid grid-cols-3 gap-4">
        <StatTile label="Awaiting a decision" value={formatCentsAsAud(total)} sub={`${quotes.length} quote${quotes.length === 1 ? "" : "s"}, inc. GST`} />
        <StatTile label="Waiting over 30 days" value={formatCentsAsAud(buckets[3]?.cents ?? 0)} sub={`${buckets[3]?.quotes.length ?? 0} quote${buckets[3]?.quotes.length === 1 ? "" : "s"}`} />
        <StatTile label="Longest wait" value={quotes.length ? `${oldest} days` : "-"} />
      </div>
      {quotes.length === 0 ? (
        <Empty>No quotes are waiting on a client right now.</Empty>
      ) : (
        <>
          <Panel title="Value waiting, by days since sent">
            <RankedBars
              format={formatCentsAsAud}
              rows={buckets.map((b) => ({
                key: b.key,
                label: b.label,
                value: b.cents,
                detail: `${b.quotes.length} quote${b.quotes.length === 1 ? "" : "s"}`,
                onSelect: b.quotes.length ? () => openDrill({ title: `Quotes waiting ${b.label}`, quotes: b.quotes }) : undefined,
              }))}
            />
          </Panel>
          <Panel
            title="Waiting quotes, longest wait first"
            actions={
              <ExportButton
                onClick={() =>
                  downloadCsv(
                    `quote-pipeline-${today}.csv`,
                    ["Quote", "Client", "Sent", "Days waiting", "Amount inc GST ($)"],
                    quotes.map((q) => [q.quote_number, clientName(q.client_id), q.issue_date, daysBetween(q.issue_date, today), dollars(q.total_cents)])
                  )
                }
              />
            }
          >
            <DataTable
              rows={[...quotes].sort((a, b) => a.issue_date.localeCompare(b.issue_date))}
              rowKey={(q) => q.id}
              columns={[
                {
                  header: "Quote",
                  render: (q) => (
                    <Link to={`/quotes/${q.id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                      {q.quote_number}
                    </Link>
                  ),
                },
                { header: "Client", render: (q) => clientName(q.client_id) },
                { header: "Sent", render: (q) => formatDay(q.issue_date) },
                { header: "Days waiting", align: "right", render: (q) => daysBetween(q.issue_date, today) },
                { header: "Amount", align: "right", render: (q) => formatCentsAsAud(q.total_cents) },
              ]}
              footer={["Total", "", "", "", formatCentsAsAud(total)]}
            />
          </Panel>
        </>
      )}
    </>
  );
}

async function fetchRevenueTarget(tenantId: string): Promise<number | null> {
  const { data, error } = await supabase.from("tenants").select("fy_revenue_target_cents").eq("id", tenantId).single();
  if (error) throw error;
  return (data as { fy_revenue_target_cents: number | null }).fy_revenue_target_cents;
}

export function FyTargetPage() {
  const { ix, today, openDrill } = useAnalytics();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const tenantId = profile?.tenant_id;
  const target = useQuery({ queryKey: ["analytics", "fy-target", tenantId], queryFn: () => fetchRevenueTarget(tenantId!), enabled: !!tenantId });
  const [input, setInput] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (target.data !== undefined) setInput(target.data === null ? "" : String(target.data / 100));
  }, [target.data]);

  const save = useMutation({
    mutationFn: async () => {
      const trimmed = input.replace(/[$,\s]/g, "");
      const value = trimmed === "" ? null : Number(trimmed);
      if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error("Enter the target as a dollar amount, e.g. 450000");
      const { error } = await supabase
        .from("tenants")
        .update({ fy_revenue_target_cents: value === null ? null : Math.round(value * 100) })
        .eq("id", tenantId!);
      if (error) throw error;
    },
    onSuccess: () => {
      setSaveError(null);
      queryClient.invalidateQueries({ queryKey: ["analytics", "fy-target", tenantId] });
      queryClient.invalidateQueries({ queryKey: ["tenant", tenantId] });
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save the target")),
  });

  const progress = useMemo(() => fyTargetProgress(ix, target.data ?? null, today), [ix, target.data, today]);
  const ahead = (progress.varianceCents ?? 0) >= 0;
  const dirty = target.data !== undefined && input.replace(/[$,\s]/g, "") !== (target.data === null ? "" : String(target.data / 100));

  return (
    <>
      <PageHeading
        title={`${progress.label} revenue target`}
        description={`Invoiced revenue (inc. GST) for the financial year ${formatDay(progress.from)} - ${formatDay(progress.to)}, against your goal. "Should be at" is the straight-line share of the target for the days gone so far; "on track for" is where the year ends if the rest of it runs at the pace so far.`}
      />
      <Panel title="Target for the year">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Revenue goal ($, inc. GST)
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. 450000"
              className="w-48 rounded-md px-3 py-1.5 focus:outline-none"
              style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
            />
          </label>
          <button
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending}
            className="rounded-md px-4 py-1.5 font-semibold disabled:opacity-50"
            style={{ border: "1px solid var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
          >
            {save.isPending ? "Saving..." : "Save target"}
          </button>
          {saveError ? <span style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>{saveError}</span> : null}
          {target.error ? <span style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>{getErrorMessage(target.error, "Couldn't load the target")}</span> : null}
        </div>
      </Panel>

      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile label="Invoiced so far" value={formatCentsAsAud(progress.actualCents)} sub={`${formatPercent(progress.fractionElapsed * 100)} of the year gone`} />
        <StatTile label="Should be at" value={progress.expectedCents === null ? "-" : formatCentsAsAud(progress.expectedCents)} sub={progress.targetCents === null ? "Set a target to see this" : `of ${formatCentsAsAud(progress.targetCents)}`} />
        <StatTile
          label={progress.varianceCents === null ? "Ahead / behind" : ahead ? "Ahead of pace" : "Behind pace"}
          value={progress.varianceCents === null ? "-" : `${ahead ? "▲" : "▼"} ${formatCentsAsAud(Math.abs(progress.varianceCents))}`}
          tone={progress.varianceCents !== null && !ahead ? "danger" : undefined}
        />
        <StatTile
          label="On track for"
          value={formatCentsAsAud(progress.projectedCents)}
          sub={progress.targetCents ? `${formatPercent((progress.projectedCents / progress.targetCents) * 100)} of target by ${formatDay(progress.to)}` : "by year end at the current pace"}
        />
      </div>

      <Panel title="Running total by month">
        <CumulativeLines
          actualName="Invoiced"
          targetName="Target pace"
          format={formatCentsAsAud}
          points={progress.months.map((m) => ({
            label: m.label.slice(0, 3),
            actual: m.elapsed ? m.cumulativeCents : null,
            target: progress.targetCents === null ? null : m.targetCumulativeCents,
          }))}
        />
      </Panel>

      <Panel
        actions={
          <ExportButton
            onClick={() =>
              downloadCsv(
                `fy-target-${progress.from}.csv`,
                ["Month", "Invoiced ($)", "Running total ($)", "Target running total ($)"],
                progress.months.filter((m) => m.elapsed).map((m) => [m.label, dollars(m.cents), dollars(m.cumulativeCents), progress.targetCents === null ? "" : dollars(m.targetCumulativeCents)])
              )
            }
          />
        }
      >
        <DataTable
          rows={progress.months.filter((m) => m.elapsed)}
          rowKey={(m) => m.month}
          columns={[
            { header: "Month", render: (m) => m.label },
            {
              header: "Invoiced",
              align: "right",
              render: (m) => formatCentsAsAud(m.cents),
              onSelect: (m) => (m.invoices.length ? () => openDrill({ title: `Revenue - ${m.label}`, invoices: m.invoices }) : undefined),
            },
            { header: "Running total", align: "right", render: (m) => formatCentsAsAud(m.cumulativeCents) },
            { header: "Target by month end", align: "right", render: (m) => (progress.targetCents === null ? "-" : formatCentsAsAud(m.targetCumulativeCents)) },
            {
              header: "Difference",
              align: "right",
              render: (m) => {
                if (progress.targetCents === null) return "-";
                const diff = m.cumulativeCents - m.targetCumulativeCents;
                return <span style={{ color: diff < 0 ? "var(--jms-danger)" : "var(--jms-text)" }}>{`${diff < 0 ? "-" : "+"}${compactAud(Math.abs(diff))}`}</span>;
              },
            },
          ]}
        />
        <p className="mt-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          The current month is compared against its full month-end target, so it will read behind until the month finishes.
        </p>
      </Panel>
    </>
  );
}

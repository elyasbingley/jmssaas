import { useMemo, useState } from "react";
import {
  QUOTE_LOST_REASON_LABELS,
  formatCentsAsAud,
  jobsByCategory,
  jobsByMonth,
  jobsByStage,
  lostReasons,
  priceBookUsage,
  quoteOutcome,
  quoteOutcomesByMonth,
  type JobGroupRow,
} from "@jmssaas/shared";
import { useAnalytics, usePriceBookLines } from "./data";
import { ACCENT, CONTEXT, Columns, DataTable, Empty, ExportButton, PageHeading, Panel, RankedBars, StatTile, dollars, downloadCsv, formatDay, formatPercent } from "./ui";

function usePeriodLabel() {
  const { range } = useAnalytics();
  return `${formatDay(range.from)} - ${formatDay(range.to)}`;
}

function JobGroupReport({ rows, groupHeader, filename, emptyText }: { rows: JobGroupRow[]; groupHeader: string; filename: string; emptyText: string }) {
  const { range, openDrill } = useAnalytics();
  const period = usePeriodLabel();
  const totalJobs = rows.reduce((sum, r) => sum + r.jobs.length, 0);
  if (rows.length === 0) return <Empty>{emptyText}</Empty>;
  return (
    <>
      <Panel title={`Jobs created, by ${groupHeader.toLowerCase()}`}>
        <RankedBars
          format={(v) => String(v)}
          rows={rows.map((row) => ({
            key: row.key,
            label: row.label,
            value: row.jobs.length,
            detail: formatPercent((row.jobs.length / totalJobs) * 100),
            onSelect: () => openDrill({ title: row.label, subtitle: `Jobs created ${period}`, jobs: row.jobs }),
          }))}
        />
      </Panel>
      <Panel
        actions={
          <ExportButton
            onClick={() =>
              downloadCsv(
                `${filename}-${range.from}-to-${range.to}.csv`,
                [groupHeader, "Jobs", "Completed", "Invoiced ($)"],
                rows.map((r) => [r.label, r.jobs.length, r.completed.length, dollars(r.revenueCents)])
              )
            }
          />
        }
      >
        <DataTable
          rows={rows}
          rowKey={(r) => r.key}
          columns={[
            { header: groupHeader, render: (r) => r.label },
            { header: "Jobs", align: "right", render: (r) => r.jobs.length, onSelect: (r) => () => openDrill({ title: r.label, subtitle: `Jobs created ${period}`, jobs: r.jobs }) },
            {
              header: "Completed",
              align: "right",
              render: (r) => r.completed.length,
              onSelect: (r) => (r.completed.length ? () => openDrill({ title: `${r.label} - completed`, subtitle: `Jobs created ${period}`, jobs: r.completed }) : undefined),
            },
            {
              header: "Invoiced",
              align: "right",
              render: (r) => formatCentsAsAud(r.revenueCents),
              onSelect: (r) => (r.invoices.length ? () => openDrill({ title: `${r.label} - invoices`, subtitle: `For jobs created ${period}`, invoices: r.invoices }) : undefined),
            },
          ]}
          footer={[
            "Total",
            totalJobs,
            rows.reduce((sum, r) => sum + r.completed.length, 0),
            formatCentsAsAud(rows.reduce((sum, r) => sum + r.revenueCents, 0)),
          ]}
        />
      </Panel>
    </>
  );
}

export function JobsByCategoryPage() {
  const { ix, range } = useAnalytics();
  const rows = useMemo(() => jobsByCategory(ix, range), [ix, range]);
  return (
    <>
      <PageHeading
        title="Jobs by category"
        description="Jobs created in the timeframe, by service category. Invoiced is everything billed against those jobs so far, inc. GST."
      />
      <JobGroupReport rows={rows} groupHeader="Category" filename="jobs-by-category" emptyText="No jobs were created in this timeframe." />
    </>
  );
}

export function JobsByStatusPage() {
  const { ix, range } = useAnalytics();
  const rows = useMemo(() => jobsByStage(ix, range), [ix, range]);
  return (
    <>
      <PageHeading
        title="Jobs by status"
        description="Jobs created in the timeframe, by the stage each one is at today, in pipeline order."
      />
      <JobGroupReport rows={rows} groupHeader="Status" filename="jobs-by-status" emptyText="No jobs were created in this timeframe." />
    </>
  );
}

export function JobsByMonthPage() {
  const { ix, range, openDrill } = useAnalytics();
  const rows = useMemo(() => jobsByMonth(ix, range), [ix, range]);
  const any = rows.some((r) => r.created.length || r.completed.length);
  return (
    <>
      <PageHeading title="Jobs by month" description="Jobs created and jobs completed in each month of the timeframe. A job counts in the month it was created and again in the month it was completed." />
      {!any ? (
        <Empty>No jobs were created or completed in this timeframe.</Empty>
      ) : (
        <>
          <Panel>
            <Columns
              series={[
                { name: "Created", color: CONTEXT },
                { name: "Completed", color: ACCENT },
              ]}
              format={(v) => String(Math.round(v))}
              periods={rows.map((row) => ({
                key: row.month,
                label: row.label,
                values: [row.created.length, row.completed.length],
                onSelect: (series) =>
                  openDrill(
                    series === 0
                      ? { title: `Jobs created - ${row.label}`, jobs: row.created }
                      : { title: `Jobs completed - ${row.label}`, jobs: row.completed }
                  ),
              }))}
            />
          </Panel>
          <Panel
            actions={
              <ExportButton
                onClick={() =>
                  downloadCsv(`jobs-by-month-${range.from}-to-${range.to}.csv`, ["Month", "Created", "Completed"], rows.map((r) => [r.label, r.created.length, r.completed.length]))
                }
              />
            }
          >
            <DataTable
              rows={rows}
              rowKey={(r) => r.month}
              columns={[
                { header: "Month", render: (r) => r.label },
                { header: "Created", align: "right", render: (r) => r.created.length, onSelect: (r) => (r.created.length ? () => openDrill({ title: `Jobs created - ${r.label}`, jobs: r.created }) : undefined) },
                {
                  header: "Completed",
                  align: "right",
                  render: (r) => r.completed.length,
                  onSelect: (r) => (r.completed.length ? () => openDrill({ title: `Jobs completed - ${r.label}`, jobs: r.completed }) : undefined),
                },
              ]}
              footer={["Total", rows.reduce((s, r) => s + r.created.length, 0), rows.reduce((s, r) => s + r.completed.length, 0)]}
            />
          </Panel>
        </>
      )}
    </>
  );
}

export function WinLosePage() {
  const { ix, range, openDrill } = useAnalytics();
  const period = usePeriodLabel();
  const months = useMemo(() => quoteOutcomesByMonth(ix, range), [ix, range]);
  const reasons = useMemo(() => lostReasons(ix, range), [ix, range]);
  const total = useMemo(() => quoteOutcome(months.flatMap((m) => m.quotes)), [months]);
  const wonCents = months.reduce((s, m) => s + m.wonCents, 0);
  const lostCents = months.reduce((s, m) => s + m.lostCents, 0);
  const lostCount = total.lost.length + total.expired.length;
  const unrecorded = reasons.find((r) => r.key === "unrecorded")?.quotes.length ?? 0;
  const drill = (title: string, quotes: typeof total.quotes) => (quotes.length ? () => openDrill({ title, subtitle: `Quotes issued ${period}`, quotes }) : undefined);

  return (
    <>
      <PageHeading
        title="Win / lose rate"
        description="Quotes issued in the timeframe and how they ended. Win rate is won as a share of quotes with an outcome (won, declined or expired) - quotes still waiting on the client are shown separately and don't count against it."
      />
      {total.quotes.length === 0 ? (
        <Empty>No quotes were sent in this timeframe.</Empty>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StatTile label="Win rate" value={formatPercent(total.winRate)} sub={`${total.won.length} won, ${lostCount} lost`} onClick={drill("Quotes with an outcome", [...total.won, ...total.lost, ...total.expired])} />
            <StatTile label="Won" value={formatCentsAsAud(wonCents)} sub={`${total.won.length} quote${total.won.length === 1 ? "" : "s"}`} onClick={drill("Quotes won", total.won)} />
            <StatTile label="Lost" value={formatCentsAsAud(lostCents)} sub={`${total.lost.length} declined, ${total.expired.length} expired`} onClick={drill("Quotes lost", [...total.lost, ...total.expired])} />
            <StatTile label="Still pending" value={String(total.pending.length)} sub={formatCentsAsAud(total.pending.reduce((s, q) => s + q.total_cents, 0))} onClick={drill("Quotes pending", total.pending)} />
          </div>

          <Panel
            title="By month issued"
            actions={
              <ExportButton
                onClick={() =>
                  downloadCsv(
                    `win-lose-${range.from}-to-${range.to}.csv`,
                    ["Month", "Sent", "Won", "Declined", "Expired", "Pending", "Win rate (%)", "Won ($)", "Lost ($)"],
                    months.map((m) => [m.label, m.quotes.length, m.won.length, m.lost.length, m.expired.length, m.pending.length, m.winRate === null ? "" : Number(m.winRate.toFixed(1)), dollars(m.wonCents), dollars(m.lostCents)])
                  )
                }
              />
            }
          >
            <DataTable
              rows={months}
              rowKey={(m) => m.month}
              columns={[
                { header: "Month", render: (m) => m.label },
                { header: "Sent", align: "right", render: (m) => m.quotes.length, onSelect: (m) => drill(`Quotes sent - ${m.label}`, m.quotes) },
                { header: "Won", align: "right", render: (m) => m.won.length, onSelect: (m) => drill(`Quotes won - ${m.label}`, m.won) },
                { header: "Declined", align: "right", render: (m) => m.lost.length, onSelect: (m) => drill(`Quotes declined - ${m.label}`, m.lost) },
                { header: "Expired", align: "right", render: (m) => m.expired.length, onSelect: (m) => drill(`Quotes expired - ${m.label}`, m.expired) },
                { header: "Pending", align: "right", render: (m) => m.pending.length, onSelect: (m) => drill(`Quotes pending - ${m.label}`, m.pending) },
                { header: "Win rate", align: "right", render: (m) => formatPercent(m.winRate) },
                { header: "Won $", align: "right", render: (m) => formatCentsAsAud(m.wonCents) },
                { header: "Lost $", align: "right", render: (m) => formatCentsAsAud(m.lostCents) },
              ]}
            />
          </Panel>

          <Panel
            title="Why quotes were lost"
            note={
              lostCount === 0
                ? undefined
                : unrecorded > 0
                  ? `${unrecorded} of ${lostCount} lost quote${lostCount === 1 ? " has" : "s have"} no reason recorded. Open a declined or expired quote and choose a "Lost reason" to fill this in.`
                  : "Every lost quote in this timeframe has a reason recorded."
            }
          >
            {reasons.length === 0 ? (
              <Empty>No quotes were declined or expired in this timeframe.</Empty>
            ) : (
              <RankedBars
                format={(v) => String(v)}
                rows={reasons.map((row) => {
                  const name = row.key === "unrecorded" ? "No reason recorded" : QUOTE_LOST_REASON_LABELS[row.key];
                  return {
                    key: row.key,
                    label: name,
                    value: row.quotes.length,
                    detail: formatCentsAsAud(row.cents),
                    onSelect: () => openDrill({ title: `Lost - ${name}`, subtitle: `Quotes issued ${period}`, quotes: row.quotes }),
                  };
                })}
              />
            )}
          </Panel>
        </>
      )}
    </>
  );
}

type UsageSort = "billed" | "timesBilled" | "quantityBilled" | "timesQuoted";

export function PriceBookUsagePage() {
  const { ix, range, openDrill } = useAnalytics();
  const period = usePeriodLabel();
  const lines = usePriceBookLines();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<UsageSort>("billed");

  const rows = useMemo(() => {
    if (!lines.data) return [];
    const itemById = new Map(lines.data.items.map((item) => [item.id, item]));
    const categoryName = new Map(lines.data.categories.map((c) => [c.id, c.name]));
    return priceBookUsage(ix, lines.data.invoiceLines, lines.data.quoteLines, range).map((row) => {
      const item = itemById.get(row.itemId);
      return { ...row, name: item?.description ?? "Deleted item", category: item ? categoryName.get(item.category_id) ?? "" : "" };
    });
  }, [ix, lines.data, range]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)) : rows;
    const by: Record<UsageSort, (r: (typeof rows)[number]) => number> = {
      billed: (r) => r.billedCents,
      timesBilled: (r) => r.timesBilled,
      quantityBilled: (r) => r.quantityBilled,
      timesQuoted: (r) => r.timesQuoted,
    };
    return [...filtered].sort((a, b) => by[sort](b) - by[sort](a) || a.name.localeCompare(b.name));
  }, [rows, search, sort]);

  const invoiceById = useMemo(() => new Map(ix.invoices.map((inv) => [inv.id, inv])), [ix]);
  const quoteById = useMemo(() => new Map(ix.quotes.map((q) => [q.id, q])), [ix]);
  const quantity = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

  return (
    <>
      <PageHeading
        title="Price Book usage"
        description="How often each Price Book item was billed (on invoices issued in the timeframe) and quoted. Amounts are line totals before GST. Lines typed in as custom items aren't counted, and lines added before this report existed are only counted where their description still matches a Price Book item exactly."
      />
      {lines.error ? (
        <Empty>Couldn't load line items: {lines.error instanceof Error ? lines.error.message : "unknown error"}</Empty>
      ) : !lines.data ? (
        <Empty>Loading line items...</Empty>
      ) : rows.length === 0 ? (
        <Empty>No Price Book items were billed or quoted in this timeframe.</Empty>
      ) : (
        <>
          <Panel title="Most billed items">
            <RankedBars
              limit={10}
              format={formatCentsAsAud}
              rows={[...rows]
                .sort((a, b) => b.billedCents - a.billedCents)
                .filter((r) => r.billedCents > 0)
                .map((row) => ({
                  key: row.itemId,
                  label: row.name,
                  value: row.billedCents,
                  detail: `billed ${row.timesBilled}x, qty ${quantity(row.quantityBilled)}`,
                  onSelect: () =>
                    openDrill({ title: row.name, subtitle: `Invoices issued ${period} with this item`, invoices: row.invoiceIds.flatMap((id) => invoiceById.get(id) ?? []) }),
                }))}
            />
          </Panel>
          <Panel
            actions={
              <>
                <input
                  type="text"
                  placeholder="Search items..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-56 rounded-md px-3 py-1.5 focus:outline-none"
                  style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
                />
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as UsageSort)}
                  aria-label="Sort by"
                  className="rounded-md px-2 py-1.5"
                  style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
                >
                  <option value="billed">Sort: billed $</option>
                  <option value="timesBilled">Sort: times billed</option>
                  <option value="quantityBilled">Sort: quantity billed</option>
                  <option value="timesQuoted">Sort: times quoted</option>
                </select>
                <ExportButton
                  onClick={() =>
                    downloadCsv(
                      `price-book-usage-${range.from}-to-${range.to}.csv`,
                      ["Item", "Category", "Times billed", "Quantity billed", "Billed ex GST ($)", "Times quoted", "Quantity quoted", "Quoted ex GST ($)"],
                      visible.map((r) => [r.name, r.category, r.timesBilled, r.quantityBilled, dollars(r.billedCents), r.timesQuoted, r.quantityQuoted, dollars(r.quotedCents)])
                    )
                  }
                />
              </>
            }
          >
            <DataTable
              rows={visible}
              rowKey={(r) => r.itemId}
              columns={[
                { header: "Item", render: (r) => r.name },
                { header: "Category", render: (r) => r.category },
                {
                  header: "Times billed",
                  align: "right",
                  render: (r) => r.timesBilled,
                  onSelect: (r) =>
                    r.invoiceIds.length ? () => openDrill({ title: r.name, subtitle: `Invoices issued ${period} with this item`, invoices: r.invoiceIds.flatMap((id) => invoiceById.get(id) ?? []) }) : undefined,
                },
                { header: "Quantity", align: "right", render: (r) => quantity(r.quantityBilled) },
                { header: "Billed", align: "right", render: (r) => formatCentsAsAud(r.billedCents) },
                {
                  header: "Times quoted",
                  align: "right",
                  render: (r) => r.timesQuoted,
                  onSelect: (r) =>
                    r.quoteIds.length ? () => openDrill({ title: r.name, subtitle: `Quotes issued ${period} with this item`, quotes: r.quoteIds.flatMap((id) => quoteById.get(id) ?? []) }) : undefined,
                },
                { header: "Qty quoted", align: "right", render: (r) => quantity(r.quantityQuoted) },
              ]}
            />
            {visible.length === 0 ? <Empty>No items match "{search}".</Empty> : null}
          </Panel>
        </>
      )}
    </>
  );
}

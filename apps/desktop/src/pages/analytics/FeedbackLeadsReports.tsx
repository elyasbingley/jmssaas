import { useMemo } from "react";
import { Link } from "react-router-dom";
import { feedbackByMonth, formatCentsAsAud, leadSourcePerformance, recentFeedback } from "@jmssaas/shared";
import { useAnalytics } from "./data";
import { ACCENT, Columns, DataTable, Empty, ExportButton, PageHeading, Panel, RankedBars, Stars, StatTile, dollars, downloadCsv, formatDay, formatPercent } from "./ui";

const FEEDBACK_SOURCE = "Ratings are the Google review stars recorded on each client's card - one rating per client, dated when it was recorded.";

export function FeedbackByMonthPage() {
  const { ix, range, openDrill } = useAnalytics();
  const months = useMemo(() => feedbackByMonth(ix, range), [ix, range]);
  const clients = months.flatMap((m) => m.clients);
  const average = clients.length > 0 ? clients.reduce((sum, c) => sum + (c.google_review_stars ?? 0), 0) / clients.length : null;
  const fiveStar = clients.filter((c) => c.google_review_stars === 5).length;

  return (
    <>
      <PageHeading title="Feedback by month" description={`Average rating and number of reviews for each month of the timeframe. ${FEEDBACK_SOURCE}`} />
      {clients.length === 0 ? (
        <Empty>No reviews were recorded in this timeframe.</Empty>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-3 gap-4">
            <StatTile label="Average rating" value={`${average!.toFixed(1)} / 5`} sub={<Stars value={average!} />} />
            <StatTile label="Reviews recorded" value={String(clients.length)} onClick={() => openDrill({ title: "Reviews recorded", clients })} />
            <StatTile label="Five-star reviews" value={formatPercent((fiveStar / clients.length) * 100)} sub={`${fiveStar} of ${clients.length}`} />
          </div>
          <Panel title="Average rating by month" note="Months with no reviews show no column.">
            <Columns
              max={5}
              series={[{ name: "average stars", color: ACCENT }]}
              format={(v) => (v === 0 ? "none" : v.toFixed(1))}
              tick={(v) => String(v)}
              periods={months.map((m) => ({
                key: m.month,
                label: m.label,
                values: [m.average ?? 0],
                onSelect: m.clients.length ? () => openDrill({ title: `Reviews - ${m.label}`, clients: m.clients }) : undefined,
              }))}
            />
          </Panel>
          <Panel
            actions={
              <ExportButton
                onClick={() =>
                  downloadCsv(
                    `feedback-by-month-${range.from}-to-${range.to}.csv`,
                    ["Month", "Reviews", "Average stars"],
                    months.map((m) => [m.label, m.clients.length, m.average === null ? "" : Number(m.average.toFixed(2))])
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
                { header: "Reviews", align: "right", render: (m) => m.clients.length, onSelect: (m) => (m.clients.length ? () => openDrill({ title: `Reviews - ${m.label}`, clients: m.clients }) : undefined) },
                { header: "Average", align: "right", render: (m) => (m.average === null ? "-" : m.average.toFixed(1)) },
              ]}
              footer={["Total", clients.length, average!.toFixed(1)]}
            />
          </Panel>
        </>
      )}
    </>
  );
}

export function FeedbackRecentPage() {
  const { ix } = useAnalytics();
  const recent = useMemo(() => recentFeedback(ix, 50), [ix]);
  return (
    <>
      <PageHeading title="Recent feedback" description={`The 50 most recently recorded reviews, newest first. ${FEEDBACK_SOURCE}`} />
      {recent.length === 0 ? (
        <Empty>No reviews have been recorded yet. Record one from a client's card.</Empty>
      ) : (
        <Panel>
          <DataTable
            rows={recent}
            rowKey={(c) => c.id}
            columns={[
              {
                header: "Client",
                render: (c) => (
                  <Link to={`/clients/${c.id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                    {c.name}
                  </Link>
                ),
              },
              { header: "Rating", render: (c) => <Stars value={c.google_review_stars ?? 0} /> },
              { header: "Stars", align: "right", render: (c) => c.google_review_stars },
              { header: "Recorded", align: "right", render: (c) => formatDay(c.google_review_recorded_at) },
            ]}
          />
        </Panel>
      )}
    </>
  );
}

export function LeadSourcesPage() {
  const { ix, range, openDrill } = useAnalytics();
  const rows = useMemo(() => leadSourcePerformance(ix, range), [ix, range]);
  const period = `${formatDay(range.from)} - ${formatDay(range.to)}`;
  const leads = rows.reduce((sum, r) => sum + r.leads.length, 0);
  const converted = rows.reduce((sum, r) => sum + r.converted.length, 0);
  const revenue = rows.reduce((sum, r) => sum + r.completedRevenueCents, 0);

  return (
    <>
      <PageHeading
        title="Lead sources"
        description="Where new jobs came from. A lead is a job created in the timeframe; it converted if it went on to an accepted quote, an issued invoice or completion. Completed revenue is what was invoiced (inc. GST) against the leads that have been completed. Set a job's lead source on the job itself."
      />
      {rows.length === 0 ? (
        <Empty>No jobs were created in this timeframe.</Empty>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-3 gap-4">
            <StatTile label="Leads" value={String(leads)} />
            <StatTile label="Converted" value={formatPercent(leads > 0 ? (converted / leads) * 100 : null)} sub={`${converted} of ${leads}`} />
            <StatTile label="Completed job revenue" value={formatCentsAsAud(revenue)} />
          </div>
          <Panel title="Leads by source">
            <RankedBars
              format={(v) => String(v)}
              rows={rows.map((r) => ({
                key: r.key,
                label: r.label,
                value: r.leads.length,
                detail: `${formatPercent(r.conversionRate)} converted`,
                onSelect: () => openDrill({ title: `Leads - ${r.label}`, subtitle: `Jobs created ${period}`, jobs: r.leads }),
              }))}
            />
          </Panel>
          <Panel
            actions={
              <ExportButton
                onClick={() =>
                  downloadCsv(
                    `lead-sources-${range.from}-to-${range.to}.csv`,
                    ["Source", "Leads", "Converted", "Conversion rate (%)", "Completed jobs", "Completed revenue inc GST ($)"],
                    rows.map((r) => [r.label, r.leads.length, r.converted.length, r.conversionRate === null ? "" : Number(r.conversionRate.toFixed(1)), r.completed.length, dollars(r.completedRevenueCents)])
                  )
                }
              />
            }
          >
            <DataTable
              rows={rows}
              rowKey={(r) => r.key}
              columns={[
                { header: "Source", render: (r) => r.label },
                { header: "Leads", align: "right", render: (r) => r.leads.length, onSelect: (r) => () => openDrill({ title: `Leads - ${r.label}`, subtitle: `Jobs created ${period}`, jobs: r.leads }) },
                {
                  header: "Converted",
                  align: "right",
                  render: (r) => r.converted.length,
                  onSelect: (r) => (r.converted.length ? () => openDrill({ title: `Converted - ${r.label}`, subtitle: `Jobs created ${period}`, jobs: r.converted }) : undefined),
                },
                { header: "Conversion", align: "right", render: (r) => formatPercent(r.conversionRate) },
                {
                  header: "Completed jobs",
                  align: "right",
                  render: (r) => r.completed.length,
                  onSelect: (r) => (r.completed.length ? () => openDrill({ title: `Completed - ${r.label}`, subtitle: `Jobs created ${period}`, jobs: r.completed }) : undefined),
                },
                {
                  header: "Completed revenue",
                  align: "right",
                  render: (r) => formatCentsAsAud(r.completedRevenueCents),
                  onSelect: (r) => (r.completedInvoices.length ? () => openDrill({ title: `Revenue - ${r.label}`, subtitle: `Invoices on completed jobs created ${period}`, invoices: r.completedInvoices }) : undefined),
                },
              ]}
              footer={["Total", leads, converted, formatPercent(leads > 0 ? (converted / leads) * 100 : null), rows.reduce((s, r) => s + r.completed.length, 0), formatCentsAsAud(revenue)]}
            />
          </Panel>
        </>
      )}
    </>
  );
}

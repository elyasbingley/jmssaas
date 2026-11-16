import { useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { agedReceivables, computeKpis, formatCentsAsAud, leadSourcePerformance, quotePipeline, revenueByCategory } from "@jmssaas/shared";
import { useAnalytics } from "./data";
import { Delta, Empty, Panel, RankedBars, StatTile, formatDay, formatPercent } from "./ui";

// The landing page: the eight headline numbers for the chosen timeframe,
// each against the comparison period and each opening the records behind
// it, then the two "money waiting" totals and a first look at where
// revenue and leads came from.
export default function DashboardPage() {
  const { ix, range, compare, today, openDrill } = useAnalytics();
  const { search } = useLocation();
  const k = useMemo(() => computeKpis(ix, range), [ix, range]);
  const prev = useMemo(() => computeKpis(ix, compare), [ix, compare]);
  const receivables = useMemo(() => agedReceivables(ix, today), [ix, today]);
  const pipeline = useMemo(() => quotePipeline(ix, today), [ix, today]);
  const categories = useMemo(() => revenueByCategory(ix, range), [ix, range]);
  const sources = useMemo(() => leadSourcePerformance(ix, range), [ix, range]);

  const period = `${formatDay(range.from)} - ${formatDay(range.to)}`;
  const outstandingCents = receivables.reduce((sum, b) => sum + b.cents, 0);
  const outstandingCount = receivables.reduce((sum, b) => sum + b.invoices.length, 0);
  const pipelineCents = pipeline.reduce((sum, b) => sum + b.cents, 0);
  const pipelineCount = pipeline.reduce((sum, b) => sum + b.quotes.length, 0);
  const decided = k.quotes.won.length + k.quotes.lost.length + k.quotes.expired.length;
  const more = (to: string, text: string) => (
    <Link to={{ pathname: to, search }} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
      {text}
    </Link>
  );

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile
          label="Revenue"
          value={formatCentsAsAud(k.revenueCents)}
          sub={`Invoiced, inc. GST · ${formatCentsAsAud(k.collectedCents)} collected`}
          delta={<Delta current={k.revenueCents} previous={prev.revenueCents} />}
          onClick={() => openDrill({ title: "Revenue", subtitle: `Invoices issued ${period}`, invoices: k.revenueInvoices })}
        />
        <StatTile
          label="Jobs completed"
          value={String(k.jobsCompleted.length)}
          delta={<Delta current={k.jobsCompleted.length} previous={prev.jobsCompleted.length} />}
          onClick={() => openDrill({ title: "Jobs completed", subtitle: period, jobs: k.jobsCompleted })}
        />
        <StatTile
          label="Average job value"
          value={k.averageJobValueCents === null ? "-" : formatCentsAsAud(k.averageJobValueCents)}
          sub={k.invoicedJobCount > 0 ? `Across ${k.invoicedJobCount} invoiced job${k.invoicedJobCount === 1 ? "" : "s"}` : "No jobs invoiced"}
          delta={<Delta current={k.averageJobValueCents} previous={prev.averageJobValueCents} />}
          onClick={() => openDrill({ title: "Average job value", subtitle: `Invoices on jobs, issued ${period}`, invoices: k.revenueInvoices.filter((inv) => inv.job_card_id) })}
        />
        <StatTile
          label="Quote win rate"
          value={formatPercent(k.quotes.winRate)}
          sub={decided > 0 ? `${k.quotes.won.length} won of ${decided} decided · ${k.quotes.pending.length} pending` : `${k.quotes.pending.length} pending, none decided`}
          delta={<Delta current={k.quotes.winRate} previous={prev.quotes.winRate} unit="pts" />}
          onClick={() => openDrill({ title: "Quotes", subtitle: `Issued ${period}`, quotes: k.quotes.quotes })}
        />
        <StatTile
          label="First time fix rate"
          value={formatPercent(k.firstTimeFixRate)}
          sub={k.firstTimeFixEligible.length > 0 ? `${k.calledBackJobs.length} of ${k.firstTimeFixEligible.length} completed jobs needed a callback` : "No completed jobs"}
          delta={<Delta current={k.firstTimeFixRate} previous={prev.firstTimeFixRate} unit="pts" />}
          onClick={() => openDrill({ title: "Jobs that needed a callback", subtitle: `Completed ${period}`, jobs: k.calledBackJobs })}
        />
        <StatTile
          label="Return customer rate"
          value={formatPercent(k.returnCustomerRate)}
          sub={`${k.returnCustomerJobs.length} of ${k.returnCustomerJobs.length + k.newCustomerJobs.length} new jobs were for an existing client`}
          delta={<Delta current={k.returnCustomerRate} previous={prev.returnCustomerRate} unit="pts" />}
          onClick={() => openDrill({ title: "Jobs for returning clients", subtitle: `Created ${period}`, jobs: k.returnCustomerJobs })}
        />
        <StatTile
          label="Days to payment"
          value={k.daysToPayment === null ? "-" : k.daysToPayment.toFixed(1)}
          sub={k.paidInvoices.length > 0 ? `Average over ${k.paidInvoices.length} invoice${k.paidInvoices.length === 1 ? "" : "s"} paid` : "No invoices paid"}
          delta={<Delta current={k.daysToPayment} previous={prev.daysToPayment} goodWhenUp={false} unit="days" />}
          onClick={() => openDrill({ title: "Invoices paid", subtitle: period, invoices: k.paidInvoices })}
        />
        <StatTile
          label="Customer feedback"
          value={k.feedbackAverage === null ? "-" : `${k.feedbackAverage.toFixed(1)} / 5`}
          sub={k.feedbackClients.length > 0 ? `${k.feedbackClients.length} Google review${k.feedbackClients.length === 1 ? "" : "s"} recorded` : "No reviews recorded"}
          delta={<Delta current={k.feedbackAverage} previous={prev.feedbackAverage} unit="stars" />}
          onClick={() => openDrill({ title: "Reviews recorded", subtitle: period, clients: k.feedbackClients })}
        />
      </div>

      <div className="mb-5 grid grid-cols-2 gap-4">
        <StatTile
          label="Unpaid invoices, right now"
          value={formatCentsAsAud(outstandingCents)}
          sub={
            <>
              {outstandingCount} invoice{outstandingCount === 1 ? "" : "s"} · {formatCentsAsAud(receivables[2]?.cents ?? 0)} over 60 days old · {more("/analytics/revenue/receivables", "Aged receivables")}
            </>
          }
        />
        <StatTile
          label="Quotes awaiting a decision, right now"
          value={formatCentsAsAud(pipelineCents)}
          sub={
            <>
              {pipelineCount} quote{pipelineCount === 1 ? "" : "s"} · {formatCentsAsAud(pipeline[3]?.cents ?? 0)} waiting over 30 days · {more("/analytics/revenue/pipeline", "Quote pipeline")}
            </>
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Revenue by category" actions={more("/analytics/revenue/category", "Full report")}>
          {categories.length === 0 ? (
            <Empty>No invoices issued in this timeframe.</Empty>
          ) : (
            <RankedBars
              limit={6}
              format={formatCentsAsAud}
              rows={categories.map((row) => ({
                key: row.key,
                label: row.label,
                value: row.cents,
                onSelect: () => openDrill({ title: `Revenue - ${row.label}`, subtitle: period, invoices: row.invoices }),
              }))}
            />
          )}
        </Panel>
        <Panel title="Leads by source" actions={more("/analytics/leads", "Full report")}>
          {sources.length === 0 ? (
            <Empty>No jobs created in this timeframe.</Empty>
          ) : (
            <RankedBars
              limit={6}
              format={(v) => String(v)}
              rows={sources.map((row) => ({
                key: row.key,
                label: row.label,
                value: row.leads.length,
                detail: `${formatPercent(row.conversionRate)} converted`,
                onSelect: () => openDrill({ title: `Leads - ${row.label}`, subtitle: `Jobs created ${period}`, jobs: row.leads }),
              }))}
            />
          )}
        </Panel>
      </div>
    </>
  );
}

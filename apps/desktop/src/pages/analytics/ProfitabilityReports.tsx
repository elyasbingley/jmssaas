import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  averageLabourCostPerHourCents,
  calculateCostOfOperations,
  calculateLabour,
  calculateOperatingExpenses,
  formatCentsAsAud,
  jobActuals,
  lineItemLabourCostCents,
  lineItemLabourHours,
  lineItemMaterialCostCents,
  lineItemSubcontractorCostCents,
  type Client,
  type CostOfOpsSettings,
  type InvoiceLineItem,
  type JobCard,
  type LabourCostEntry,
  type LineItemCrewInput,
  type LineItemMaterialInput,
  type OperatingExpense,
  type QuoteLineItem,
  type TimesheetActivity,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { fetchAllRows, useAnalytics } from "./data";
import { PageHeading } from "./ui";

// Job Profitability and Cost of Ops Coverage - the two reports the old
// single-page Analytics screen already had, moved under the new report
// menu with their maths untouched (same margin basis as Job Costing).
// They need every line item with its crew/material breakdown, which no
// other report does, so that heavier load lives here rather than in the
// layout's shared one. All reads page through fetchAllRows - the previous
// version filtered line items with .in(<every quote id>), which stops
// working once the id list no longer fits in a URL.

type JobCardRow = JobCard & { clients: Client | null };
type QuoteRow = {
  id: string;
  job_card_id: string | null;
  quote_number: string;
  status: string;
  total_cents: number;
  issue_date: string;
};
type InvoiceRow = {
  id: string;
  job_card_id: string | null;
  invoice_number: string;
  status: string;
  total_cents: number;
  issue_date: string;
  paid_at: string | null;
};

async function fetchCostOfOpsSettings(): Promise<CostOfOpsSettings | null> {
  const { data, error } = await supabase.from("cost_of_ops_settings").select("*").maybeSingle();
  if (error) throw error;
  return data as CostOfOpsSettings | null;
}

function groupById<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push(row);
  }
  return map;
}

async function fetchCostingRows() {
  const [jobCards, quotes, invoices, quoteLineItems, invoiceLineItems, quoteCrew, quoteMaterials, invoiceCrew, invoiceMaterials, costOfOpsSettings, labourCostEntries, operatingExpenses, timesheetActivities] =
    await Promise.all([
      fetchAllRows<JobCardRow>("job_cards", "*, clients(*)"),
      fetchAllRows<QuoteRow>("quotes", "id, job_card_id, quote_number, status, total_cents, issue_date"),
      fetchAllRows<InvoiceRow>("invoices", "id, job_card_id, invoice_number, status, total_cents, issue_date, paid_at"),
      // Only the option each quote counts as (quote options).
      fetchAllRows<QuoteLineItem>("quote_line_items", "*", (query) => query.eq("in_quote_total", true)),
      fetchAllRows<InvoiceLineItem>("invoice_line_items", "*"),
      fetchAllRows<LineItemCrewInput & { quote_line_item_id: string }>("quote_line_item_crew", "*"),
      fetchAllRows<LineItemMaterialInput & { quote_line_item_id: string }>("quote_line_item_materials", "*"),
      fetchAllRows<LineItemCrewInput & { invoice_line_item_id: string }>("invoice_line_item_crew", "*"),
      fetchAllRows<LineItemMaterialInput & { invoice_line_item_id: string }>("invoice_line_item_materials", "*"),
      fetchCostOfOpsSettings(),
      fetchAllRows<LabourCostEntry>("labour_cost_entries", "*"),
      fetchAllRows<OperatingExpense>("operating_expenses", "*"),
      fetchAllRows<TimesheetActivity>("timesheet_activities", "*", (query) => query.eq("activity_type", "job")),
    ]);
  return { jobCards, quotes, invoices, quoteLineItems, invoiceLineItems, quoteCrew, quoteMaterials, invoiceCrew, invoiceMaterials, costOfOpsSettings, labourCostEntries, operatingExpenses, timesheetActivities };
}

function useCostingData() {
  const { data, error } = useQuery({ queryKey: ["analytics", "costing"], queryFn: fetchCostingRows, staleTime: 60_000 });
  const jobCards = data?.jobCards;
  const quotes = data?.quotes;
  const invoices = data?.invoices;
  const quoteLineItems = data?.quoteLineItems;
  const invoiceLineItems = data?.invoiceLineItems;
  const quoteLineItemCrew = data?.quoteCrew;
  const quoteLineItemMaterials = data?.quoteMaterials;
  const invoiceLineItemCrew = data?.invoiceCrew;
  const invoiceLineItemMaterials = data?.invoiceMaterials;
  const costOfOpsSettings = data?.costOfOpsSettings;
  const labourCostEntries = data?.labourCostEntries;
  const operatingExpenses = data?.operatingExpenses;

  // Tenant's own true labour cost ($/hr, from Cost of Ops' Labour roster),
  // not whatever rate a legacy line was priced at - same reasoning as Job
  // Costing's identical trueLabourRateCents (this page used to duplicate
  // the pre-fix formula, always costing a legacy line at its own quoted
  // rate - see lineItemLabourCostCents' own comment in money.ts).
  const trueLabourRateCents = useMemo(() => {
    if (!costOfOpsSettings || !labourCostEntries) return 0;
    return averageLabourCostPerHourCents(calculateLabour(labourCostEntries, costOfOpsSettings));
  }, [costOfOpsSettings, labourCostEntries]);

  // Same weekly/monthly target the Cost of Ops page itself shows
  // (labour roster cost + operating expenses, the literal cash the
  // business needs this week/month) - "Raw", not efficiency-adjusted:
  // the adjusted figures exist for pricing decisions ("what to charge per
  // hour given realistic efficiency"), not for "how much cash is actually
  // needed", which is just the real wage/overhead total regardless of how
  // efficiently it gets billed.
  const costOfOperations = useMemo(() => {
    if (!costOfOpsSettings || !labourCostEntries || !operatingExpenses) return null;
    const opex = calculateOperatingExpenses(operatingExpenses, costOfOpsSettings);
    const labour = calculateLabour(labourCostEntries, costOfOpsSettings);
    return calculateCostOfOperations(opex, labour, costOfOpsSettings);
  }, [costOfOpsSettings, labourCostEntries, operatingExpenses]);

  const quoteLineItemsByQuote = useMemo(() => {
    const crewByItem = groupById(quoteLineItemCrew ?? [], (r) => r.quote_line_item_id);
    const materialsByItem = groupById(quoteLineItemMaterials ?? [], (r) => r.quote_line_item_id);
    const map = new Map<string, QuoteLineItem[]>();
    for (const rawItem of quoteLineItems ?? []) {
      const item = { ...rawItem, crew: crewByItem.get(rawItem.id) ?? [], materials: materialsByItem.get(rawItem.id) ?? [] };
      if (!map.has(item.quote_id)) map.set(item.quote_id, []);
      map.get(item.quote_id)!.push(item);
    }
    return map;
  }, [quoteLineItems, quoteLineItemCrew, quoteLineItemMaterials]);
  const invoiceLineItemsByInvoice = useMemo(() => {
    const crewByItem = groupById(invoiceLineItemCrew ?? [], (r) => r.invoice_line_item_id);
    const materialsByItem = groupById(invoiceLineItemMaterials ?? [], (r) => r.invoice_line_item_id);
    const map = new Map<string, InvoiceLineItem[]>();
    for (const rawItem of invoiceLineItems ?? []) {
      const item = { ...rawItem, crew: crewByItem.get(rawItem.id) ?? [], materials: materialsByItem.get(rawItem.id) ?? [] };
      if (!map.has(item.invoice_id)) map.set(item.invoice_id, []);
      map.get(item.invoice_id)!.push(item);
    }
    return map;
  }, [invoiceLineItems, invoiceLineItemCrew, invoiceLineItemMaterials]);

  // Time actually logged against each job (every 'job' timesheet activity,
  // not just this timeframe's - a job's hours belong to the job), costed
  // at each person's own hourly cost from the Cost of Ops labour roster.
  // Someone who isn't on the roster is costed at the blended rate.
  const timesheetActivities = data?.timesheetActivities;
  const actualsByJob = useMemo(() => {
    const rates = new Map<string, number>();
    if (costOfOpsSettings && labourCostEntries) {
      for (const result of calculateLabour(labourCostEntries, costOfOpsSettings).entries) {
        if (result.entry.profile_id && result.costPerHourCents > 0) rates.set(result.entry.profile_id, result.costPerHourCents);
      }
    }
    return jobActuals(timesheetActivities ?? [], rates, trueLabourRateCents, new Date().toISOString());
  }, [timesheetActivities, costOfOpsSettings, labourCostEntries, trueLabourRateCents]);

  return { jobCards, quotes, invoices, quoteLineItemsByQuote, invoiceLineItemsByInvoice, trueLabourRateCents, costOfOperations, actualsByJob, isLoading: !data, error };
}

function LoadState({ error }: { error: unknown }) {
  return (
    <p style={{ color: error ? "var(--jms-danger)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
      {error ? `Couldn't load: ${error instanceof Error ? error.message : "unknown error"}` : "Loading line items..."}
    </p>
  );
}

function inRange(dateStr: string | null, from: string, to: string): boolean {
  if (!dateStr) return false;
  const d = dateStr.slice(0, 10);
  return d >= from && d <= to;
}

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}
function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, 1).toLocaleDateString("en-AU", { month: "short", year: "2-digit" });
}

// ISO-ish week (Monday-Sunday) bucketing for the Cost of Ops Coverage
// section below - same "slice to a string key, compare as strings" shape
// as monthKey/monthLabel/monthsBetween above, just at week granularity.
// Deliberately never round-trips through toISOString() for the output
// key - that converts to UTC, which rolls a local midnight back a whole
// day for any positive UTC offset (all of Australia, year-round). Reads
// the Date's own local getFullYear/getMonth/getDate instead, since this
// is plain local-calendar-day arithmetic throughout, never a real instant.
function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00`);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return toDateKey(d);
}
function weekKey(dateStr: string): string {
  return mondayOf(dateStr);
}
function weekLabel(key: string): string {
  const start = new Date(`${key}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  return `${fmt(start)} - ${fmt(end)}`;
}
// Last `count` Monday-Sunday weeks, oldest first, ending with the week
// containing today.
function recentWeeks(count: number): string[] {
  const todayKey = mondayOf(toDateKey(new Date()));
  const weeks: string[] = [];
  const cursor = new Date(`${todayKey}T00:00:00`);
  for (let i = 0; i < count; i++) {
    weeks.unshift(toDateKey(cursor));
    cursor.setDate(cursor.getDate() - 7);
  }
  return weeks;
}
// Last `count` calendar months, oldest first, ending with the current one.
function recentMonths(count: number): string[] {
  const now = new Date();
  const months: string[] = [];
  const cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = 0; i < count; i++) {
    months.unshift(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
    cursor.setMonth(cursor.getMonth() - 1);
  }
  return months;
}

function downloadCsv(filename: string, header: string, rows: string[]) {
  const blob = new Blob([`${header}\n${rows.join("\n")}`], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

interface JobProfitRow {
  job: JobCardRow;
  labourCents: number;
  materialCents: number;
  subcontractorCents: number;
  chargedCents: number;
  marginCents: number;
  marginPercent: number;
  // Labour hours the job was priced on, and what the timesheets say it took.
  plannedHours: number;
  actualMinutes: number;
  actualLabourCents: number;
}

export function CostOfOpsCoveragePage() {
  const { invoices, invoiceLineItemsByInvoice, trueLabourRateCents, costOfOperations, isLoading, error } = useCostingData();
  const [cooViewMode, setCooViewMode] = useState<"weekly" | "monthly">("weekly");

  // Only the labour-cost portion of each paid invoice's line items - never
  // materials, subcontractor cost, profit margin, or GST, per the explicit
  // ask: that's the slice of what a client paid that actually corresponds
  // to covering the business's own running costs (wages + overhead, same
  // "labour cost + operating expenses" the Cost of Ops page itself totals
  // as weeklyCooRawCents/monthlyCooRawCents). Reuses lineItemLabourCostCents
  // and trueLabourRateCents exactly as Job Profitability below already
  // does, so a legacy line is costed the same way in both places.
  const cooLabourRecoveredByPeriod = useMemo(() => {
    const keyFn = cooViewMode === "weekly" ? weekKey : monthKey;
    const totals = new Map<string, number>();
    for (const inv of invoices ?? []) {
      const paidAt = inv.paid_at;
      if (inv.status !== "paid" || !paidAt) continue;
      const key = keyFn(paidAt);
      const items = invoiceLineItemsByInvoice.get(inv.id) ?? [];
      const labourCents = items.reduce((sum, item) => sum + lineItemLabourCostCents(item, trueLabourRateCents), 0);
      totals.set(key, (totals.get(key) ?? 0) + labourCents);
    }
    return totals;
  }, [invoices, invoiceLineItemsByInvoice, trueLabourRateCents, cooViewMode]);

  const cooPeriods = useMemo(() => {
    const keys = cooViewMode === "weekly" ? recentWeeks(8) : recentMonths(6);
    const targetCents = cooViewMode === "weekly" ? costOfOperations?.weeklyCooRawCents ?? 0 : costOfOperations?.monthlyCooRawCents ?? 0;
    return keys.map((key) => {
      const recoveredCents = cooLabourRecoveredByPeriod.get(key) ?? 0;
      return {
        key,
        label: cooViewMode === "weekly" ? weekLabel(key) : monthLabel(key),
        targetCents,
        recoveredCents,
        differenceCents: recoveredCents - targetCents,
      };
    });
  }, [cooViewMode, cooLabourRecoveredByPeriod, costOfOperations]);

  const currentCooPeriod = cooPeriods[cooPeriods.length - 1];

  const exportCooCsv = () => {
    downloadCsv(
      `cost-of-ops-coverage-${cooViewMode}.csv`,
      "Period,Target ($),Labour Recovered ($),Difference ($)",
      cooPeriods.map(
        (p) => `${p.label},${(p.targetCents / 100).toFixed(2)},${(p.recoveredCents / 100).toFixed(2)},${(p.differenceCents / 100).toFixed(2)}`
      )
    );
  };

  if (isLoading) return <LoadState error={error} />;
  return (
    <>
      <PageHeading title="Cost of Ops coverage" description="Whether the labour recovered from paid invoices is covering what it costs to run the business. Always shows the latest weeks or months, whatever timeframe is selected." />
      <div className="mb-6 rounded-lg p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Cost of Ops Coverage
            </h2>
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Labour cost recovered from paid invoices (never materials, profit, or GST) against the weekly/monthly target set in
              Settings &gt; Cost of Ops.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCooViewMode("weekly")}
              className="rounded-md border px-3 py-1.5 font-semibold"
              style={
                cooViewMode === "weekly"
                  ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                  : { borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
              }
            >
              Weekly
            </button>
            <button
              onClick={() => setCooViewMode("monthly")}
              className="rounded-md border px-3 py-1.5 font-semibold"
              style={
                cooViewMode === "monthly"
                  ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                  : { borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
              }
            >
              Monthly
            </button>
            <button
              onClick={exportCooCsv}
              disabled={cooPeriods.length === 0}
              className="rounded-md px-3 py-1.5 font-semibold disabled:opacity-60"
              style={{ border: "1px solid var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
            >
              Export CSV
            </button>
          </div>
        </div>

        {!costOfOperations ? (
          <p className="py-6 text-center" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Set up{" "}
            <Link to="/settings/cost-of-ops" style={{ color: "var(--jms-accent)" }}>
              Settings &gt; Cost of Ops
            </Link>{" "}
            first (operating expenses + labour roster) to see this.
          </p>
        ) : (
          <>
            {currentCooPeriod ? (
              <div
                className="mb-4 rounded-lg p-4"
                style={{
                  border: `1px solid ${currentCooPeriod.differenceCents >= 0 ? "var(--jms-accent)" : "var(--jms-danger)"}`,
                  backgroundColor: "var(--jms-bg)",
                }}
              >
                <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  {cooViewMode === "weekly" ? "This Week" : "This Month"} ({currentCooPeriod.label})
                </p>
                <div className="mt-2 flex flex-wrap items-baseline gap-6">
                  <div>
                    <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>Target</p>
                    <p className="text-xl font-bold" style={{ color: "var(--jms-text)" }}>
                      {formatCentsAsAud(currentCooPeriod.targetCents)}
                    </p>
                  </div>
                  <div>
                    <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>Labour Recovered</p>
                    <p className="text-xl font-bold" style={{ color: "var(--jms-text)" }}>
                      {formatCentsAsAud(currentCooPeriod.recoveredCents)}
                    </p>
                  </div>
                </div>
                <p
                  className="mt-3 text-lg font-bold"
                  style={{ color: currentCooPeriod.differenceCents >= 0 ? "var(--jms-accent)" : "var(--jms-danger)" }}
                >
                  {currentCooPeriod.differenceCents >= 0
                    ? `${formatCentsAsAud(currentCooPeriod.differenceCents)} over target`
                    : `${formatCentsAsAud(-currentCooPeriod.differenceCents)} short of target`}
                </p>
              </div>
            ) : null}

            <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
              <thead className="uppercase" style={{ borderBottom: "1px solid var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                <tr>
                  <th className="py-2 font-semibold">{cooViewMode === "weekly" ? "Week" : "Month"}</th>
                  <th className="py-2 text-right font-semibold">Target</th>
                  <th className="py-2 text-right font-semibold">Recovered</th>
                  <th className="py-2 text-right font-semibold">Over / Short</th>
                </tr>
              </thead>
              <tbody>
                {cooPeriods.map((p) => (
                  <tr key={p.key} className="last:border-0" style={{ borderBottom: "1px solid var(--jms-border)", color: "var(--jms-text)" }}>
                    <td className="py-2">{p.label}</td>
                    <td className="py-2 text-right">{formatCentsAsAud(p.targetCents)}</td>
                    <td className="py-2 text-right">{formatCentsAsAud(p.recoveredCents)}</td>
                    <td className="py-2 text-right font-semibold" style={{ color: p.differenceCents >= 0 ? "var(--jms-accent)" : "var(--jms-danger)" }}>
                      {p.differenceCents >= 0 ? `+${formatCentsAsAud(p.differenceCents)}` : `-${formatCentsAsAud(-p.differenceCents)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}

export function JobProfitabilityPage() {
  const { range, compare: prevRange } = useAnalytics();
  const { jobCards, quotes, invoices, quoteLineItemsByQuote, invoiceLineItemsByInvoice, trueLabourRateCents, actualsByJob, isLoading, error } = useCostingData();
  const [jobSearch, setJobSearch] = useState("");
  const [jobSortKey, setJobSortKey] = useState<"margin_percent" | "margin" | "charged" | "job_number">("margin_percent");
  const [jobPageSize, setJobPageSize] = useState(30);
  const [jobPage, setJobPage] = useState(1);

  const jobProfitRows: JobProfitRow[] = useMemo(() => {
    if (!jobCards || !quotes || !invoices) return [];
    const quotesByJob = new Map<string, QuoteRow[]>();
    for (const q of quotes) {
      if (!q.job_card_id || !inRange(q.issue_date, range.from, range.to)) continue;
      if (!quotesByJob.has(q.job_card_id)) quotesByJob.set(q.job_card_id, []);
      quotesByJob.get(q.job_card_id)!.push(q);
    }
    const invoicesByJob = new Map<string, InvoiceRow[]>();
    for (const inv of invoices) {
      if (!inv.job_card_id || !inRange(inv.issue_date, range.from, range.to)) continue;
      if (!invoicesByJob.has(inv.job_card_id)) invoicesByJob.set(inv.job_card_id, []);
      invoicesByJob.get(inv.job_card_id)!.push(inv);
    }

    const result: JobProfitRow[] = [];
    for (const job of jobCards) {
      const jobQuotes = quotesByJob.get(job.id) ?? [];
      const jobInvoices = invoicesByJob.get(job.id) ?? [];
      if (jobQuotes.length === 0 && jobInvoices.length === 0) continue;

      const allLineItems = [
        ...jobQuotes.flatMap((q) => quoteLineItemsByQuote.get(q.id) ?? []),
        ...jobInvoices.flatMap((inv) => invoiceLineItemsByInvoice.get(inv.id) ?? []),
      ];
      const labourCents = allLineItems.reduce((sum, item) => sum + lineItemLabourCostCents(item, trueLabourRateCents), 0);
      const materialCents = allLineItems.reduce((sum, item) => sum + lineItemMaterialCostCents(item), 0);
      const subcontractorCents = allLineItems.reduce((sum, item) => sum + lineItemSubcontractorCostCents(item), 0);
      const chargedCents = [...jobQuotes, ...jobInvoices].reduce((sum, doc) => sum + doc.total_cents, 0);
      // Same basis/caveats as Job Costing: charged is GST-inclusive, cost is
      // GST-exclusive, and a quote converted to an invoice within the same
      // window is counted under both.
      const marginCents = chargedCents - (labourCents + materialCents + subcontractorCents);
      const marginPercent = chargedCents > 0 ? (marginCents / chargedCents) * 100 : 0;

      // Planned hours come from one document, not both: the invoice(s) if
      // the job has been invoiced, otherwise the quote(s). Summing both
      // (as the cost columns do, see the note above) would double the
      // plan for any quote that became an invoice.
      const planItems = jobInvoices.length > 0 ? jobInvoices.flatMap((inv) => invoiceLineItemsByInvoice.get(inv.id) ?? []) : jobQuotes.flatMap((q) => quoteLineItemsByQuote.get(q.id) ?? []);
      const plannedHours = planItems.reduce((sum, item) => sum + lineItemLabourHours(item), 0);
      const actual = actualsByJob.get(job.id);

      result.push({
        job,
        labourCents,
        materialCents,
        subcontractorCents,
        chargedCents,
        marginCents,
        marginPercent,
        plannedHours,
        actualMinutes: actual?.minutes ?? 0,
        actualLabourCents: actual?.costCents ?? 0,
      });
    }
    return result;
  }, [jobCards, quotes, invoices, quoteLineItemsByQuote, invoiceLineItemsByInvoice, trueLabourRateCents, actualsByJob, range.from, range.to]);

  const filteredJobRows = jobProfitRows.filter((r) => {
    const q = jobSearch.trim().toLowerCase();
    if (!q) return true;
    return r.job.title.toLowerCase().includes(q) || (r.job.clients?.name ?? "").toLowerCase().includes(q);
  });
  const sortedJobRows = [...filteredJobRows].sort((a, b) => {
    switch (jobSortKey) {
      case "margin":
        return b.marginCents - a.marginCents;
      case "charged":
        return b.chargedCents - a.chargedCents;
      case "job_number":
        return (a.job.number ?? "").localeCompare(b.job.number ?? "");
      case "margin_percent":
      default:
        return b.marginPercent - a.marginPercent;
    }
  });
  const jobPageCount = Math.max(1, Math.ceil(sortedJobRows.length / jobPageSize));
  useEffect(() => {
    setJobPage(1);
  }, [jobSearch, jobPageSize, range.from, range.to]);
  useEffect(() => {
    if (jobPage > jobPageCount) setJobPage(jobPageCount);
  }, [jobPage, jobPageCount]);
  const pagedJobRows = sortedJobRows.slice((jobPage - 1) * jobPageSize, jobPage * jobPageSize);

  const avgMarginPercent =
    filteredJobRows.length > 0 ? filteredJobRows.reduce((sum, r) => sum + r.marginPercent, 0) / filteredJobRows.length : 0;
  const avgMarginPercentPrev = useMemo(() => {
    if (!jobCards || !quotes || !invoices) return 0;
    const quotesByJob = new Map<string, QuoteRow[]>();
    for (const q of quotes) {
      if (!q.job_card_id || !inRange(q.issue_date, prevRange.from, prevRange.to)) continue;
      if (!quotesByJob.has(q.job_card_id)) quotesByJob.set(q.job_card_id, []);
      quotesByJob.get(q.job_card_id)!.push(q);
    }
    const invoicesByJob = new Map<string, InvoiceRow[]>();
    for (const inv of invoices) {
      if (!inv.job_card_id || !inRange(inv.issue_date, prevRange.from, prevRange.to)) continue;
      if (!invoicesByJob.has(inv.job_card_id)) invoicesByJob.set(inv.job_card_id, []);
      invoicesByJob.get(inv.job_card_id)!.push(inv);
    }
    const margins: number[] = [];
    for (const job of jobCards) {
      const jobQuotes = quotesByJob.get(job.id) ?? [];
      const jobInvoices = invoicesByJob.get(job.id) ?? [];
      if (jobQuotes.length === 0 && jobInvoices.length === 0) continue;
      const allLineItems = [
        ...jobQuotes.flatMap((q) => quoteLineItemsByQuote.get(q.id) ?? []),
        ...jobInvoices.flatMap((inv) => invoiceLineItemsByInvoice.get(inv.id) ?? []),
      ];
      const labourCents = allLineItems.reduce((sum, item) => sum + lineItemLabourCostCents(item, trueLabourRateCents), 0);
      const materialCents = allLineItems.reduce((sum, item) => sum + lineItemMaterialCostCents(item), 0);
      const subcontractorCents = allLineItems.reduce((sum, item) => sum + lineItemSubcontractorCostCents(item), 0);
      const chargedCents = [...jobQuotes, ...jobInvoices].reduce((sum, doc) => sum + doc.total_cents, 0);
      const marginCents = chargedCents - (labourCents + materialCents + subcontractorCents);
      margins.push(chargedCents > 0 ? (marginCents / chargedCents) * 100 : 0);
    }
    return margins.length > 0 ? margins.reduce((a, b) => a + b, 0) / margins.length : 0;
  }, [jobCards, quotes, invoices, quoteLineItemsByQuote, invoiceLineItemsByInvoice, trueLabourRateCents, prevRange.from, prevRange.to]);

  const exportJobProfitCsv = () => {
    downloadCsv(
      `job-profitability-${range.from}-to-${range.to}.csv`,
      "Job Number,Job Title,Client,Labour ($),Material ($),Subcontractor ($),Charged ($),Margin ($),Margin (%),Planned hrs,Actual hrs,Actual labour ($)",
      sortedJobRows.map(
        (r) =>
          `${csvCell(r.job.number ?? "Pending")},${csvCell(r.job.title)},${csvCell(r.job.clients?.name ?? "Unknown")},${(
            r.labourCents / 100
          ).toFixed(2)},${(r.materialCents / 100).toFixed(2)},${(r.subcontractorCents / 100).toFixed(2)},${(r.chargedCents / 100).toFixed(2)},${(r.marginCents / 100).toFixed(2)},${r.marginPercent.toFixed(1)},${r.plannedHours.toFixed(2)},${(r.actualMinutes / 60).toFixed(2)},${(r.actualLabourCents / 100).toFixed(2)}`
      )
    );
  };

  if (isLoading) return <LoadState error={error} />;
  return (
    <>
      <PageHeading title="Job profitability" description={`Labour, material and subcontractor cost against what was charged, for every job with a quote or invoice issued in the timeframe. Average margin ${avgMarginPercent.toFixed(1)}% (${avgMarginPercentPrev.toFixed(1)}% in the comparison period).`} />
      <div className="rounded-lg p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Job Profitability
            </h2>
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>Every job with a quote or invoice issued in this range.</p>
          </div>
          <button
            onClick={exportJobProfitCsv}
            disabled={sortedJobRows.length === 0}
            className="rounded-md px-3 py-1.5 font-semibold disabled:opacity-60"
            style={{ border: "1px solid var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
          >
            Export CSV
          </button>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            type="text"
            placeholder="Search by job title or client..."
            value={jobSearch}
            onChange={(e) => setJobSearch(e.target.value)}
            className="w-72 rounded-md px-3 py-2 focus:outline-none"
            style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
          />
          <div className="ml-auto flex items-center gap-2" style={{ fontSize: "var(--jms-font-body)" }}>
            <span style={{ color: "var(--jms-text-muted)" }}>Sort:</span>
            {(
              [
                { value: "margin_percent", label: "Margin %" },
                { value: "margin", label: "Margin $" },
                { value: "charged", label: "Charged" },
                { value: "job_number", label: "Job #" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                onClick={() => setJobSortKey(opt.value)}
                className="rounded-full border px-3 py-1 font-semibold"
                style={
                  jobSortKey === opt.value
                    ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)" }
                    : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)" }
                }
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {sortedJobRows.length === 0 ? (
          <p className="p-6 text-center" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No jobs with a linked quote or invoice in this range.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg" style={{ border: "1px solid var(--jms-border)" }}>
            <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
              <thead className="uppercase" style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                <tr>
                  <th className="px-4 py-2 font-semibold">Job</th>
                  <th className="px-4 py-2 font-semibold">Client</th>
                  <th className="px-4 py-2 text-right font-semibold">Labour</th>
                  <th className="px-4 py-2 text-right font-semibold">Material</th>
                  <th className="px-4 py-2 text-right font-semibold">Subcontractor</th>
                  <th className="px-4 py-2 text-right font-semibold">Charged</th>
                  <th className="px-4 py-2 text-right font-semibold">Margin</th>
                  <th className="px-4 py-2 text-right font-semibold">Margin %</th>
                  <th className="px-4 py-2 text-right font-semibold">Planned hrs</th>
                  <th className="px-4 py-2 text-right font-semibold">Actual hrs</th>
                  <th className="px-4 py-2 text-right font-semibold">Actual labour</th>
                </tr>
              </thead>
              <tbody>
                {pagedJobRows.map((row) => (
                  <tr key={row.job.id} className="jms-nav-link last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                    <td className="px-4 py-3">
                      <Link to={`/jobs/${row.job.id}`} className="font-medium hover:underline" style={{ color: "var(--jms-accent)" }}>
                        {row.job.number ?? "Pending"} - {row.job.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                      {row.job.clients?.name ?? "Unknown"}
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--jms-text)" }}>
                      {formatCentsAsAud(row.labourCents)}
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--jms-text)" }}>
                      {formatCentsAsAud(row.materialCents)}
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--jms-text)" }}>
                      {formatCentsAsAud(row.subcontractorCents)}
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--jms-text)" }}>
                      {formatCentsAsAud(row.chargedCents)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold" style={{ color: row.marginCents < 0 ? "var(--jms-danger)" : "var(--jms-text)" }}>
                      {formatCentsAsAud(row.marginCents)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold" style={{ color: row.marginPercent < 0 ? "var(--jms-danger)" : "var(--jms-text)" }}>
                      {row.marginPercent.toFixed(1)}%
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--jms-text)" }}>
                      {row.plannedHours > 0 ? row.plannedHours.toFixed(1) : "-"}
                    </td>
                    <td
                      className="px-4 py-3 text-right"
                      style={{ color: row.actualMinutes > 0 && row.plannedHours > 0 && row.actualMinutes / 60 > row.plannedHours ? "var(--jms-danger)" : "var(--jms-text)" }}
                    >
                      {row.actualMinutes > 0 ? (row.actualMinutes / 60).toFixed(1) : "-"}
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--jms-text)" }}>
                      {row.actualMinutes > 0 ? formatCentsAsAud(row.actualLabourCents) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {sortedJobRows.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3" style={{ fontSize: "var(--jms-font-body)" }}>
            <div className="flex items-center gap-2" style={{ color: "var(--jms-text-muted)" }}>
              <span>Show</span>
              <select
                value={jobPageSize}
                onChange={(e) => setJobPageSize(Number(e.target.value))}
                className="rounded-md px-2 py-1"
                style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text)" }}
              >
                {[30, 60, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
              <span>
                per page - {(jobPage - 1) * jobPageSize + 1}-{Math.min(jobPage * jobPageSize, sortedJobRows.length)} of{" "}
                {sortedJobRows.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setJobPage((p) => Math.max(1, p - 1))}
                disabled={jobPage <= 1}
                className="rounded-md px-3 py-1.5 font-semibold disabled:opacity-40"
                style={{ border: "1px solid var(--jms-border)", color: "var(--jms-text-muted)" }}
              >
                Previous
              </button>
              <span style={{ color: "var(--jms-text-muted)" }}>
                Page {jobPage} of {jobPageCount}
              </span>
              <button
                onClick={() => setJobPage((p) => Math.min(jobPageCount, p + 1))}
                disabled={jobPage >= jobPageCount}
                className="rounded-md px-3 py-1.5 font-semibold disabled:opacity-40"
                style={{ border: "1px solid var(--jms-border)", color: "var(--jms-text-muted)" }}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}

        <p className="mt-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Total charged is GST-inclusive while labour/material cost are GST-exclusive, so margin here slightly overstates the true
          figure. A quote that's since been converted to an invoice within the same window is counted under both - same basis as
          the Job Costing report.{" "}
          {trueLabourRateCents > 0
            ? `A legacy (non-itemised) line is costed at ${formatCentsAsAud(trueLabourRateCents)}/hr (the blended true cost from Settings > Cost of Ops > Labour), not whatever rate it was priced at.`
            : "A legacy (non-itemised) line is costed at its own quoted rate - set up a roster in Settings > Cost of Ops > Labour to cost it against your real labour cost instead."}{" "}
          An itemised line is always costed from its own crew/labour cost rate and materials, regardless of the above. Planned hrs is the labour the job was priced on (its invoice, or its quote if not yet invoiced). Actual hrs is all time logged against the job on timesheets, shown in red when it ran over the plan, and Actual labour costs those hours at each person's rate from the labour roster (the blended rate for anyone not on it). The margin columns still use the planned labour cost, not the actual.
        </p>
      </div>
    </>
  );
}

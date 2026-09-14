import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  formatCentsAsAud,
  type Client,
  type InvoiceLineItem,
  type JobCard,
  type QuoteLineItem,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";

// Financial analytics dashboard - revenue over time, job profitability, and
// quote conversion rate, mirroring the "full dashboard: filters + export"
// shape the other in-app analytics view (ReferralAnalyticsTab) already
// established, and reusing Job Costing's margin math verbatim rather than
// re-deriving it. Same fetch-all-then-aggregate-client-side convention as
// every other report page in this app - no server-side aggregation RPCs
// exist here, so this doesn't introduce a first one.

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

async function fetchJobCards(): Promise<JobCardRow[]> {
  const { data, error } = await supabase.from("job_cards").select("*, clients(*)");
  if (error) throw error;
  return data as JobCardRow[];
}
async function fetchQuotes(): Promise<QuoteRow[]> {
  const { data, error } = await supabase.from("quotes").select("id, job_card_id, quote_number, status, total_cents, issue_date");
  if (error) throw error;
  return data as QuoteRow[];
}
async function fetchInvoices(): Promise<InvoiceRow[]> {
  const { data, error } = await supabase.from("invoices").select("id, job_card_id, invoice_number, status, total_cents, issue_date, paid_at");
  if (error) throw error;
  return data as InvoiceRow[];
}
async function fetchQuoteLineItems(quoteIds: string[]): Promise<QuoteLineItem[]> {
  if (quoteIds.length === 0) return [];
  const { data, error } = await supabase.from("quote_line_items").select("*").in("quote_id", quoteIds);
  if (error) throw error;
  return data as QuoteLineItem[];
}
async function fetchInvoiceLineItems(invoiceIds: string[]): Promise<InvoiceLineItem[]> {
  if (invoiceIds.length === 0) return [];
  const { data, error } = await supabase.from("invoice_line_items").select("*").in("invoice_id", invoiceIds);
  if (error) throw error;
  return data as InvoiceLineItem[];
}

type ClientReviewRow = { id: string; name: string; google_review_stars: number; google_review_recorded_at: string };

// Only clients with a star rating recorded - a client just ticked as
// "reviewed" before this feature existed (or unmarked since) has
// google_review_stars null and is correctly left out of the average/
// distribution rather than counted as a 0-star review.
async function fetchClientReviews(): Promise<ClientReviewRow[]> {
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, google_review_stars, google_review_recorded_at")
    .not("google_review_stars", "is", null);
  if (error) throw error;
  return data as ClientReviewRow[];
}

// Same per-unit breakdown as Job Costing / mobile's job costing tab -
// labour_rate_cents/labour_hours/material_cost_cents are the PER UNIT cost
// that fed into unit_price_cents, not already multiplied by quantity.
function lineItemLabourCostCents(item: Pick<QuoteLineItem, "quantity" | "labour_rate_cents" | "labour_hours">): number {
  return Math.round(item.quantity * item.labour_rate_cents * item.labour_hours);
}
function lineItemMaterialCostCents(item: Pick<QuoteLineItem, "quantity" | "material_cost_cents">): number {
  return Math.round(item.quantity * item.material_cost_cents);
}
// "Subby box" - per-unit subcontractor cost, same treatment as material.
function lineItemSubcontractorCostCents(item: Pick<QuoteLineItem, "quantity" | "subcontractor_cost_cents">): number {
  return Math.round(item.quantity * (item.subcontractor_cost_cents ?? 0));
}

type DatePreset = "this_month" | "last_month" | "this_quarter" | "ytd" | "last_12_months" | "custom";

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function presetRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  if (preset === "this_month") {
    return { from: toIso(new Date(now.getFullYear(), now.getMonth(), 1)), to: toIso(now) };
  }
  if (preset === "last_month") {
    return {
      from: toIso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: toIso(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  if (preset === "this_quarter") {
    const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
    return { from: toIso(new Date(now.getFullYear(), qStartMonth, 1)), to: toIso(now) };
  }
  if (preset === "last_12_months") {
    return { from: toIso(new Date(now.getFullYear(), now.getMonth() - 11, 1)), to: toIso(now) };
  }
  // ytd
  return { from: toIso(new Date(now.getFullYear(), 0, 1)), to: toIso(now) };
}

// The equivalent immediately-preceding period of the same length, for the
// KPI tiles' period-over-period delta.
function previousRange(from: string, to: string): { from: string; to: string } {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const spanMs = toDate.getTime() - fromDate.getTime();
  const prevTo = new Date(fromDate.getTime() - 24 * 60 * 60 * 1000);
  const prevFrom = new Date(prevTo.getTime() - spanMs);
  return { from: toIso(prevFrom), to: toIso(prevTo) };
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
function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  const cursor = new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, 1);
  const end = new Date(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, 1);
  while (cursor <= end) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
    cursor.setMonth(cursor.getMonth() + 1);
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

function DeltaBadge({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) return null;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const up = pct >= 0;
  return (
    <span className={`ml-2 text-xs font-semibold ${up ? "text-green-600" : "text-red-600"}`}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(0)}% vs prior period
    </span>
  );
}

function BarChart({ data, formatValue }: { data: { label: string; value: number }[]; formatValue: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex h-56 items-end gap-2 overflow-x-auto pb-1">
      {data.map((d) => (
        <div key={d.label} className="flex min-w-[44px] flex-1 flex-col items-center justify-end" title={`${d.label}: ${formatValue(d.value)}`}>
          <span className="mb-1 whitespace-nowrap text-[10px] font-semibold text-gray-600">{d.value > 0 ? formatValue(d.value) : ""}</span>
          <div
            className="w-full rounded-t bg-blue-600"
            style={{ height: `${Math.max(2, (d.value / max) * 180)}px` }}
          />
          <span className="mt-1 whitespace-nowrap text-[10px] text-gray-400">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

interface JobProfitRow {
  job: JobCardRow;
  labourCents: number;
  materialCents: number;
  subcontractorCents: number;
  chargedCents: number;
  marginCents: number;
  marginPercent: number;
}

export default function AnalyticsPage() {
  const { data: jobCards } = useQuery({ queryKey: ["analytics-jobs"], queryFn: fetchJobCards });
  const { data: quotes } = useQuery({ queryKey: ["analytics-quotes"], queryFn: fetchQuotes });
  const { data: invoices } = useQuery({ queryKey: ["analytics-invoices"], queryFn: fetchInvoices });

  const quoteIds = useMemo(() => (quotes ?? []).map((q) => q.id), [quotes]);
  const invoiceIds = useMemo(() => (invoices ?? []).map((i) => i.id), [invoices]);

  const { data: quoteLineItems } = useQuery({
    queryKey: ["analytics-quote-line-items", quoteIds.join(",")],
    queryFn: () => fetchQuoteLineItems(quoteIds),
    enabled: !!quotes,
  });
  const { data: invoiceLineItems } = useQuery({
    queryKey: ["analytics-invoice-line-items", invoiceIds.join(",")],
    queryFn: () => fetchInvoiceLineItems(invoiceIds),
    enabled: !!invoices,
  });
  const { data: clientReviews } = useQuery({ queryKey: ["analytics-client-reviews"], queryFn: fetchClientReviews });

  const isLoading = !jobCards || !quotes || !invoices || !quoteLineItems || !invoiceLineItems;

  const [preset, setPreset] = useState<DatePreset>("this_quarter");
  const [customFrom, setCustomFrom] = useState(() => presetRange("this_quarter").from);
  const [customTo, setCustomTo] = useState(() => presetRange("this_quarter").to);
  const range = preset === "custom" ? { from: customFrom, to: customTo } : presetRange(preset);
  const prevRange = useMemo(() => previousRange(range.from, range.to), [range.from, range.to]);

  // --- Customer Feedback (Google review stars) ---
  const reviewsInRange = useMemo(
    () => (clientReviews ?? []).filter((r) => inRange(r.google_review_recorded_at, range.from, range.to)),
    [clientReviews, range.from, range.to]
  );
  const avgStars = reviewsInRange.length > 0 ? reviewsInRange.reduce((sum, r) => sum + r.google_review_stars, 0) / reviewsInRange.length : 0;
  const starDistribution = useMemo(() => {
    const counts = [1, 2, 3, 4, 5].map((n) => ({ label: `${n}★`, value: 0 }));
    for (const r of reviewsInRange) {
      const bucket = counts[r.google_review_stars - 1];
      if (bucket) bucket.value += 1;
    }
    return counts;
  }, [reviewsInRange]);

  const quoteLineItemsByQuote = useMemo(() => {
    const map = new Map<string, QuoteLineItem[]>();
    for (const item of quoteLineItems ?? []) {
      if (!map.has(item.quote_id)) map.set(item.quote_id, []);
      map.get(item.quote_id)!.push(item);
    }
    return map;
  }, [quoteLineItems]);
  const invoiceLineItemsByInvoice = useMemo(() => {
    const map = new Map<string, InvoiceLineItem[]>();
    for (const item of invoiceLineItems ?? []) {
      if (!map.has(item.invoice_id)) map.set(item.invoice_id, []);
      map.get(item.invoice_id)!.push(item);
    }
    return map;
  }, [invoiceLineItems]);

  // --- Revenue invoiced / collected KPIs, current period vs prior period ---
  function revenueInvoicedCents(from: string, to: string): number {
    return (invoices ?? []).filter((inv) => inv.status !== "void" && inRange(inv.issue_date, from, to)).reduce((sum, inv) => sum + inv.total_cents, 0);
  }
  function revenueCollectedCents(from: string, to: string): number {
    return (invoices ?? []).filter((inv) => inv.status === "paid" && inRange(inv.paid_at, from, to)).reduce((sum, inv) => sum + inv.total_cents, 0);
  }
  const revenueInvoiced = revenueInvoicedCents(range.from, range.to);
  const revenueInvoicedPrev = revenueInvoicedCents(prevRange.from, prevRange.to);
  const revenueCollected = revenueCollectedCents(range.from, range.to);
  const revenueCollectedPrev = revenueCollectedCents(prevRange.from, prevRange.to);
  const outstandingCents = (invoices ?? [])
    .filter((inv) => inv.status === "sent" || inv.status === "overdue")
    .reduce((sum, inv) => sum + inv.total_cents, 0);

  // --- Revenue over time (invoiced, by month across the selected range) ---
  const revenueByMonth = useMemo(() => {
    const months = monthsBetween(range.from, range.to);
    const totals = new Map(months.map((m) => [m, 0]));
    for (const inv of invoices ?? []) {
      if (inv.status === "void" || !inRange(inv.issue_date, range.from, range.to)) continue;
      const key = monthKey(inv.issue_date);
      if (totals.has(key)) totals.set(key, totals.get(key)! + inv.total_cents);
    }
    return months.map((m) => ({ key: m, label: monthLabel(m), cents: totals.get(m) ?? 0 }));
  }, [invoices, range.from, range.to]);

  // --- Quote conversion rate ---
  function conversionStats(from: string, to: string) {
    const inWindow = (quotes ?? []).filter((q) => q.status !== "draft" && inRange(q.issue_date, from, to));
    const accepted = inWindow.filter((q) => q.status === "accepted").length;
    const declined = inWindow.filter((q) => q.status === "declined").length;
    const expired = inWindow.filter((q) => q.status === "expired").length;
    const pending = inWindow.filter((q) => q.status === "sent").length;
    const rate = inWindow.length > 0 ? (accepted / inWindow.length) * 100 : 0;
    return { total: inWindow.length, accepted, declined, expired, pending, rate };
  }
  const conversion = conversionStats(range.from, range.to);
  const conversionPrev = conversionStats(prevRange.from, prevRange.to);

  const conversionByMonth = useMemo(() => {
    const months = monthsBetween(range.from, range.to);
    return months.map((m) => {
      const inMonth = (quotes ?? []).filter((q) => q.status !== "draft" && monthKey(q.issue_date) === m);
      const accepted = inMonth.filter((q) => q.status === "accepted").length;
      const declined = inMonth.filter((q) => q.status === "declined").length;
      const expired = inMonth.filter((q) => q.status === "expired").length;
      const pending = inMonth.filter((q) => q.status === "sent").length;
      const rate = inMonth.length > 0 ? (accepted / inMonth.length) * 100 : 0;
      return { key: m, label: monthLabel(m), sent: inMonth.length, accepted, declined, expired, pending, rate };
    });
  }, [quotes, range.from, range.to]);

  // --- Job profitability, restricted to docs issued within the range ---
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
      const labourCents = allLineItems.reduce((sum, item) => sum + lineItemLabourCostCents(item), 0);
      const materialCents = allLineItems.reduce((sum, item) => sum + lineItemMaterialCostCents(item), 0);
      const subcontractorCents = allLineItems.reduce((sum, item) => sum + lineItemSubcontractorCostCents(item), 0);
      const chargedCents = [...jobQuotes, ...jobInvoices].reduce((sum, doc) => sum + doc.total_cents, 0);
      // Same basis/caveats as Job Costing: charged is GST-inclusive, cost is
      // GST-exclusive, and a quote converted to an invoice within the same
      // window is counted under both.
      const marginCents = chargedCents - (labourCents + materialCents + subcontractorCents);
      const marginPercent = chargedCents > 0 ? (marginCents / chargedCents) * 100 : 0;

      result.push({ job, labourCents, materialCents, subcontractorCents, chargedCents, marginCents, marginPercent });
    }
    return result;
  }, [jobCards, quotes, invoices, quoteLineItemsByQuote, invoiceLineItemsByInvoice, range.from, range.to]);

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
      const labourCents = allLineItems.reduce((sum, item) => sum + lineItemLabourCostCents(item), 0);
      const materialCents = allLineItems.reduce((sum, item) => sum + lineItemMaterialCostCents(item), 0);
      const subcontractorCents = allLineItems.reduce((sum, item) => sum + lineItemSubcontractorCostCents(item), 0);
      const chargedCents = [...jobQuotes, ...jobInvoices].reduce((sum, doc) => sum + doc.total_cents, 0);
      const marginCents = chargedCents - (labourCents + materialCents + subcontractorCents);
      margins.push(chargedCents > 0 ? (marginCents / chargedCents) * 100 : 0);
    }
    return margins.length > 0 ? margins.reduce((a, b) => a + b, 0) / margins.length : 0;
  }, [jobCards, quotes, invoices, quoteLineItemsByQuote, invoiceLineItemsByInvoice, prevRange.from, prevRange.to]);

  const exportRevenueCsv = () => {
    downloadCsv(
      `revenue-by-month-${range.from}-to-${range.to}.csv`,
      "Month,Revenue Invoiced ($)",
      revenueByMonth.map((m) => `${m.label},${(m.cents / 100).toFixed(2)}`)
    );
  };
  const exportJobProfitCsv = () => {
    downloadCsv(
      `job-profitability-${range.from}-to-${range.to}.csv`,
      "Job Number,Job Title,Client,Labour ($),Material ($),Subcontractor ($),Charged ($),Margin ($),Margin (%)",
      sortedJobRows.map(
        (r) =>
          `${csvCell(r.job.number ?? "Pending")},${csvCell(r.job.title)},${csvCell(r.job.clients?.name ?? "Unknown")},${(
            r.labourCents / 100
          ).toFixed(2)},${(r.materialCents / 100).toFixed(2)},${(r.subcontractorCents / 100).toFixed(2)},${(r.chargedCents / 100).toFixed(2)},${(r.marginCents / 100).toFixed(2)},${r.marginPercent.toFixed(1)}`
      )
    );
  };
  const exportConversionCsv = () => {
    downloadCsv(
      `quote-conversion-${range.from}-to-${range.to}.csv`,
      "Month,Sent,Accepted,Declined,Expired,Pending,Conversion Rate (%)",
      conversionByMonth.map((m) => `${m.label},${m.sent},${m.accepted},${m.declined},${m.expired},${m.pending},${m.rate.toFixed(1)}`)
    );
  };

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Analytics</h1>
          <p className="text-sm text-gray-500">Revenue, job profitability, and quote conversion across your business.</p>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-gray-300 bg-white p-4">
        <div className="flex gap-1">
          {(
            [
              { value: "this_month", label: "This Month" },
              { value: "last_month", label: "Last Month" },
              { value: "this_quarter", label: "This Quarter" },
              { value: "ytd", label: "YTD" },
              { value: "last_12_months", label: "Last 12 Months" },
            ] as { value: DatePreset; label: string }[]
          ).map((p) => (
            <button
              key={p.value}
              onClick={() => setPreset(p.value)}
              className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
                preset === p.value ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-500">From</label>
            <input
              type="date"
              value={preset === "custom" ? customFrom : range.from}
              onChange={(e) => {
                setPreset("custom");
                setCustomFrom(e.target.value);
              }}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-500">To</label>
            <input
              type="date"
              value={preset === "custom" ? customTo : range.to}
              onChange={(e) => {
                setPreset("custom");
                setCustomTo(e.target.value);
              }}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
        </div>
        <p className="ml-auto text-xs text-gray-400">Compared against {prevRange.from} to {prevRange.to}</p>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-5 gap-4">
            <div className="rounded-lg border border-gray-300 bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-gray-400">Revenue Invoiced</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{formatCentsAsAud(revenueInvoiced)}</p>
              <DeltaBadge current={revenueInvoiced} previous={revenueInvoicedPrev} />
            </div>
            <div className="rounded-lg border border-gray-300 bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-gray-400">Revenue Collected</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{formatCentsAsAud(revenueCollected)}</p>
              <DeltaBadge current={revenueCollected} previous={revenueCollectedPrev} />
            </div>
            <div className="rounded-lg border border-gray-300 bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-gray-400">Outstanding (unpaid)</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{formatCentsAsAud(outstandingCents)}</p>
              <p className="text-xs text-gray-400">All open invoices, not period-limited</p>
            </div>
            <div className="rounded-lg border border-gray-300 bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-gray-400">Quote Conversion Rate</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{conversion.rate.toFixed(0)}%</p>
              <DeltaBadge current={conversion.rate} previous={conversionPrev.rate} />
            </div>
            <div className="rounded-lg border border-gray-300 bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-gray-400">Avg. Job Margin</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{avgMarginPercent.toFixed(1)}%</p>
              <DeltaBadge current={avgMarginPercent} previous={avgMarginPercentPrev} />
            </div>
          </div>

          <div className="mb-6 rounded-lg border border-gray-300 bg-white p-6">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Revenue Over Time</h2>
                <p className="text-xs text-gray-400">Invoiced revenue by month, excluding voided invoices.</p>
              </div>
              <button
                onClick={exportRevenueCsv}
                disabled={revenueByMonth.length === 0}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Export CSV
              </button>
            </div>
            {revenueByMonth.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-500">No invoices in this range.</p>
            ) : (
              <BarChart data={revenueByMonth.map((m) => ({ label: m.label, value: m.cents }))} formatValue={formatCentsAsAud} />
            )}
          </div>

          <div className="mb-6 rounded-lg border border-gray-300 bg-white p-6">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Quote Conversion by Month</h2>
                <p className="text-xs text-gray-400">Accepted quotes as a share of all non-draft quotes issued each month.</p>
              </div>
              <button
                onClick={exportConversionCsv}
                disabled={conversionByMonth.length === 0}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Export CSV
              </button>
            </div>
            {conversionByMonth.every((m) => m.sent === 0) ? (
              <p className="py-6 text-center text-sm text-gray-500">No quotes sent in this range.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="border-b border-gray-300 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="py-2 font-semibold">Month</th>
                    <th className="py-2 text-right font-semibold">Sent</th>
                    <th className="py-2 text-right font-semibold">Accepted</th>
                    <th className="py-2 text-right font-semibold">Declined</th>
                    <th className="py-2 text-right font-semibold">Expired</th>
                    <th className="py-2 text-right font-semibold">Pending</th>
                    <th className="py-2 text-right font-semibold">Conversion</th>
                  </tr>
                </thead>
                <tbody>
                  {conversionByMonth.map((m) => (
                    <tr key={m.key} className="border-b border-gray-200 last:border-0">
                      <td className="py-2">{m.label}</td>
                      <td className="py-2 text-right">{m.sent}</td>
                      <td className="py-2 text-right text-green-700">{m.accepted}</td>
                      <td className="py-2 text-right text-red-600">{m.declined}</td>
                      <td className="py-2 text-right text-gray-500">{m.expired}</td>
                      <td className="py-2 text-right text-gray-500">{m.pending}</td>
                      <td className="py-2 text-right font-semibold">{m.rate.toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="rounded-lg border border-gray-300 bg-white p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Job Profitability</h2>
                <p className="text-xs text-gray-400">Every job with a quote or invoice issued in this range.</p>
              </div>
              <button
                onClick={exportJobProfitCsv}
                disabled={sortedJobRows.length === 0}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
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
                className="w-72 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
              <div className="ml-auto flex items-center gap-2 text-sm">
                <span className="text-gray-500">Sort:</span>
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
                    className={`rounded-full px-3 py-1 font-semibold ${
                      jobSortKey === opt.value ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {sortedJobRows.length === 0 ? (
              <p className="p-6 text-center text-sm text-gray-500">No jobs with a linked quote or invoice in this range.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-gray-200">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-gray-300 bg-gray-50 text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Job</th>
                      <th className="px-4 py-2 font-semibold">Client</th>
                      <th className="px-4 py-2 text-right font-semibold">Labour</th>
                      <th className="px-4 py-2 text-right font-semibold">Material</th>
                      <th className="px-4 py-2 text-right font-semibold">Subcontractor</th>
                      <th className="px-4 py-2 text-right font-semibold">Charged</th>
                      <th className="px-4 py-2 text-right font-semibold">Margin</th>
                      <th className="px-4 py-2 text-right font-semibold">Margin %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedJobRows.map((row) => (
                      <tr key={row.job.id} className="border-b border-gray-200 last:border-0 hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <Link to={`/jobs/${row.job.id}`} className="font-medium text-blue-700 hover:underline">
                            {row.job.number ?? "Pending"} - {row.job.title}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{row.job.clients?.name ?? "Unknown"}</td>
                        <td className="px-4 py-3 text-right">{formatCentsAsAud(row.labourCents)}</td>
                        <td className="px-4 py-3 text-right">{formatCentsAsAud(row.materialCents)}</td>
                        <td className="px-4 py-3 text-right">{formatCentsAsAud(row.subcontractorCents)}</td>
                        <td className="px-4 py-3 text-right">{formatCentsAsAud(row.chargedCents)}</td>
                        <td className={`px-4 py-3 text-right font-semibold ${row.marginCents < 0 ? "text-red-600" : "text-gray-900"}`}>
                          {formatCentsAsAud(row.marginCents)}
                        </td>
                        <td className={`px-4 py-3 text-right font-semibold ${row.marginPercent < 0 ? "text-red-600" : "text-gray-900"}`}>
                          {row.marginPercent.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {sortedJobRows.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
                <div className="flex items-center gap-2 text-gray-500">
                  <span>Show</span>
                  <select
                    value={jobPageSize}
                    onChange={(e) => setJobPageSize(Number(e.target.value))}
                    className="rounded-md border border-gray-300 bg-white px-2 py-1"
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
                    className="rounded-md border border-gray-300 px-3 py-1.5 font-semibold text-gray-700 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="text-gray-500">
                    Page {jobPage} of {jobPageCount}
                  </span>
                  <button
                    onClick={() => setJobPage((p) => Math.min(jobPageCount, p + 1))}
                    disabled={jobPage >= jobPageCount}
                    className="rounded-md border border-gray-300 px-3 py-1.5 font-semibold text-gray-700 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : null}

            <p className="mt-3 text-xs text-gray-400">
              Total charged is GST-inclusive while labour/material cost are GST-exclusive, so margin here slightly overstates the true
              figure. A quote that's since been converted to an invoice within the same window is counted under both - same basis as
              the Job Costing report.
            </p>
          </div>

          <div className="mb-6 rounded-lg border border-gray-300 bg-white p-4">
            <div className="mb-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Customer Feedback</h2>
              <p className="text-xs text-gray-400">Google review stars recorded from the client card, in this range.</p>
            </div>

            {reviewsInRange.length === 0 ? (
              <p className="p-6 text-center text-sm text-gray-500">No reviews recorded in this range.</p>
            ) : (
              <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Average rating</p>
                  <p className="text-3xl font-extrabold text-gray-900">{avgStars.toFixed(1)}</p>
                  <p className="text-yellow-500">
                    {"★".repeat(Math.round(avgStars))}
                    {"☆".repeat(5 - Math.round(avgStars))}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    {reviewsInRange.length} review{reviewsInRange.length === 1 ? "" : "s"} recorded
                  </p>
                </div>
                <BarChart data={starDistribution} formatValue={(v) => String(v)} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  formatCentsAsAud,
  type Client,
  type InvoiceLineItem,
  type JobCard,
  type Quote,
  type QuoteLineItem,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";

// Cross-job costing report - the desktop equivalent of mobile's per-job
// "Job Costing" tab (apps/mobile/app/(tabs)/sales/jobs/[id].tsx), built as
// its own screen instead of a tab per the brief's own note that "a bigger
// screen suits a denser report layout": rather than opening one job at a
// time to see its margin, this surfaces every job's margin at once - the
// kind of business-wide view mobile's small screen was never going to fit.
// Same underlying math as mobile, not a redesign of it (including the same
// known caveats - see the comment above marginCents below).

type JobCardRow = JobCard & { clients: Client | null };
type QuoteRow = Pick<Quote, "id" | "job_card_id" | "quote_number" | "status" | "total_cents">;
type InvoiceRow = { id: string; job_card_id: string | null; invoice_number: string; status: string; total_cents: number };

async function fetchJobCards(): Promise<JobCardRow[]> {
  const { data, error } = await supabase.from("job_cards").select("*, clients(*)");
  if (error) throw error;
  return data as JobCardRow[];
}
async function fetchQuotes(): Promise<QuoteRow[]> {
  const { data, error } = await supabase
    .from("quotes")
    .select("id, job_card_id, quote_number, status, total_cents")
    .not("job_card_id", "is", null);
  if (error) throw error;
  return data as QuoteRow[];
}
async function fetchInvoices(): Promise<InvoiceRow[]> {
  const { data, error } = await supabase
    .from("invoices")
    .select("id, job_card_id, invoice_number, status, total_cents")
    .not("job_card_id", "is", null);
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

// Same helpers as mobile's jobs/[id].tsx - labour_rate_cents/labour_hours/
// material_cost_cents are the PER UNIT breakdown that fed into
// unit_price_cents (see computeLineItemUnitPriceCents), not already
// multiplied by quantity.
function lineItemLabourCostCents(item: Pick<QuoteLineItem, "quantity" | "labour_rate_cents" | "labour_hours">): number {
  return Math.round(item.quantity * item.labour_rate_cents * item.labour_hours);
}
function lineItemMaterialCostCents(item: Pick<QuoteLineItem, "quantity" | "material_cost_cents">): number {
  return Math.round(item.quantity * item.material_cost_cents);
}

interface JobCostingRow {
  job: JobCardRow;
  docs: { id: string; type: "quote" | "invoice"; number: string; status: string; total_cents: number }[];
  labourCents: number;
  materialCents: number;
  chargedCents: number;
  marginCents: number;
  marginPercent: number;
}

type SortKey = "margin_percent" | "margin" | "charged" | "job_number";

export default function JobCostingPage() {
  const { data: jobCards } = useQuery({ queryKey: ["job-costing-jobs"], queryFn: fetchJobCards });
  const { data: quotes } = useQuery({ queryKey: ["job-costing-quotes"], queryFn: fetchQuotes });
  const { data: invoices } = useQuery({ queryKey: ["job-costing-invoices"], queryFn: fetchInvoices });

  const quoteIds = useMemo(() => (quotes ?? []).map((q) => q.id), [quotes]);
  const invoiceIds = useMemo(() => (invoices ?? []).map((i) => i.id), [invoices]);

  const { data: quoteLineItems } = useQuery({
    queryKey: ["job-costing-quote-line-items", quoteIds.join(",")],
    queryFn: () => fetchQuoteLineItems(quoteIds),
    enabled: !!quotes,
  });
  const { data: invoiceLineItems } = useQuery({
    queryKey: ["job-costing-invoice-line-items", invoiceIds.join(",")],
    queryFn: () => fetchInvoiceLineItems(invoiceIds),
    enabled: !!invoices,
  });

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("margin_percent");

  const rows: JobCostingRow[] = useMemo(() => {
    if (!jobCards || !quotes || !invoices || !quoteLineItems || !invoiceLineItems) return [];

    const quotesByJob = new Map<string, QuoteRow[]>();
    for (const q of quotes) {
      if (!q.job_card_id) continue;
      if (!quotesByJob.has(q.job_card_id)) quotesByJob.set(q.job_card_id, []);
      quotesByJob.get(q.job_card_id)!.push(q);
    }
    const invoicesByJob = new Map<string, InvoiceRow[]>();
    for (const inv of invoices) {
      if (!inv.job_card_id) continue;
      if (!invoicesByJob.has(inv.job_card_id)) invoicesByJob.set(inv.job_card_id, []);
      invoicesByJob.get(inv.job_card_id)!.push(inv);
    }
    const quoteLineItemsByQuote = new Map<string, QuoteLineItem[]>();
    for (const item of quoteLineItems) {
      if (!quoteLineItemsByQuote.has(item.quote_id)) quoteLineItemsByQuote.set(item.quote_id, []);
      quoteLineItemsByQuote.get(item.quote_id)!.push(item);
    }
    const invoiceLineItemsByInvoice = new Map<string, InvoiceLineItem[]>();
    for (const item of invoiceLineItems) {
      if (!invoiceLineItemsByInvoice.has(item.invoice_id)) invoiceLineItemsByInvoice.set(item.invoice_id, []);
      invoiceLineItemsByInvoice.get(item.invoice_id)!.push(item);
    }

    const result: JobCostingRow[] = [];
    for (const job of jobCards) {
      const jobQuotes = quotesByJob.get(job.id) ?? [];
      const jobInvoices = invoicesByJob.get(job.id) ?? [];
      if (jobQuotes.length === 0 && jobInvoices.length === 0) continue;

      const docs = [
        ...jobQuotes.map((q) => ({ id: q.id, type: "quote" as const, number: q.quote_number, status: q.status, total_cents: q.total_cents })),
        ...jobInvoices.map((inv) => ({
          id: inv.id,
          type: "invoice" as const,
          number: inv.invoice_number,
          status: inv.status,
          total_cents: inv.total_cents,
        })),
      ];

      const allLineItems = [
        ...jobQuotes.flatMap((q) => quoteLineItemsByQuote.get(q.id) ?? []),
        ...jobInvoices.flatMap((inv) => invoiceLineItemsByInvoice.get(inv.id) ?? []),
      ];

      const labourCents = allLineItems.reduce((sum, item) => sum + lineItemLabourCostCents(item), 0);
      const materialCents = allLineItems.reduce((sum, item) => sum + lineItemMaterialCostCents(item), 0);
      const chargedCents = docs.reduce((sum, doc) => sum + doc.total_cents, 0);
      // Margin is "charged minus cost" - same shape and same caveats as
      // mobile's own version: total charged is GST-inclusive while
      // labour/material cost are GST-exclusive (a small overstatement of
      // margin), and a quote converted to an invoice stays linked to the
      // job as both, so it's summed twice here exactly as it is there.
      // Not fixed here - ported as-is, not redesigned.
      const marginCents = chargedCents - (labourCents + materialCents);
      const marginPercent = chargedCents > 0 ? (marginCents / chargedCents) * 100 : 0;

      result.push({ job, docs, labourCents, materialCents, chargedCents, marginCents, marginPercent });
    }
    return result;
  }, [jobCards, quotes, invoices, quoteLineItems, invoiceLineItems]);

  const filteredRows = rows.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.job.title.toLowerCase().includes(q) || (r.job.clients?.name ?? "").toLowerCase().includes(q);
  });

  const sortedRows = [...filteredRows].sort((a, b) => {
    switch (sortKey) {
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

  const totals = sortedRows.reduce(
    (acc, r) => ({
      labourCents: acc.labourCents + r.labourCents,
      materialCents: acc.materialCents + r.materialCents,
      chargedCents: acc.chargedCents + r.chargedCents,
      marginCents: acc.marginCents + r.marginCents,
    }),
    { labourCents: 0, materialCents: 0, chargedCents: 0, marginCents: 0 }
  );
  const totalMarginPercent = totals.chargedCents > 0 ? (totals.marginCents / totals.chargedCents) * 100 : 0;

  const isLoading = !jobCards || !quotes || !invoices || !quoteLineItems || !invoiceLineItems;

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Job Costing</h1>
        <p className="text-sm text-gray-500">
          Labour + material cost vs. total charged, across every job with a linked quote or invoice.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by job title or client..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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
              onClick={() => setSortKey(opt.value)}
              className={`rounded-full px-3 py-1 font-semibold ${
                sortKey === opt.value ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {isLoading ? (
          <p className="p-6 text-sm text-gray-500">Loading...</p>
        ) : sortedRows.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No jobs with a linked quote or invoice yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Job</th>
                <th className="px-4 py-2 font-semibold">Client</th>
                <th className="px-4 py-2 text-right font-semibold">Labour</th>
                <th className="px-4 py-2 text-right font-semibold">Material</th>
                <th className="px-4 py-2 text-right font-semibold">Charged</th>
                <th className="px-4 py-2 text-right font-semibold">Margin</th>
                <th className="px-4 py-2 text-right font-semibold">Margin %</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => (
                <tr key={row.job.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link to={`/jobs/${row.job.id}`} className="font-medium text-blue-700 hover:underline">
                      {row.job.number ?? "Pending"} - {row.job.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{row.job.clients?.name ?? "Unknown"}</td>
                  <td className="px-4 py-3 text-right">{formatCentsAsAud(row.labourCents)}</td>
                  <td className="px-4 py-3 text-right">{formatCentsAsAud(row.materialCents)}</td>
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
            {sortedRows.length > 0 ? (
              <tfoot className="border-t-2 border-gray-200 bg-gray-50 font-bold">
                <tr>
                  <td className="px-4 py-3" colSpan={2}>
                    Total ({sortedRows.length} job{sortedRows.length === 1 ? "" : "s"})
                  </td>
                  <td className="px-4 py-3 text-right">{formatCentsAsAud(totals.labourCents)}</td>
                  <td className="px-4 py-3 text-right">{formatCentsAsAud(totals.materialCents)}</td>
                  <td className="px-4 py-3 text-right">{formatCentsAsAud(totals.chargedCents)}</td>
                  <td className="px-4 py-3 text-right">{formatCentsAsAud(totals.marginCents)}</td>
                  <td className="px-4 py-3 text-right">{totalMarginPercent.toFixed(1)}%</td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        )}
      </div>

      <p className="mt-3 text-xs text-gray-400">
        Total charged is GST-inclusive while labour/material cost are GST-exclusive, so margin here slightly overstates the
        true figure. A quote that's since been converted to an invoice is counted under both, since both stay linked to the
        job - same basis as mobile's own Job Costing tab.
      </p>
    </div>
  );
}

import { useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  indexAnalytics,
  type AnalyticsClient,
  type AnalyticsData,
  type AnalyticsIndex,
  type AnalyticsInvoice,
  type AnalyticsJob,
  type AnalyticsLine,
  type AnalyticsNamed,
  type AnalyticsPreset,
  type AnalyticsQuote,
  type AnalyticsSite,
  type AnalyticsStage,
  type DateRange,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";

// PostgREST caps every response at 1000 rows (supabase/config.toml's
// max_rows, same on the hosted project), silently - a plain select on a
// table with more just returns the first 1000. Reports that sum five
// years of invoices can't be allowed to quietly drop the rest, so every
// Analytics read pages through the whole table. Ordered by id so pages
// can't overlap or skip.
const PAGE_SIZE = 1000;

// The query builder's own type is generic over the schema; a filter only
// ever chains one more call onto it.
type Filter = (query: any) => any;

export async function fetchAllRows<T>(table: string, columns: string, filter?: Filter): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase.from(table).select(columns);
    if (filter) query = filter(query);
    const { data, error } = await query.order("id").range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

// Every column Analytics reads, in one place - a misspelt column only
// fails at runtime, so this list is what gets checked against the schema.
export const ANALYTICS_COLUMNS = {
  job_cards: "id, number, title, client_id, site_id, created_at, completed_at, service_category_id, lifecycle_stage_id, lead_source_id, callback_of_job_card_id",
  quotes: "id, job_card_id, client_id, quote_number, status, total_cents, issue_date, lost_reason_category",
  invoices: "id, job_card_id, client_id, site_id, invoice_number, status, total_cents, issue_date, due_date, paid_at",
  clients: "id, name, suburb, postcode, google_review_stars, google_review_recorded_at",
  client_sites: "id, suburb, postcode",
  service_categories: "id, name",
  job_lifecycle_stages: "id, name, position, is_closed",
  lead_sources: "id, name",
  invoice_line_items: "id, invoice_id, price_book_item_id, quantity, unit_price_cents, waived_amount_cents",
  quote_line_items: "id, quote_id, price_book_item_id, quantity, unit_price_cents, waived_amount_cents, is_included",
  price_book_items: "id, description, category_id",
  price_book_categories: "id, name",
} as const;

async function fetchAnalyticsData(): Promise<AnalyticsData> {
  const c = ANALYTICS_COLUMNS;
  const [jobs, quotes, invoices, clients, sites, categories, stages, leadSources] = await Promise.all([
    fetchAllRows<AnalyticsJob>("job_cards", c.job_cards),
    fetchAllRows<AnalyticsQuote>("quotes", c.quotes),
    fetchAllRows<AnalyticsInvoice>("invoices", c.invoices),
    fetchAllRows<AnalyticsClient>("clients", c.clients),
    fetchAllRows<AnalyticsSite>("client_sites", c.client_sites),
    fetchAllRows<AnalyticsNamed>("service_categories", c.service_categories),
    fetchAllRows<AnalyticsStage>("job_lifecycle_stages", c.job_lifecycle_stages),
    fetchAllRows<AnalyticsNamed>("lead_sources", c.lead_sources),
  ]);
  return { jobs, quotes, invoices, clients, sites, categories, stages, leadSources };
}

export function useAnalyticsData() {
  const query = useQuery({ queryKey: ["analytics", "core"], queryFn: fetchAnalyticsData, staleTime: 60_000 });
  const ix = useMemo(() => (query.data ? indexAnalytics(query.data) : null), [query.data]);
  return { ix, error: query.error, isFetching: query.isFetching };
}

export interface PriceBookLines {
  invoiceLines: AnalyticsLine[];
  quoteLines: AnalyticsLine[];
  items: { id: string; description: string; category_id: string }[];
  categories: AnalyticsNamed[];
}

type InvoiceLineRow = Omit<AnalyticsLine, "parent_id"> & { invoice_id: string };
type QuoteLineRow = Omit<AnalyticsLine, "parent_id"> & { quote_id: string };

// Only lines that came from the Price Book - a custom line has nothing to
// count against, and they're the bulk of the table.
const linkedOnly: Filter = (query) => query.not("price_book_item_id", "is", null);

async function fetchPriceBookLines(): Promise<PriceBookLines> {
  const c = ANALYTICS_COLUMNS;
  const [invoiceRows, quoteRows, items, categories] = await Promise.all([
    fetchAllRows<InvoiceLineRow>("invoice_line_items", c.invoice_line_items, linkedOnly),
    fetchAllRows<QuoteLineRow>("quote_line_items", c.quote_line_items, linkedOnly),
    fetchAllRows<PriceBookLines["items"][number]>("price_book_items", c.price_book_items),
    fetchAllRows<AnalyticsNamed>("price_book_categories", c.price_book_categories),
  ]);
  return {
    invoiceLines: invoiceRows.map(({ invoice_id, ...line }) => ({ ...line, parent_id: invoice_id })),
    quoteLines: quoteRows.map(({ quote_id, ...line }) => ({ ...line, parent_id: quote_id })),
    items,
    categories,
  };
}

export function usePriceBookLines() {
  return useQuery({ queryKey: ["analytics", "price-book-lines"], queryFn: fetchPriceBookLines, staleTime: 60_000 });
}

export interface Drill {
  title: string;
  subtitle?: string;
  jobs?: AnalyticsJob[];
  invoices?: AnalyticsInvoice[];
  quotes?: AnalyticsQuote[];
  clients?: AnalyticsClient[];
}

export interface AnalyticsContext {
  ix: AnalyticsIndex;
  preset: AnalyticsPreset;
  range: DateRange;
  compare: DateRange;
  today: string;
  // Opens the list of records behind a number.
  openDrill: (drill: Drill) => void;
}

export function useAnalytics(): AnalyticsContext {
  return useOutletContext<AnalyticsContext>();
}

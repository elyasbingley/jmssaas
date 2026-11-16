import type { InvoiceStatus, QuoteLostReason, QuoteStatus } from "./types";

// Every Analytics report's maths, kept out of the React pages so it can be
// unit tested (see analytics.test.mjs alongside the docs for this section)
// and so two reports can never disagree about what "revenue" or "a
// completed job" means. All pure - callers fetch the rows and pass them in.
//
// Dates: a "day key" is a local-calendar YYYY-MM-DD string. Date-only
// columns (issue_date, due_date) already are one. Timestamps (created_at,
// completed_at, paid_at) are converted through the runtime's local zone
// first - slicing the UTC ISO string instead puts anything that happened
// before 10am Sydney time on the previous day, which matters at exactly
// the boundaries these reports are about (1 July, month ends).

export interface DateRange {
  from: string;
  to: string;
}

export interface AnalyticsJob {
  id: string;
  number: string | null;
  title: string;
  client_id: string;
  site_id: string | null;
  created_at: string;
  completed_at: string | null;
  service_category_id: string | null;
  lifecycle_stage_id: string | null;
  lead_source_id: string | null;
  callback_of_job_card_id: string | null;
}

export interface AnalyticsQuote {
  id: string;
  job_card_id: string | null;
  client_id: string;
  quote_number: string;
  status: QuoteStatus;
  total_cents: number;
  issue_date: string;
  lost_reason_category: QuoteLostReason | null;
}

export interface AnalyticsInvoice {
  id: string;
  job_card_id: string | null;
  client_id: string;
  site_id: string | null;
  invoice_number: string;
  status: InvoiceStatus;
  total_cents: number;
  issue_date: string;
  due_date: string | null;
  paid_at: string | null;
}

export interface AnalyticsClient {
  id: string;
  name: string;
  suburb: string | null;
  postcode: string | null;
  google_review_stars: number | null;
  google_review_recorded_at: string | null;
}

export interface AnalyticsSite {
  id: string;
  suburb: string;
  postcode: string;
}

export interface AnalyticsNamed {
  id: string;
  name: string;
}

export interface AnalyticsStage extends AnalyticsNamed {
  position: number;
  is_closed: boolean;
}

export interface AnalyticsLine {
  parent_id: string;
  price_book_item_id: string | null;
  quantity: number;
  unit_price_cents: number;
  waived_amount_cents?: number | null;
  is_included?: boolean | null;
}

export interface AnalyticsData {
  jobs: AnalyticsJob[];
  quotes: AnalyticsQuote[];
  invoices: AnalyticsInvoice[];
  clients: AnalyticsClient[];
  sites: AnalyticsSite[];
  categories: AnalyticsNamed[];
  stages: AnalyticsStage[];
  leadSources: AnalyticsNamed[];
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKeyOfDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toDayKey(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return dayKeyOfDate(new Date(value));
}

function keyToUtc(key: string): number {
  return Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
}
function utcToKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(key: string, days: number): string {
  return utcToKey(keyToUtc(key) + days * DAY_MS);
}

// Whole days from `from` to `to` (positive when `to` is later).
export function daysBetween(from: string, to: string): number {
  return Math.round((keyToUtc(to) - keyToUtc(from)) / DAY_MS);
}

// Same calendar date `years` earlier/later; 29 Feb lands on 28 Feb.
export function addYears(key: string, years: number): string {
  const y = Number(key.slice(0, 4)) + years;
  const m = Number(key.slice(5, 7));
  const d = Number(key.slice(8, 10));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(d, lastDay))}`;
}

export function inRange(value: string | null | undefined, range: DateRange): boolean {
  if (!value) return false;
  const key = toDayKey(value);
  return key >= range.from && key <= range.to;
}

export function monthKeyOf(value: string): string {
  return toDayKey(value).slice(0, 7);
}

export function monthsInRange(range: DateRange): string[] {
  const months: string[] = [];
  let y = Number(range.from.slice(0, 4));
  let m = Number(range.from.slice(5, 7));
  const end = range.to.slice(0, 7);
  for (;;) {
    const key = `${y}-${pad(m)}`;
    if (key > end) break;
    months.push(key);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

export function monthLabel(monthKey: string): string {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(monthKey.slice(5, 7)) - 1]} ${monthKey.slice(2, 4)}`;
}

// Australian financial year: 1 July - 30 June.
export function financialYearOf(dayKey: string): DateRange & { label: string } {
  const y = Number(dayKey.slice(0, 4));
  const startYear = Number(dayKey.slice(5, 7)) >= 7 ? y : y - 1;
  return { from: `${startYear}-07-01`, to: `${startYear + 1}-06-30`, label: `FY ${startYear}-${String(startYear + 1).slice(2)}` };
}

export type AnalyticsPreset = "7d" | "28d" | "last_quarter" | "fy" | "custom";

export const ANALYTICS_PRESETS: { value: Exclude<AnalyticsPreset, "custom">; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "28d", label: "Last 28 days" },
  { value: "last_quarter", label: "Last quarter" },
  { value: "fy", label: "This financial year" },
];

function quarterStart(year: number, quarterIndex: number): string {
  return `${year}-${pad(quarterIndex * 3 + 1)}-01`;
}

// "Last quarter" is the previous full calendar quarter, not the last 90
// days and not the quarter in progress.
function previousQuarter(dayKey: string, back: number): DateRange {
  let year = Number(dayKey.slice(0, 4));
  let quarter = Math.floor((Number(dayKey.slice(5, 7)) - 1) / 3) - back;
  while (quarter < 0) {
    quarter += 4;
    year -= 1;
  }
  const from = quarterStart(year, quarter);
  const nextStart = quarter === 3 ? quarterStart(year + 1, 0) : quarterStart(year, quarter + 1);
  return { from, to: addDays(nextStart, -1) };
}

export function presetRange(preset: Exclude<AnalyticsPreset, "custom">, today: string): DateRange {
  switch (preset) {
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "28d":
      return { from: addDays(today, -27), to: today };
    case "last_quarter":
      return previousQuarter(today, 1);
    case "fy":
      return { from: financialYearOf(today).from, to: today };
  }
}

// What a period is compared against: the quarter before for "last
// quarter", the same dates a year earlier for the financial year (so a
// seasonal business compares July-November with July-November), otherwise
// the equally long period immediately before.
export function comparisonRange(preset: AnalyticsPreset, range: DateRange, today: string): DateRange {
  if (preset === "last_quarter") return previousQuarter(today, 2);
  if (preset === "fy") return { from: addYears(range.from, -1), to: addYears(range.to, -1) };
  const length = daysBetween(range.from, range.to) + 1;
  const to = addDays(range.from, -1);
  return { from: addDays(to, -(length - 1)), to };
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface AnalyticsIndex extends AnalyticsData {
  jobById: Map<string, AnalyticsJob>;
  clientById: Map<string, AnalyticsClient>;
  siteById: Map<string, AnalyticsSite>;
  stageById: Map<string, AnalyticsStage>;
  categoryById: Map<string, AnalyticsNamed>;
  revenueInvoices: AnalyticsInvoice[];
  revenueInvoicesByJob: Map<string, AnalyticsInvoice[]>;
  quotesByJob: Map<string, AnalyticsQuote[]>;
  callbacksByOriginalJob: Map<string, AnalyticsJob[]>;
  jobsByClient: Map<string, AnalyticsJob[]>;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// An invoice counts as revenue once it has actually been issued - a draft
// hasn't been sent to anyone and a void one was cancelled.
export function isRevenueInvoice(invoice: Pick<AnalyticsInvoice, "status">): boolean {
  return invoice.status === "sent" || invoice.status === "paid" || invoice.status === "overdue";
}

export function isUnpaidInvoice(invoice: Pick<AnalyticsInvoice, "status">): boolean {
  return invoice.status === "sent" || invoice.status === "overdue";
}

export function indexAnalytics(data: AnalyticsData): AnalyticsIndex {
  const revenueInvoices = data.invoices.filter(isRevenueInvoice);
  const revenueInvoicesByJob = new Map<string, AnalyticsInvoice[]>();
  for (const inv of revenueInvoices) if (inv.job_card_id) pushTo(revenueInvoicesByJob, inv.job_card_id, inv);
  const quotesByJob = new Map<string, AnalyticsQuote[]>();
  for (const q of data.quotes) if (q.job_card_id) pushTo(quotesByJob, q.job_card_id, q);
  const callbacksByOriginalJob = new Map<string, AnalyticsJob[]>();
  const jobsByClient = new Map<string, AnalyticsJob[]>();
  for (const job of data.jobs) {
    if (job.callback_of_job_card_id) pushTo(callbacksByOriginalJob, job.callback_of_job_card_id, job);
    pushTo(jobsByClient, job.client_id, job);
  }
  return {
    ...data,
    jobById: new Map(data.jobs.map((j) => [j.id, j])),
    clientById: new Map(data.clients.map((c) => [c.id, c])),
    siteById: new Map(data.sites.map((s) => [s.id, s])),
    stageById: new Map(data.stages.map((s) => [s.id, s])),
    categoryById: new Map(data.categories.map((c) => [c.id, c])),
    revenueInvoices,
    revenueInvoicesByJob,
    quotesByJob,
    callbacksByOriginalJob,
    jobsByClient,
  };
}

const sumCents = (rows: { total_cents: number }[]) => rows.reduce((sum, r) => sum + r.total_cents, 0);

// ---------------------------------------------------------------------------
// Dashboard KPIs
// ---------------------------------------------------------------------------

export interface QuoteOutcome {
  quotes: AnalyticsQuote[];
  won: AnalyticsQuote[];
  lost: AnalyticsQuote[];
  expired: AnalyticsQuote[];
  pending: AnalyticsQuote[];
  // Won as a share of quotes that have an outcome. Pending quotes are left
  // out of the rate: over a short window most quotes are still waiting on
  // the client, and counting them as not-won reads as a collapse in win
  // rate every time the range is shortened.
  winRate: number | null;
}

export function quoteOutcome(quotes: AnalyticsQuote[]): QuoteOutcome {
  const sent = quotes.filter((q) => q.status !== "draft");
  const won = sent.filter((q) => q.status === "accepted");
  const lost = sent.filter((q) => q.status === "declined");
  const expired = sent.filter((q) => q.status === "expired");
  const pending = sent.filter((q) => q.status === "sent");
  const decided = won.length + lost.length + expired.length;
  return { quotes: sent, won, lost, expired, pending, winRate: decided > 0 ? (won.length / decided) * 100 : null };
}

export interface AnalyticsKpis {
  revenueCents: number;
  revenueInvoices: AnalyticsInvoice[];
  collectedCents: number;
  collectedInvoices: AnalyticsInvoice[];
  jobsCompleted: AnalyticsJob[];
  // Invoiced revenue for jobs, divided by the number of distinct jobs
  // invoiced. Null when no job was invoiced.
  averageJobValueCents: number | null;
  invoicedJobCount: number;
  quotes: QuoteOutcome;
  firstTimeFixRate: number | null;
  firstTimeFixEligible: AnalyticsJob[];
  calledBackJobs: AnalyticsJob[];
  returnCustomerRate: number | null;
  returnCustomerJobs: AnalyticsJob[];
  newCustomerJobs: AnalyticsJob[];
  daysToPayment: number | null;
  paidInvoices: AnalyticsInvoice[];
  feedbackAverage: number | null;
  feedbackClients: AnalyticsClient[];
}

export function daysToPay(invoice: AnalyticsInvoice): number | null {
  if (!invoice.paid_at) return null;
  return Math.max(0, daysBetween(invoice.issue_date, toDayKey(invoice.paid_at)));
}

export function computeKpis(ix: AnalyticsIndex, range: DateRange): AnalyticsKpis {
  const revenueInvoices = ix.revenueInvoices.filter((inv) => inRange(inv.issue_date, range));
  const collectedInvoices = ix.invoices.filter((inv) => inv.status === "paid" && inRange(inv.paid_at, range));

  const jobsCompleted = ix.jobs.filter((job) => inRange(job.completed_at, range));

  const jobInvoices = revenueInvoices.filter((inv) => inv.job_card_id);
  const invoicedJobCount = new Set(jobInvoices.map((inv) => inv.job_card_id)).size;

  // A callback is itself a return visit, so it is never "fixed first time"
  // material - only original jobs are scored.
  const firstTimeFixEligible = jobsCompleted.filter((job) => !job.callback_of_job_card_id);
  const calledBackJobs = firstTimeFixEligible.filter((job) => (ix.callbacksByOriginalJob.get(job.id)?.length ?? 0) > 0);

  // Job-based: the share of this period's jobs that came from a client
  // who already had an earlier job. Callbacks are excluded - going back to
  // fix your own work isn't repeat business.
  const periodJobs = ix.jobs.filter((job) => !job.callback_of_job_card_id && inRange(job.created_at, range));
  const returnCustomerJobs: AnalyticsJob[] = [];
  const newCustomerJobs: AnalyticsJob[] = [];
  for (const job of periodJobs) {
    const earlier = (ix.jobsByClient.get(job.client_id) ?? []).some(
      (other) => other.id !== job.id && !other.callback_of_job_card_id && other.created_at < job.created_at
    );
    (earlier ? returnCustomerJobs : newCustomerJobs).push(job);
  }

  const paidInvoices = collectedInvoices.filter((inv) => daysToPay(inv) !== null);
  const feedbackClients = ix.clients.filter((c) => c.google_review_stars !== null && inRange(c.google_review_recorded_at, range));

  return {
    revenueCents: sumCents(revenueInvoices),
    revenueInvoices,
    collectedCents: sumCents(collectedInvoices),
    collectedInvoices,
    jobsCompleted,
    averageJobValueCents: invoicedJobCount > 0 ? Math.round(sumCents(jobInvoices) / invoicedJobCount) : null,
    invoicedJobCount,
    quotes: quoteOutcome(ix.quotes.filter((q) => inRange(q.issue_date, range))),
    firstTimeFixRate:
      firstTimeFixEligible.length > 0 ? ((firstTimeFixEligible.length - calledBackJobs.length) / firstTimeFixEligible.length) * 100 : null,
    firstTimeFixEligible,
    calledBackJobs,
    returnCustomerRate: periodJobs.length > 0 ? (returnCustomerJobs.length / periodJobs.length) * 100 : null,
    returnCustomerJobs,
    newCustomerJobs,
    daysToPayment: paidInvoices.length > 0 ? paidInvoices.reduce((sum, inv) => sum + (daysToPay(inv) ?? 0), 0) / paidInvoices.length : null,
    paidInvoices,
    feedbackAverage:
      feedbackClients.length > 0 ? feedbackClients.reduce((sum, c) => sum + (c.google_review_stars ?? 0), 0) / feedbackClients.length : null,
    feedbackClients,
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface JobGroupRow {
  key: string;
  label: string;
  jobs: AnalyticsJob[];
  completed: AnalyticsJob[];
  revenueCents: number;
  invoices: AnalyticsInvoice[];
}

const UNASSIGNED = "__none__";

function groupJobs(
  ix: AnalyticsIndex,
  jobs: AnalyticsJob[],
  keyOf: (job: AnalyticsJob) => string | null,
  labelOf: (key: string) => string,
  noneLabel: string
): JobGroupRow[] {
  const groups = new Map<string, JobGroupRow>();
  for (const job of jobs) {
    const key = keyOf(job) ?? UNASSIGNED;
    let row = groups.get(key);
    if (!row) {
      row = { key, label: key === UNASSIGNED ? noneLabel : labelOf(key), jobs: [], completed: [], revenueCents: 0, invoices: [] };
      groups.set(key, row);
    }
    row.jobs.push(job);
    if (job.completed_at) row.completed.push(job);
    const invoices = ix.revenueInvoicesByJob.get(job.id) ?? [];
    row.invoices.push(...invoices);
    row.revenueCents += sumCents(invoices);
  }
  return [...groups.values()].sort((a, b) => b.jobs.length - a.jobs.length || a.label.localeCompare(b.label));
}

// Jobs created in the range, by service category. Revenue is everything
// invoiced against those jobs to date (not just within the range), so a
// category's row answers "what did the jobs we took on come to".
export function jobsByCategory(ix: AnalyticsIndex, range: DateRange): JobGroupRow[] {
  return groupJobs(
    ix,
    ix.jobs.filter((job) => inRange(job.created_at, range)),
    (job) => job.service_category_id,
    (key) => ix.categoryById.get(key)?.name ?? "Deleted category",
    "No category"
  );
}

// Jobs created in the range by the stage they are in now, in pipeline
// order rather than by size.
export function jobsByStage(ix: AnalyticsIndex, range: DateRange): JobGroupRow[] {
  const rows = groupJobs(
    ix,
    ix.jobs.filter((job) => inRange(job.created_at, range)),
    (job) => job.lifecycle_stage_id,
    (key) => ix.stageById.get(key)?.name ?? "Deleted stage",
    "No stage"
  );
  const position = (row: JobGroupRow) => ix.stageById.get(row.key)?.position ?? Number.MAX_SAFE_INTEGER;
  return rows.sort((a, b) => position(a) - position(b));
}

export interface JobsMonthRow {
  month: string;
  label: string;
  created: AnalyticsJob[];
  completed: AnalyticsJob[];
}

export function jobsByMonth(ix: AnalyticsIndex, range: DateRange): JobsMonthRow[] {
  const rows = new Map<string, JobsMonthRow>(
    monthsInRange(range).map((month) => [month, { month, label: monthLabel(month), created: [], completed: [] }])
  );
  for (const job of ix.jobs) {
    if (inRange(job.created_at, range)) rows.get(monthKeyOf(job.created_at))?.created.push(job);
    if (job.completed_at && inRange(job.completed_at, range)) rows.get(monthKeyOf(job.completed_at))?.completed.push(job);
  }
  return [...rows.values()];
}

export interface QuoteMonthRow extends QuoteOutcome {
  month: string;
  label: string;
  wonCents: number;
  lostCents: number;
}

export function quoteOutcomesByMonth(ix: AnalyticsIndex, range: DateRange): QuoteMonthRow[] {
  const byMonth = new Map<string, AnalyticsQuote[]>(monthsInRange(range).map((month) => [month, []]));
  for (const quote of ix.quotes) {
    if (inRange(quote.issue_date, range)) byMonth.get(monthKeyOf(quote.issue_date))?.push(quote);
  }
  return [...byMonth.entries()].map(([month, quotes]) => {
    const outcome = quoteOutcome(quotes);
    return {
      month,
      label: monthLabel(month),
      ...outcome,
      wonCents: sumCents(outcome.won),
      lostCents: sumCents([...outcome.lost, ...outcome.expired]),
    };
  });
}

export interface LostReasonRow {
  key: QuoteLostReason | "unrecorded";
  quotes: AnalyticsQuote[];
  cents: number;
}

// Declined and expired quotes issued in the range, by the reason the
// office recorded. "unrecorded" is its own row rather than being dropped,
// so the report shows how much of the picture is missing.
export function lostReasons(ix: AnalyticsIndex, range: DateRange): LostReasonRow[] {
  const rows = new Map<LostReasonRow["key"], LostReasonRow>();
  for (const quote of ix.quotes) {
    if ((quote.status !== "declined" && quote.status !== "expired") || !inRange(quote.issue_date, range)) continue;
    const key = quote.lost_reason_category ?? "unrecorded";
    let row = rows.get(key);
    if (!row) {
      row = { key, quotes: [], cents: 0 };
      rows.set(key, row);
    }
    row.quotes.push(quote);
    row.cents += quote.total_cents;
  }
  return [...rows.values()].sort((a, b) => b.quotes.length - a.quotes.length);
}

export interface PriceBookUsageRow {
  itemId: string;
  timesBilled: number;
  quantityBilled: number;
  billedCents: number;
  invoiceIds: string[];
  timesQuoted: number;
  quantityQuoted: number;
  quotedCents: number;
  quoteIds: string[];
}

function lineCents(line: AnalyticsLine): number {
  return Math.round(line.quantity * line.unit_price_cents) - (line.waived_amount_cents ?? 0);
}

// How often each Price Book item was billed (lines on issued invoices
// dated in the range) and quoted (included lines on non-draft quotes).
// Amounts are ex-GST line totals. A custom line, or one whose link
// couldn't be backfilled, has no price_book_item_id and isn't counted.
export function priceBookUsage(ix: AnalyticsIndex, invoiceLines: AnalyticsLine[], quoteLines: AnalyticsLine[], range: DateRange): PriceBookUsageRow[] {
  const invoiceIds = new Set(ix.revenueInvoices.filter((inv) => inRange(inv.issue_date, range)).map((inv) => inv.id));
  const quoteIds = new Set(ix.quotes.filter((q) => q.status !== "draft" && inRange(q.issue_date, range)).map((q) => q.id));
  const rows = new Map<string, PriceBookUsageRow>();
  const rowFor = (itemId: string) => {
    let row = rows.get(itemId);
    if (!row) {
      row = { itemId, timesBilled: 0, quantityBilled: 0, billedCents: 0, invoiceIds: [], timesQuoted: 0, quantityQuoted: 0, quotedCents: 0, quoteIds: [] };
      rows.set(itemId, row);
    }
    return row;
  };
  for (const line of invoiceLines) {
    if (!line.price_book_item_id || !invoiceIds.has(line.parent_id)) continue;
    const row = rowFor(line.price_book_item_id);
    row.timesBilled += 1;
    row.quantityBilled += Number(line.quantity);
    row.billedCents += lineCents(line);
    if (!row.invoiceIds.includes(line.parent_id)) row.invoiceIds.push(line.parent_id);
  }
  for (const line of quoteLines) {
    if (!line.price_book_item_id || !quoteIds.has(line.parent_id) || line.is_included === false) continue;
    const row = rowFor(line.price_book_item_id);
    row.timesQuoted += 1;
    row.quantityQuoted += Number(line.quantity);
    row.quotedCents += lineCents(line);
    if (!row.quoteIds.includes(line.parent_id)) row.quoteIds.push(line.parent_id);
  }
  return [...rows.values()].sort((a, b) => b.billedCents - a.billedCents || b.timesQuoted - a.timesQuoted);
}

// ---------------------------------------------------------------------------
// Clients and revenue
// ---------------------------------------------------------------------------

export interface RevenueGroupRow {
  key: string;
  label: string;
  cents: number;
  invoices: AnalyticsInvoice[];
  jobIds: Set<string>;
}

function groupRevenue(invoices: AnalyticsInvoice[], keyOf: (inv: AnalyticsInvoice) => { key: string; label: string }): RevenueGroupRow[] {
  const rows = new Map<string, RevenueGroupRow>();
  for (const inv of invoices) {
    const { key, label } = keyOf(inv);
    let row = rows.get(key);
    if (!row) {
      row = { key, label, cents: 0, invoices: [], jobIds: new Set() };
      rows.set(key, row);
    }
    row.cents += inv.total_cents;
    row.invoices.push(inv);
    if (inv.job_card_id) row.jobIds.add(inv.job_card_id);
  }
  return [...rows.values()].sort((a, b) => b.cents - a.cents || a.label.localeCompare(b.label));
}

const revenueIn = (ix: AnalyticsIndex, range: DateRange) => ix.revenueInvoices.filter((inv) => inRange(inv.issue_date, range));

export function topClients(ix: AnalyticsIndex, range: DateRange): RevenueGroupRow[] {
  return groupRevenue(revenueIn(ix, range), (inv) => ({ key: inv.client_id, label: ix.clientById.get(inv.client_id)?.name ?? "Unknown client" }));
}

export function revenueByCategory(ix: AnalyticsIndex, range: DateRange): RevenueGroupRow[] {
  return groupRevenue(revenueIn(ix, range), (inv) => {
    const job = inv.job_card_id ? ix.jobById.get(inv.job_card_id) : undefined;
    if (!job) return { key: "__no_job__", label: "Not linked to a job" };
    if (!job.service_category_id) return { key: UNASSIGNED, label: "No category" };
    return { key: job.service_category_id, label: ix.categoryById.get(job.service_category_id)?.name ?? "Deleted category" };
  });
}

// Where the work was: the invoice's own site, else the job's site, else
// the client's address. Suburb names are compared case-insensitively so
// "Bondi" and "BONDI" are one row.
export function suburbOfInvoice(ix: AnalyticsIndex, inv: AnalyticsInvoice): { key: string; label: string } {
  const job = inv.job_card_id ? ix.jobById.get(inv.job_card_id) : undefined;
  const site = (inv.site_id && ix.siteById.get(inv.site_id)) || (job?.site_id && ix.siteById.get(job.site_id)) || null;
  const client = ix.clientById.get(inv.client_id);
  const suburb = (site ? site.suburb : client?.suburb)?.trim();
  const postcode = (site ? site.postcode : client?.postcode)?.trim();
  if (!suburb) return { key: "__unknown__", label: "No address recorded" };
  const title = suburb.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return { key: `${suburb.toLowerCase()}|${postcode ?? ""}`, label: postcode ? `${title} ${postcode}` : title };
}

export function revenueBySuburb(ix: AnalyticsIndex, range: DateRange): RevenueGroupRow[] {
  return groupRevenue(revenueIn(ix, range), (inv) => suburbOfInvoice(ix, inv));
}

export interface RevenueYearsCell {
  cents: number;
  invoices: AnalyticsInvoice[];
}

// Invoiced revenue as a month x year grid: rows are January-December,
// columns the given calendar years, so the same month reads straight
// across five years.
export function revenueByMonthAcrossYears(ix: AnalyticsIndex, years: number[]): RevenueYearsCell[][] {
  const grid: RevenueYearsCell[][] = Array.from({ length: 12 }, () => years.map(() => ({ cents: 0, invoices: [] })));
  const column = new Map(years.map((year, index) => [year, index]));
  for (const inv of ix.revenueInvoices) {
    const col = column.get(Number(inv.issue_date.slice(0, 4)));
    if (col === undefined) continue;
    const cell = grid[Number(inv.issue_date.slice(5, 7)) - 1]![col]!;
    cell.cents += inv.total_cents;
    cell.invoices.push(inv);
  }
  return grid;
}

export interface AgedBucket {
  key: string;
  label: string;
  cents: number;
  invoices: AnalyticsInvoice[];
}

// Every unpaid issued invoice as of `today`, by days since it was issued.
export function agedReceivables(ix: AnalyticsIndex, today: string): AgedBucket[] {
  const buckets: (AgedBucket & { max: number })[] = [
    { key: "0-30", label: "0-30 days", max: 30, cents: 0, invoices: [] },
    { key: "31-60", label: "31-60 days", max: 60, cents: 0, invoices: [] },
    { key: "61+", label: "Over 60 days", max: Infinity, cents: 0, invoices: [] },
  ];
  for (const inv of ix.invoices) {
    if (!isUnpaidInvoice(inv)) continue;
    const age = Math.max(0, daysBetween(inv.issue_date, today));
    const bucket = buckets.find((b) => age <= b.max)!;
    bucket.cents += inv.total_cents;
    bucket.invoices.push(inv);
  }
  for (const bucket of buckets) bucket.invoices.sort((a, b) => a.issue_date.localeCompare(b.issue_date));
  return buckets.map(({ max: _max, ...bucket }) => bucket);
}

export interface PipelineBucket {
  key: string;
  label: string;
  cents: number;
  quotes: AnalyticsQuote[];
}

// Quotes sent and still waiting on the client, by how long they've waited.
export function quotePipeline(ix: AnalyticsIndex, today: string): PipelineBucket[] {
  const buckets: (PipelineBucket & { max: number })[] = [
    { key: "0-7", label: "0-7 days", max: 7, cents: 0, quotes: [] },
    { key: "8-14", label: "8-14 days", max: 14, cents: 0, quotes: [] },
    { key: "15-30", label: "15-30 days", max: 30, cents: 0, quotes: [] },
    { key: "31+", label: "Over 30 days", max: Infinity, cents: 0, quotes: [] },
  ];
  for (const quote of ix.quotes) {
    if (quote.status !== "sent") continue;
    const age = Math.max(0, daysBetween(quote.issue_date, today));
    const bucket = buckets.find((b) => age <= b.max)!;
    bucket.cents += quote.total_cents;
    bucket.quotes.push(quote);
  }
  for (const bucket of buckets) bucket.quotes.sort((a, b) => a.issue_date.localeCompare(b.issue_date));
  return buckets.map(({ max: _max, ...bucket }) => bucket);
}

export interface FyTargetMonth {
  month: string;
  label: string;
  cents: number;
  cumulativeCents: number;
  targetCumulativeCents: number;
  elapsed: boolean;
  invoices: AnalyticsInvoice[];
}

export interface FyTargetProgress {
  label: string;
  from: string;
  to: string;
  targetCents: number | null;
  actualCents: number;
  // Straight-line share of the target for the days elapsed so far.
  expectedCents: number | null;
  varianceCents: number | null;
  // Year-end figure if the rest of the year runs at the pace so far.
  projectedCents: number;
  fractionElapsed: number;
  months: FyTargetMonth[];
}

export function fyTargetProgress(ix: AnalyticsIndex, targetCents: number | null, today: string): FyTargetProgress {
  const fy = financialYearOf(today);
  const totalDays = daysBetween(fy.from, fy.to) + 1;
  const elapsedDays = daysBetween(fy.from, today) + 1;
  const fractionElapsed = elapsedDays / totalDays;
  const invoices = ix.revenueInvoices.filter((inv) => inv.issue_date >= fy.from && inv.issue_date <= today);
  const actualCents = sumCents(invoices);
  const currentMonth = today.slice(0, 7);

  let cumulative = 0;
  const months = monthsInRange(fy).map((month, index): FyTargetMonth => {
    const monthInvoices = invoices.filter((inv) => inv.issue_date.slice(0, 7) === month);
    const cents = sumCents(monthInvoices);
    cumulative += cents;
    return {
      month,
      label: monthLabel(month),
      cents,
      cumulativeCents: cumulative,
      targetCumulativeCents: targetCents === null ? 0 : Math.round((targetCents * (index + 1)) / 12),
      elapsed: month <= currentMonth,
      invoices: monthInvoices,
    };
  });

  const expectedCents = targetCents === null ? null : Math.round(targetCents * fractionElapsed);
  return {
    label: fy.label,
    from: fy.from,
    to: fy.to,
    targetCents,
    actualCents,
    expectedCents,
    varianceCents: expectedCents === null ? null : actualCents - expectedCents,
    projectedCents: Math.round(actualCents / fractionElapsed),
    fractionElapsed,
    months,
  };
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export interface FeedbackMonthRow {
  month: string;
  label: string;
  clients: AnalyticsClient[];
  average: number | null;
}

export function feedbackByMonth(ix: AnalyticsIndex, range: DateRange): FeedbackMonthRow[] {
  const rows = new Map<string, FeedbackMonthRow>(
    monthsInRange(range).map((month) => [month, { month, label: monthLabel(month), clients: [], average: null }])
  );
  for (const client of ix.clients) {
    if (client.google_review_stars === null || !client.google_review_recorded_at || !inRange(client.google_review_recorded_at, range)) continue;
    rows.get(monthKeyOf(client.google_review_recorded_at))?.clients.push(client);
  }
  for (const row of rows.values()) {
    if (row.clients.length > 0) row.average = row.clients.reduce((sum, c) => sum + (c.google_review_stars ?? 0), 0) / row.clients.length;
  }
  return [...rows.values()];
}

export function recentFeedback(ix: AnalyticsIndex, limit: number): AnalyticsClient[] {
  return ix.clients
    .filter((c) => c.google_review_stars !== null && c.google_review_recorded_at)
    .sort((a, b) => (b.google_review_recorded_at ?? "").localeCompare(a.google_review_recorded_at ?? ""))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Lead sources
// ---------------------------------------------------------------------------

export interface LeadSourceRow {
  key: string;
  label: string;
  leads: AnalyticsJob[];
  converted: AnalyticsJob[];
  conversionRate: number | null;
  completed: AnalyticsJob[];
  completedRevenueCents: number;
  completedInvoices: AnalyticsInvoice[];
}

// A lead is a job created in the range. It converted if it turned into
// paying work: an accepted quote, an issued invoice, or a completed job.
// Revenue is what was invoiced against the leads that reached completion.
export function leadSourcePerformance(ix: AnalyticsIndex, range: DateRange): LeadSourceRow[] {
  const sourceName = new Map(ix.leadSources.map((s) => [s.id, s.name]));
  const rows = new Map<string, LeadSourceRow>();
  for (const job of ix.jobs) {
    if (!inRange(job.created_at, range)) continue;
    const key = job.lead_source_id ?? UNASSIGNED;
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        label: key === UNASSIGNED ? "No source recorded" : sourceName.get(key) ?? "Deleted source",
        leads: [],
        converted: [],
        conversionRate: null,
        completed: [],
        completedRevenueCents: 0,
        completedInvoices: [],
      };
      rows.set(key, row);
    }
    row.leads.push(job);
    const invoices = ix.revenueInvoicesByJob.get(job.id) ?? [];
    const accepted = (ix.quotesByJob.get(job.id) ?? []).some((q) => q.status === "accepted");
    if (accepted || invoices.length > 0 || job.completed_at) row.converted.push(job);
    if (job.completed_at) {
      row.completed.push(job);
      row.completedInvoices.push(...invoices);
      row.completedRevenueCents += sumCents(invoices);
    }
  }
  for (const row of rows.values()) row.conversionRate = row.leads.length > 0 ? (row.converted.length / row.leads.length) * 100 : null;
  return [...rows.values()].sort((a, b) => b.leads.length - a.leads.length || a.label.localeCompare(b.label));
}

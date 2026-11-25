// The Invoicing summary (desktop Invoicing > Summary): where things stand,
// what's coming in and when, who owes the most, and where the money comes
// from. Built on the analytics index, with the same definitions as
// Analytics (revenue = invoices issued, by issue date; owing = total less
// deposits and part payments).

import {
  daysBetween,
  daysToPay,
  inRange,
  invoiceOwingCents,
  isRevenueInvoice,
  isUnpaidInvoice,
  monthKeyOf,
  monthLabel,
  toDayKey,
  addDays,
  type AnalyticsIndex,
  type AnalyticsInvoice,
  type AnalyticsQuote,
  type DateRange,
  type RevenueGroupRow,
} from "./analytics";

export type InvoicingStatusKey = "open_quotes" | "accepted_not_invoiced" | "draft_invoices" | "awaiting_payment" | "overdue" | "paid_this_month";

export interface InvoicingStatusRow {
  key: InvoicingStatusKey;
  label: string;
  hint: string;
  cents: number;
  count: number;
  invoices: AnalyticsInvoice[];
  quotes: AnalyticsQuote[];
}

// Overdue = unpaid and past its due date (or already marked overdue).
export function isOverdue(inv: Pick<AnalyticsInvoice, "status" | "due_date">, today: string): boolean {
  if (!isUnpaidInvoice(inv)) return false;
  return inv.status === "overdue" || (!!inv.due_date && inv.due_date < today);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function itemsByStatus(ix: AnalyticsIndex, today: string): InvoicingStatusRow[] {
  // Jobs that already have an invoice (any but void), so their accepted
  // quote isn't still "to invoice".
  const invoicedJobs = new Set(ix.invoices.filter((i) => i.status !== "void" && i.job_card_id).map((i) => i.job_card_id!));
  const openQuotes = ix.quotes.filter((q) => q.status === "sent");
  const toInvoice = ix.quotes.filter((q) => q.status === "accepted" && !(q.job_card_id && invoicedJobs.has(q.job_card_id)));
  const drafts = ix.invoices.filter((i) => i.status === "draft");
  const unpaid = ix.invoices.filter((i) => isUnpaidInvoice(i) && invoiceOwingCents(i) > 0);
  const overdue = unpaid.filter((i) => isOverdue(i, today));
  const awaiting = unpaid.filter((i) => !isOverdue(i, today));
  const month = today.slice(0, 7);
  const paidThisMonth = ix.invoices.filter((i) => i.status === "paid" && i.paid_at && monthKeyOf(i.paid_at) === month);
  const quoteRow = (key: InvoicingStatusKey, label: string, hint: string, quotes: AnalyticsQuote[]): InvoicingStatusRow => ({
    key,
    label,
    hint,
    cents: sum(quotes.map((q) => q.total_cents)),
    count: quotes.length,
    invoices: [],
    quotes,
  });
  const invoiceRow = (key: InvoicingStatusKey, label: string, hint: string, invoices: AnalyticsInvoice[], owing: boolean): InvoicingStatusRow => ({
    key,
    label,
    hint,
    cents: sum(invoices.map((i) => (owing ? invoiceOwingCents(i) : i.total_cents))),
    count: invoices.length,
    invoices,
    quotes: [],
  });
  return [
    quoteRow("open_quotes", "Quotes waiting on the client", "Sent, not yet accepted or declined", openQuotes),
    quoteRow("accepted_not_invoiced", "Accepted - not invoiced yet", "Work won that hasn't been billed", toInvoice),
    invoiceRow("draft_invoices", "Draft invoices", "Ready to check and send", drafts, false),
    invoiceRow("awaiting_payment", "Awaiting payment", "Sent and not yet due (what's still owing)", awaiting, true),
    invoiceRow("overdue", "Overdue", "Past the due date (what's still owing)", overdue, true),
    invoiceRow("paid_this_month", "Paid this month", "Invoices fully paid since the 1st", paidThisMonth, false),
  ];
}

export interface DueBucket {
  key: string;
  label: string;
  // Fits under a column.
  short: string;
  cents: number;
  invoices: AnalyticsInvoice[];
  overdue: boolean;
}

// What's owed, by when it's due: how much is already late (and how late),
// and how much is due soon.
export function moneyComingIn(ix: AnalyticsIndex, today: string): DueBucket[] {
  const buckets: (DueBucket & { test: (daysUntilDue: number | null) => boolean })[] = [
    { key: "late_60", label: "60+ days late", short: "60+ late", overdue: true, test: (d) => d !== null && d < -60, cents: 0, invoices: [] },
    { key: "late_31", label: "31-60 days late", short: "31-60 late", overdue: true, test: (d) => d !== null && d < -30 && d >= -60, cents: 0, invoices: [] },
    { key: "late_1", label: "1-30 days late", short: "1-30 late", overdue: true, test: (d) => d !== null && d < 0 && d >= -30, cents: 0, invoices: [] },
    { key: "week", label: "Due this week", short: "This week", overdue: false, test: (d) => d !== null && d >= 0 && d <= 7, cents: 0, invoices: [] },
    { key: "month", label: "Due in 8-30 days", short: "8-30 days", overdue: false, test: (d) => d !== null && d > 7 && d <= 30, cents: 0, invoices: [] },
    { key: "later", label: "Later / no due date", short: "Later", overdue: false, test: (d) => d === null || d > 30, cents: 0, invoices: [] },
  ];
  for (const inv of ix.invoices) {
    if (!isUnpaidInvoice(inv)) continue;
    const owing = invoiceOwingCents(inv);
    if (owing <= 0) continue;
    // An invoice marked overdue with no due date counts as 1-30 days late.
    const d = inv.due_date ? daysBetween(today, inv.due_date) : inv.status === "overdue" ? -1 : null;
    const bucket = buckets.find((b) => b.test(d))!;
    bucket.cents += owing;
    bucket.invoices.push(inv);
  }
  return buckets.map(({ test: _t, ...b }) => ({ ...b, invoices: b.invoices.sort((a, c) => (a.due_date ?? "9").localeCompare(c.due_date ?? "9")) }));
}

export interface DebtorRow {
  clientId: string;
  name: string;
  cents: number;
  overdueCents: number;
  invoices: AnalyticsInvoice[];
  // Days the oldest overdue invoice is past due, or null if none overdue.
  oldestDaysLate: number | null;
}

export function debtors(ix: AnalyticsIndex, today: string): DebtorRow[] {
  const rows = new Map<string, DebtorRow>();
  for (const inv of ix.invoices) {
    if (!isUnpaidInvoice(inv)) continue;
    const owing = invoiceOwingCents(inv);
    if (owing <= 0) continue;
    let row = rows.get(inv.client_id);
    if (!row) {
      row = { clientId: inv.client_id, name: ix.clientById.get(inv.client_id)?.name ?? "Unknown client", cents: 0, overdueCents: 0, invoices: [], oldestDaysLate: null };
      rows.set(inv.client_id, row);
    }
    row.cents += owing;
    row.invoices.push(inv);
    if (isOverdue(inv, today)) {
      row.overdueCents += owing;
      const late = inv.due_date ? Math.max(0, daysBetween(inv.due_date, today)) : 0;
      row.oldestDaysLate = Math.max(row.oldestDaysLate ?? 0, late);
    }
  }
  return [...rows.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
}

// Invoiced (issued) per month, for the last `months` months to today.
export function invoicedByMonth(ix: AnalyticsIndex, today: string, months = 12): { month: string; label: string; cents: number; invoices: AnalyticsInvoice[] }[] {
  const keys: string[] = [];
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  for (let i = 0; i < months; i++) {
    keys.unshift(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  const rows = new Map(keys.map((k) => [k, { month: k, label: monthLabel(k), cents: 0, invoices: [] as AnalyticsInvoice[] }]));
  for (const inv of ix.revenueInvoices) {
    const row = rows.get(monthKeyOf(inv.issue_date));
    if (!row) continue;
    row.cents += inv.total_cents;
    row.invoices.push(inv);
  }
  return [...rows.values()];
}

// Invoiced revenue by where the job came from (its lead source).
export function revenueByLeadSource(ix: AnalyticsIndex, range: DateRange): RevenueGroupRow[] {
  const names = new Map(ix.leadSources.map((s) => [s.id, s.name]));
  const rows = new Map<string, RevenueGroupRow>();
  for (const inv of ix.revenueInvoices) {
    if (!inRange(inv.issue_date, range)) continue;
    const job = inv.job_card_id ? ix.jobById.get(inv.job_card_id) : undefined;
    const key = !job ? "__no_job__" : job.lead_source_id ?? "__none__";
    const label = !job ? "Not linked to a job" : job.lead_source_id ? names.get(job.lead_source_id) ?? "Deleted source" : "No source recorded";
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

// Average days from issue to paid, for invoices paid in the last `days`.
export function averageDaysToPay(ix: AnalyticsIndex, today: string, days = 90): { average: number | null; count: number } {
  const from = addDays(today, -(days - 1));
  const paid = ix.invoices.filter((i) => i.status === "paid" && i.paid_at && toDayKey(i.paid_at) >= from && toDayKey(i.paid_at) <= today);
  const values = paid.map(daysToPay).filter((d): d is number => d !== null);
  return { average: values.length ? Math.round(sum(values) / values.length) : null, count: values.length };
}

export function revenueInRange(ix: AnalyticsIndex, range: DateRange): number {
  return sum(ix.revenueInvoices.filter((i) => isRevenueInvoice(i) && inRange(i.issue_date, range)).map((i) => i.total_cents));
}

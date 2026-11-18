// Deposits and part payments - the maths the screens show. The database
// does the same sums (see the payments migration's quote_deposit_due_cents
// and refresh_invoice_payments); these are for showing them, not deciding.

import type { Invoice, PaymentMethod, Quote } from "./types";

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  tap_to_pay: "Tap to Pay",
  card_online: "Card (online)",
  card: "Card (other machine)",
  cash: "Cash",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  other: "Other",
  xero: "Paid in Xero",
};

// What can be recorded by hand - card payments through Stripe (online or
// Tap to Pay) are recorded automatically when Stripe confirms them.
export const MANUAL_PAYMENT_METHODS: PaymentMethod[] = ["bank_transfer", "cash", "card", "cheque", "other"];

export type DepositKind = "none" | "percent" | "fixed";

export function quoteDepositKind(quote: Pick<Quote, "deposit_percent" | "deposit_fixed_cents">): DepositKind {
  if (quote.deposit_fixed_cents != null) return "fixed";
  if (quote.deposit_percent != null) return "percent";
  return "none";
}

// The deposit a quote asks for, in cents. A fixed deposit is never more
// than the quote itself.
export function quoteDepositDueCents(quote: Pick<Quote, "deposit_percent" | "deposit_fixed_cents" | "total_cents">): number {
  const total = Math.max(quote.total_cents, 0);
  if (quote.deposit_fixed_cents != null) return Math.min(quote.deposit_fixed_cents, total);
  if (quote.deposit_percent != null) return Math.round((total * Number(quote.deposit_percent)) / 100);
  return 0;
}

export function quoteDepositRemainingCents(quote: Pick<Quote, "deposit_percent" | "deposit_fixed_cents" | "total_cents" | "deposit_paid_cents">): number {
  return Math.max(quoteDepositDueCents(quote) - (quote.deposit_paid_cents ?? 0), 0);
}

// Most that can still be taken against a quote before it's invoiced.
export function quoteBalanceCents(quote: Pick<Quote, "total_cents" | "deposit_paid_cents">): number {
  return Math.max(quote.total_cents - (quote.deposit_paid_cents ?? 0), 0);
}

export function invoiceBalanceCents(invoice: Pick<Invoice, "total_cents" | "amount_paid_cents">): number {
  return Math.max(invoice.total_cents - (invoice.amount_paid_cents ?? 0), 0);
}

// Paid more than the total (e.g. the invoice was reduced after paying).
export function invoiceOverpaidCents(invoice: Pick<Invoice, "total_cents" | "amount_paid_cents">): number {
  return Math.max((invoice.amount_paid_cents ?? 0) - invoice.total_cents, 0);
}

// "$1,234.50", "1234.5", "1,234" -> cents. null for anything that isn't a
// positive amount with at most 2 decimal places.
export function parseDollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return cents > 0 ? cents : null;
}

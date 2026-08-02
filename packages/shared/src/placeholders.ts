import { formatCentsAsAud } from "./money";

// Dynamic {token} replacement for communication_templates' body/subject
// text. Unmatched tokens (a template referencing a token whose context
// piece wasn't supplied, e.g. {quote_number} on a job-only message) are
// left in the output literally, not blanked to an empty string - a
// silently blank gap in an outbound SMS is worse than an obviously wrong
// "{quote_number}" that makes the bug visible immediately.
//
// This is the client-side (preview) implementation, used by the
// Automation & Messaging Settings screen's template editor to show "here's
// what this would actually say" with sample or real data. The dispatcher
// Edge Function (supabase/functions/process-scheduled-comms) has its own
// near-identical Deno-native copy for actual send-time rendering, since
// Supabase Edge Functions can't import code from outside their own
// function directory - see that function's own comment. Keep both in sync
// by hand if the token set ever changes.

export interface PlaceholderCompanyContext {
  name: string;
  phone: string | null;
  email: string | null;
  bank_account_name: string | null;
  bank_bsb: string | null;
  bank_account_number: string | null;
  google_review_link: string | null;
}

export interface PlaceholderClientContext {
  name: string;
  phone: string | null;
  email: string | null;
}

export interface PlaceholderJobContext {
  number: string | null;
  title: string;
  site_address: string | null;
}

export interface PlaceholderQuoteContext {
  quote_number: string;
  total_cents: number;
  issue_date: string;
  expiry_date: string | null;
  approval_link: string | null;
  // One-click action links (approval_link + &action=accept/decline) - the
  // approval page pre-fills/scrolls to the matching form instead of
  // auto-submitting on load, since a blind auto-submit would let email
  // security scanners that prefetch links (Microsoft Safe Links, Proofpoint,
  // ...) silently accept/decline quotes before a human ever opens the
  // email. Null whenever approval_link itself is null.
  accept_link: string | null;
  decline_link: string | null;
}

export interface PlaceholderInvoiceContext {
  invoice_number: string;
  total_cents: number;
  due_date: string | null;
  payment_link: string | null;
}

export interface PlaceholderScheduleContext {
  tech_first_name: string | null;
  booking_date: string | null;
  booking_start_time: string | null;
  eta_minutes: number | null;
}

export interface PlaceholderContext {
  company?: PlaceholderCompanyContext;
  client?: PlaceholderClientContext;
  job?: PlaceholderJobContext;
  quote?: PlaceholderQuoteContext;
  invoice?: PlaceholderInvoiceContext;
  schedule?: PlaceholderScheduleContext;
}

function formatDateAu(dateString: string | null | undefined): string {
  if (!dateString) return "";
  const d = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateString;
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

export function buildPlaceholderTokens(context: PlaceholderContext): Record<string, string> {
  const tokens: Record<string, string> = {};

  if (context.client) {
    tokens.client_full_name = context.client.name;
    tokens.client_first_name = firstName(context.client.name);
    tokens.client_phone = context.client.phone ?? "";
    tokens.client_email = context.client.email ?? "";
  }

  if (context.job) {
    tokens.job_number = context.job.number ?? "";
    tokens.job_title = context.job.title;
    tokens.site_address = context.job.site_address ?? "";
  }

  if (context.quote) {
    tokens.quote_number = context.quote.quote_number;
    tokens.quote_total = formatCentsAsAud(context.quote.total_cents);
    tokens.quote_issue_date = formatDateAu(context.quote.issue_date);
    tokens.quote_expiry_date = formatDateAu(context.quote.expiry_date);
    tokens.quote_approval_link = context.quote.approval_link ?? "";
    tokens.quote_accept_link = context.quote.accept_link ?? "";
    tokens.quote_decline_link = context.quote.decline_link ?? "";
  }

  if (context.invoice) {
    tokens.invoice_number = context.invoice.invoice_number;
    tokens.invoice_total = formatCentsAsAud(context.invoice.total_cents);
    tokens.invoice_due_date = formatDateAu(context.invoice.due_date);
    tokens.invoice_payment_link = context.invoice.payment_link ?? "";
  }

  if (context.schedule) {
    tokens.tech_first_name = context.schedule.tech_first_name ?? "";
    tokens.booking_date = formatDateAu(context.schedule.booking_date);
    tokens.booking_start_time = context.schedule.booking_start_time ?? "";
    tokens.eta_minutes = context.schedule.eta_minutes != null ? String(context.schedule.eta_minutes) : "";
  }

  if (context.company) {
    tokens.company_name = context.company.name;
    tokens.company_phone = context.company.phone ?? "";
    tokens.company_email = context.company.email ?? "";
    tokens.bank_account_name = context.company.bank_account_name ?? "";
    tokens.bank_bsb = context.company.bank_bsb ?? "";
    tokens.bank_account_number = context.company.bank_account_number ?? "";
    tokens.google_review_link = context.company.google_review_link ?? "";
  }

  return tokens;
}

// Every known token, for the "insert tag" picker in the template editor -
// deliberately not derived from buildPlaceholderTokens (which only lists
// tokens a given *populated* context has), since the editor needs to offer
// the full set regardless of what preview data happens to be loaded.
export const ALL_PLACEHOLDER_TOKENS = [
  "client_full_name",
  "client_first_name",
  "client_phone",
  "client_email",
  "job_number",
  "job_title",
  "site_address",
  "quote_number",
  "quote_total",
  "quote_issue_date",
  "quote_expiry_date",
  "quote_approval_link",
  "quote_accept_link",
  "quote_decline_link",
  "invoice_number",
  "invoice_total",
  "invoice_due_date",
  "invoice_payment_link",
  "tech_first_name",
  "booking_date",
  "booking_start_time",
  "eta_minutes",
  "company_name",
  "company_phone",
  "company_email",
  "bank_account_name",
  "bank_bsb",
  "bank_account_number",
  "google_review_link",
] as const;

export function renderTemplate(body: string, context: PlaceholderContext): string {
  const tokens = buildPlaceholderTokens(context);
  return body.replace(/\{(\w+)\}/g, (match, key: string) => (key in tokens ? tokens[key]! : match));
}

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

export interface PlaceholderNteContext {
  limit_cents: number;
  current_total_cents: number;
  approval_link: string | null;
}

// property_maintenance_due only - the recipient is the property manager,
// not a client, hence pm_first_name rather than reusing PlaceholderClientContext.
export interface PlaceholderPropertyContext {
  address: string;
  pm_first_name: string | null;
  maintenance_due_date: string | null;
}

// referral_lead_received/referral_job_completed only - the recipient is the
// referral partner, not a client, hence partner_first_name rather than
// reusing PlaceholderClientContext. job_value_cents is null for the
// lead_received variant (nothing won yet) and set for job_completed.
export interface PlaceholderReferralPartnerContext {
  partner_first_name: string;
  referred_client_name: string | null;
  job_title: string | null;
  job_value_cents: number | null;
}

// report_sent only - the recipient is the report's linked client (or the
// linked job's client), same as the quote/invoice tokens above.
// pdf_link is a signed URL to the private "report-files" bucket object
// (see the dispatcher's buildEntityContext) - null if the report has no
// compiled PDF yet, which shouldn't happen in practice (report_sent is
// only ever triggered from a completed report's own "Send via Email"
// button), but a null-safe empty string is cheaper than a runtime
// assumption.
export interface PlaceholderReportContext {
  title: string;
  pdf_link: string | null;
}

// subcontractor_quote_request/subcontractor_work_order only - recipient is
// a subcontractor contact, not a client. contact_first_name comes from
// whichever contact the PO/quote request names (or the subcontractor's
// primary contact); job_title/site_address are covered by the existing
// PlaceholderJobContext (built alongside this one for entity_type=
// 'purchase_order' - see the dispatcher's buildEntityContext), not
// duplicated here. quote_link is set only for a quote request, pdf_link
// only once a real PO has a compiled PDF - both null-safe empty strings
// otherwise, same reasoning as PlaceholderReportContext.pdf_link.
export interface PlaceholderPurchaseOrderContext {
  contact_first_name: string;
  po_number: string | null;
  po_total_cents: number;
  quote_link: string | null;
  pdf_link: string | null;
}

// subcontractor_compliance_expired only (queued by the daily
// process-subcontractor-compliance sweep, one row per contact).
export interface PlaceholderSubcontractorContext {
  contact_first_name: string;
  company_name: string;
  expired_doc_type_label: string;
  expired_doc_expiry_date: string | null;
}

export interface PlaceholderContext {
  company?: PlaceholderCompanyContext;
  client?: PlaceholderClientContext;
  job?: PlaceholderJobContext;
  quote?: PlaceholderQuoteContext;
  invoice?: PlaceholderInvoiceContext;
  purchaseOrder?: PlaceholderPurchaseOrderContext;
  subcontractor?: PlaceholderSubcontractorContext;
  schedule?: PlaceholderScheduleContext;
  nte?: PlaceholderNteContext;
  property?: PlaceholderPropertyContext;
  referralPartner?: PlaceholderReferralPartnerContext;
  report?: PlaceholderReportContext;
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

  if (context.nte) {
    tokens.nte_limit = formatCentsAsAud(context.nte.limit_cents);
    tokens.nte_current_total = formatCentsAsAud(context.nte.current_total_cents);
    tokens.nte_exceeded_by = formatCentsAsAud(context.nte.current_total_cents - context.nte.limit_cents);
    tokens.nte_approval_link = context.nte.approval_link ?? "";
  }

  if (context.property) {
    tokens.property_address = context.property.address;
    tokens.pm_first_name = context.property.pm_first_name ?? "";
    tokens.property_maintenance_due_date = formatDateAu(context.property.maintenance_due_date);
  }

  if (context.referralPartner) {
    tokens.partner_first_name = context.referralPartner.partner_first_name;
    tokens.referred_client_name = context.referralPartner.referred_client_name ?? "";
    tokens.job_title = context.referralPartner.job_title ?? "";
    tokens.job_value = context.referralPartner.job_value_cents != null ? formatCentsAsAud(context.referralPartner.job_value_cents) : "";
    // digest_* tokens are never resolved here - the monthly digest email is
    // fully pre-rendered by process-referral-digest before insert (see that
    // function's own comment), so there's no per-send context to build for
    // them; left unhandled here so an unrendered {digest_*} token in any
    // OTHER trigger_key's template stays visibly wrong rather than
    // silently blanking.
  }

  if (context.report) {
    tokens.report_title = context.report.title;
    tokens.report_pdf_link = context.report.pdf_link ?? "";
  }

  if (context.purchaseOrder) {
    tokens.subcontractor_contact_first_name = context.purchaseOrder.contact_first_name;
    tokens.po_number = context.purchaseOrder.po_number ?? "";
    tokens.po_total = formatCentsAsAud(context.purchaseOrder.po_total_cents);
    tokens.po_quote_link = context.purchaseOrder.quote_link ?? "";
    tokens.po_pdf_link = context.purchaseOrder.pdf_link ?? "";
  }

  if (context.subcontractor) {
    tokens.subcontractor_contact_first_name = context.subcontractor.contact_first_name;
    tokens.subcontractor_company_name = context.subcontractor.company_name;
    tokens.expired_doc_type = context.subcontractor.expired_doc_type_label;
    tokens.expired_doc_expiry_date = formatDateAu(context.subcontractor.expired_doc_expiry_date);
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
  "nte_limit",
  "nte_current_total",
  "nte_exceeded_by",
  "nte_approval_link",
  "property_address",
  "pm_first_name",
  "property_maintenance_due_date",
  "partner_first_name",
  "referred_client_name",
  "job_value",
  "digest_jobs_count",
  "digest_total_value",
  "report_title",
  "report_pdf_link",
  "subcontractor_contact_first_name",
  "po_number",
  "po_total",
  "po_quote_link",
  "po_pdf_link",
  "subcontractor_company_name",
  "expired_doc_type",
  "expired_doc_expiry_date",
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

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  collectRecipientEmails,
  renderTemplate,
  type Agency,
  type ApprovalStatus,
  type Client,
  type ClientContact,
  type ClientSite,
  type EmailAttachment,
  type Invoice,
  type InvoiceStatus,
  type LineItemFormInput,
  type Property,
  type ReferralPartner,
  type Tenant,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { queueAndSendEmail } from "../lib/send-email";
import { buildInvoicePdfHtml } from "../lib/quote-invoice-pdf";
import { blobToDataUrl, buildInvoicePdfBytes } from "../lib/quote-invoice-pdf-bytes";
import { exportPdf } from "../lib/print";
import { LineItemEditor, LineItemSummary } from "../components/LineItemEditor";
import { Modal } from "../components/Modal";
import { EmailComposeModal } from "../components/EmailComposeModal";
import { RealEstateAssignmentModal } from "../components/RealEstateAssignmentModal";
import { WorkOrderNumberModal } from "../components/WorkOrderNumberModal";
import { ReferralPartnerModal, referralPartnerLabel } from "../components/ReferralPartnerModal";
import { PurchaseOrderNumberModal } from "../components/PurchaseOrderNumberModal";

function formatSiteAddress(site: Pick<ClientSite, "address_line1" | "address_line2" | "suburb" | "state" | "postcode">): string {
  return [site.address_line1, site.address_line2, [site.suburb, site.state, site.postcode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
}

const STATUSES: InvoiceStatus[] = ["draft", "sent", "paid", "overdue", "void"];
const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
};
const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  sent: "Link sent - awaiting response",
  viewed: "Viewed by client - awaiting response",
  accepted: "Accepted by client",
  declined: "Declined by client",
};

type InvoiceJobCard = {
  id: string;
  title: string;
  is_real_estate_job: boolean;
  agency_id: string | null;
  property_manager_id: string | null;
  property_id: string | null;
  work_order_number: string | null;
  nte_limit_cents: number | null;
  referral_partner_id: string | null;
};
type InvoiceRow = Invoice & { clients: Client | null; job_cards: InvoiceJobCard | null };

async function fetchInvoice(id: string): Promise<{ invoice: InvoiceRow; items: LineItemFormInput[] }> {
  const [{ data: invoice, error: invoiceError }, { data: items, error: itemsError }] = await Promise.all([
    supabase
      .from("invoices")
      .select(
        "*, clients(*), job_cards!invoices_job_card_id_fkey(id, title, is_real_estate_job, agency_id, property_manager_id, property_id, work_order_number, nte_limit_cents, referral_partner_id)"
      )
      .eq("id", id)
      .single(),
    supabase.from("invoice_line_items").select("*").eq("invoice_id", id).order("sort_order"),
  ]);
  if (invoiceError) throw invoiceError;
  if (itemsError) throw itemsError;
  return { invoice: invoice as InvoiceRow, items: (items ?? []) as LineItemFormInput[] };
}

async function fetchTenant(tenantId: string): Promise<Tenant> {
  const { data, error } = await supabase.from("tenants").select("*").eq("id", tenantId).single();
  if (error) throw error;
  return data as Tenant;
}

async function fetchAgency(agencyId: string): Promise<Agency> {
  const { data, error } = await supabase.from("agencies").select("*").eq("id", agencyId).single();
  if (error) throw error;
  return data as Agency;
}

async function fetchProperty(propertyId: string): Promise<Property> {
  const { data, error } = await supabase.from("properties").select("*").eq("id", propertyId).single();
  if (error) throw error;
  return data as Property;
}

async function fetchReferralPartner(id: string): Promise<ReferralPartner> {
  const { data, error } = await supabase.from("referral_partners").select("*").eq("id", id).single();
  if (error) throw error;
  return data as ReferralPartner;
}

async function fetchClientSites(clientId: string): Promise<ClientSite[]> {
  const { data, error } = await supabase
    .from("client_sites")
    .select("*")
    .eq("client_id", clientId)
    .order("is_primary", { ascending: false })
    .order("label");
  if (error) throw error;
  return data as ClientSite[];
}

async function fetchClientContacts(clientId: string): Promise<ClientContact[]> {
  const { data, error } = await supabase.from("client_contacts").select("*").eq("client_id", clientId);
  if (error) throw error;
  return data as ClientContact[];
}

async function fetchJobNoteBodies(jobCardId: string): Promise<string[]> {
  const { data, error } = await supabase.from("job_notes").select("body").eq("job_card_id", jobCardId);
  if (error) throw error;
  return (data ?? []).map((n) => n.body as string);
}

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ["invoice", id], queryFn: () => fetchInvoice(id!), enabled: !!id });
  const { data: tenant } = useQuery({
    queryKey: ["tenant", profile?.tenant_id],
    queryFn: () => fetchTenant(profile!.tenant_id),
    enabled: !!profile,
  });
  const jobCard = data?.invoice.job_cards;
  const { data: agency } = useQuery({
    queryKey: ["agency", jobCard?.agency_id],
    queryFn: () => fetchAgency(jobCard!.agency_id!),
    enabled: !!jobCard?.agency_id,
  });
  const { data: property } = useQuery({
    queryKey: ["property", jobCard?.property_id],
    queryFn: () => fetchProperty(jobCard!.property_id!),
    enabled: !!jobCard?.property_id,
  });
  const { data: clientSites } = useQuery({
    queryKey: ["client-sites", data?.invoice.client_id],
    queryFn: () => fetchClientSites(data!.invoice.client_id),
    enabled: !!data,
  });
  const { data: clientContacts } = useQuery({
    queryKey: ["client-contacts", data?.invoice.client_id],
    queryFn: () => fetchClientContacts(data!.invoice.client_id),
    enabled: !!data,
  });
  const { data: jobNoteBodies } = useQuery({
    queryKey: ["job-notes-text", data?.invoice.job_card_id],
    queryFn: () => fetchJobNoteBodies(data!.invoice.job_card_id!),
    enabled: !!data?.invoice.job_card_id,
  });
  const { data: referralPartner } = useQuery({
    queryKey: ["referral-partner", jobCard?.referral_partner_id],
    queryFn: () => fetchReferralPartner(jobCard!.referral_partner_id!),
    enabled: !!jobCard?.referral_partner_id,
  });

  // Workflow 4 of the Real Estate & Strata spec: an agency that requires a
  // work order number on every invoice should never actually receive one
  // without it - enforced here, at the point an invoice actually goes out
  // (email, approval link, or PDF), not at invoice creation time, since the
  // work order number may legitimately still be pending entry until then.
  const agencyComplianceError =
    jobCard?.is_real_estate_job && agency?.require_work_order_num && !jobCard.work_order_number
      ? `${agency.name} requires a work order number on every invoice - add one on the job before sending this invoice.`
      : null;

  const [lineItems, setLineItems] = useState<LineItemFormInput[]>([]);
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [sendEmailError, setSendEmailError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<string | null>(null);

  const isLocked = data?.invoice.approval_status === "accepted" || data?.invoice.approval_status === "declined";

  useEffect(() => {
    if (data) {
      setLineItems(data.items);
      setNotes(data.invoice.notes ?? "");
      setDueDate(data.invoice.due_date ?? "");
    }
  }, [data]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["invoice", id] });
    queryClient.invalidateQueries({ queryKey: ["invoices"] });
  };

  const changeStatus = useMutation({
    mutationFn: async (status: InvoiceStatus) => {
      const { error } = await supabase.from("invoices").update({ status }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const save = useMutation({
    mutationFn: async () => {
      const { error: updateError } = await supabase
        .from("invoices")
        .update({ notes: notes || null, due_date: dueDate || null })
        .eq("id", id);
      if (updateError) throw updateError;

      const { error: rpcError } = await supabase.rpc("replace_invoice_line_items", { p_invoice_id: id, p_items: lineItems });
      if (rpcError) throw rpcError;
    },
    onSuccess: () => {
      invalidate();
      setSaveError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save")),
  });

  const generateLink = useMutation({
    mutationFn: async () => {
      if (agencyComplianceError) throw new Error(agencyComplianceError);
      const approvalPageUrl = import.meta.env.VITE_APPROVAL_PAGE_URL;
      if (!approvalPageUrl) {
        throw new Error("Approval page URL not configured - set VITE_APPROVAL_PAGE_URL in .env (see docs/SETUP.md)");
      }
      const { data: token, error } = await supabase.rpc("generate_invoice_approval_link", { p_invoice_id: id });
      if (error) throw error;
      const url = `${approvalPageUrl}?type=invoice&token=${token}`;
      await navigator.clipboard.writeText(url);
      return url;
    },
    onSuccess: () => {
      invalidate();
      setLinkError(null);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 3000);
    },
    onError: (e) => setLinkError(getErrorMessage(e, "Failed to generate approval link")),
  });

  // "Send Invoice via Email" pops the editable EmailComposeModal instead of
  // firing the template straight off - see QuoteDetail.tsx's identical
  // split into openSendEmail (prefill) + handleSendEmail (actual send via
  // queueAndSendEmail) for the full reasoning.
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailDefaults, setEmailDefaults] = useState({ subject: "", body: "" });
  const [emailDefaultAttachments, setEmailDefaultAttachments] = useState<EmailAttachment[]>([]);
  const [openingEmail, setOpeningEmail] = useState(false);

  const openSendEmail = async () => {
    if (!data || !profile || !tenant || !data.invoice.clients) return;
    if (agencyComplianceError) {
      setSendEmailError(agencyComplianceError);
      return;
    }
    if (!invoiceRecipientEmail) {
      setSendEmailError(
        data.invoice.bill_to_landlord
          ? "This invoice is set to bill the landlord, but no landlord email is on file - add one on the property's Access & Contacts tab, or switch 'Bill to' back to the agency."
          : "This client has no email address on file - add one on the Clients screen."
      );
      return;
    }
    setOpeningEmail(true);
    setSendEmailError(null);
    try {
      const { data: rule } = await supabase
        .from("communication_rules")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "invoice_sent")
        .maybeSingle();
      if (!rule || !rule.is_enabled) {
        throw new Error("The 'Invoice Delivery' email is turned off in Settings > Automation & Messaging");
      }
      const { data: templates } = await supabase
        .from("communication_templates")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "invoice_sent")
        .eq("is_active", true);
      const template = (templates ?? []).find((t) => rule.channel === "both" || rule.channel === t.type);
      if (!template) throw new Error("No active 'Invoice Delivery' email template found");

      // Render tags against this specific client/invoice before showing the
      // composer - see QuoteDetail.tsx's identical fix for the full
      // reasoning. Same approval-link construction generateLink's own
      // mutation uses, so {invoice_payment_link} in the preview is a real,
      // clickable link too.
      const approvalPageUrl = import.meta.env.VITE_APPROVAL_PAGE_URL;
      let approvalLink: string | null = null;
      if (approvalPageUrl) {
        const { data: token } = await supabase.rpc("generate_invoice_approval_link", { p_invoice_id: id });
        if (token) approvalLink = `${approvalPageUrl}?type=invoice&token=${token}`;
      }
      const renderContext = {
        company: {
          name: tenant.name,
          phone: tenant.phone,
          email: tenant.email,
          bank_account_name: tenant.bank_account_name,
          bank_bsb: tenant.bank_bsb,
          bank_account_number: tenant.bank_account_number,
          google_review_link: tenant.google_review_link,
        },
        client: {
          name: data.invoice.clients?.name ?? "",
          phone: data.invoice.clients?.phone ?? null,
          email: data.invoice.clients?.email ?? null,
        },
        invoice: {
          invoice_number: data.invoice.invoice_number,
          total_cents: data.invoice.total_cents,
          due_date: data.invoice.due_date,
          payment_link: approvalLink,
        },
      };
      setEmailDefaults({
        subject: template.subject ? renderTemplate(template.subject, renderContext) : "",
        body: renderTemplate(template.body, renderContext),
      });
      // Best-effort, same as QuoteDetail.tsx - a PDF generation failure
      // falls back to no attachment rather than blocking the send.
      try {
        const agencyBilling =
          jobCard?.is_real_estate_job && agency
            ? {
                ownerLandlordName: property?.owner_landlord_name ?? null,
                agencyName: agency.name,
                billToLandlord: data.invoice.bill_to_landlord,
                ownerLandlordPhone: property?.owner_landlord_phone ?? null,
                ownerLandlordEmail: property?.owner_landlord_email ?? null,
              }
            : undefined;
        const pdfBlob = await buildInvoicePdfBytes({ tenant, invoice: data.invoice, client: data.invoice.clients, lineItems: data.items, agencyBilling, site: currentSite });
        const pdfDataUrl = await blobToDataUrl(pdfBlob);
        setEmailDefaultAttachments([{ filename: `Invoice ${data.invoice.invoice_number}.pdf`, content: pdfDataUrl }]);
      } catch {
        setEmailDefaultAttachments([]);
      }
      setEmailModalOpen(true);
    } catch (e) {
      setSendEmailError(getErrorMessage(e, "Failed to prepare email"));
    } finally {
      setOpeningEmail(false);
    }
  };

  const handleSendEmail = async (payload: { to: string; cc: string; bcc: string; subject: string; body: string; attachments: EmailAttachment[] }) => {
    if (!profile) throw new Error("Not signed in");
    const wasSent = await queueAndSendEmail({
      tenantId: profile.tenant_id,
      entityType: "invoice",
      entityId: id!,
      triggerKey: "invoice_sent",
      ...payload,
    });
    const { error } = await supabase.from("invoices").update({ status: "sent" }).eq("id", id);
    if (error) throw error;
    invalidate();
    setSendEmailError(null);
    setSendResult(wasSent ? "The invoice email has been sent." : "The invoice is marked sent and the email is queued.");
    setTimeout(() => setSendResult(null), 5000);
  };

  // Real-estate jobs: the landlord/tenant on file for the property are
  // always offered as recipient chips (even when "Bill to" below is still
  // pointed at the agency) so redirecting a one-off send to them doesn't
  // require flipping the persistent toggle first.
  const recipientOptions = collectRecipientEmails({
    clientEmail: data?.invoice.clients?.email,
    contactEmails: [...(clientContacts ?? []).map((c) => c.email), property?.owner_landlord_email ?? null, property?.tenant_email ?? null],
    freeText: jobNoteBodies ?? [],
  });

  // Who this invoice is actually billed to - the agency/PM `clients` row
  // the job was created against (the default, unchanged from before this
  // feature existed) or, once bill_to_landlord is set, the property's own
  // owner_landlord_email. Falls back to the client's email if the toggle
  // is on but no landlord email is on file, rather than silently going
  // nowhere.
  const invoiceRecipientEmail =
    data?.invoice.bill_to_landlord && property?.owner_landlord_email ? property.owner_landlord_email : (data?.invoice.clients?.email ?? "");

  const [realEstateModalOpen, setRealEstateModalOpen] = useState(false);
  const [workOrderModalOpen, setWorkOrderModalOpen] = useState(false);
  const [referralModalOpen, setReferralModalOpen] = useState(false);
  const [poModalOpen, setPoModalOpen] = useState(false);

  const [billToModalOpen, setBillToModalOpen] = useState(false);
  const [billToError, setBillToError] = useState<string | null>(null);
  const updateBillTo = useMutation({
    mutationFn: async (billToLandlord: boolean) => {
      const { error } = await supabase.from("invoices").update({ bill_to_landlord: billToLandlord }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      setBillToModalOpen(false);
    },
    onError: (e) => setBillToError(getErrorMessage(e, "Failed to update billing recipient")),
  });

  const [addressModalOpen, setAddressModalOpen] = useState(false);
  const [addressSiteChoice, setAddressSiteChoice] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);

  const updateSite = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("invoices").update({ site_id: addressSiteChoice || null }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      setAddressModalOpen(false);
    },
    onError: (e) => setAddressError(getErrorMessage(e, "Failed to update address")),
  });

  const currentSite = (clientSites ?? []).find((s) => s.id === data?.invoice.site_id) ?? null;

  // Stripe Checkout link - regenerated by the same "approve" Edge Function
  // that serves the public approval page, so the link stays valid against
  // whatever Stripe secret is configured server-side (see docs/SETUP.md).
  const [paymentLinkError, setPaymentLinkError] = useState<string | null>(null);
  const generatePaymentLink = useMutation({
    mutationFn: async () => {
      const approvalPageUrl = import.meta.env.VITE_APPROVAL_PAGE_URL;
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      if (!supabaseUrl) throw new Error("Supabase URL not configured");
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error("Not signed in");
      const res = await fetch(`${supabaseUrl}/functions/v1/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "invoice", action: "create_payment_link", invoice_id: id, approval_page_url: approvalPageUrl }),
      });
      const body = await res.json();
      if (!res.ok || body.error) {
        const message =
          body.error === "stripe_not_configured"
            ? "Stripe isn't set up yet - see docs/SETUP.md"
            : body.detail || body.error || "Failed to create payment link";
        throw new Error(message);
      }
      return body.checkout_url as string;
    },
    onSuccess: () => invalidate(),
    onError: (e) => setPaymentLinkError(getErrorMessage(e, "Failed to create payment link")),
  });

  // Xero sync (Phase 1, one-way push - see the xero-sync Edge Function's
  // own comment). Manual, one invoice at a time - not fired automatically
  // on status changes yet.
  const [xeroSyncError, setXeroSyncError] = useState<string | null>(null);
  const syncToXero = useMutation({
    mutationFn: async () => {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      if (!supabaseUrl) throw new Error("Supabase URL not configured");
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error("Not signed in");
      const res = await fetch(`${supabaseUrl}/functions/v1/xero-sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: id }),
      });
      const body = await res.json();
      if (!res.ok || body.error) {
        const message =
          body.error === "xero_not_configured"
            ? "Xero isn't set up yet - see docs/SETUP.md"
            : body.error === "xero_not_connected"
              ? "Connect Xero first in Settings"
              : body.error === "xero_reauth_required"
                ? "Xero connection expired - reconnect it in Settings"
                : body.error || "Failed to sync to Xero";
        throw new Error(message);
      }
      return body as { xero_invoice_id: string; xero_view_url: string };
    },
    onSuccess: () => {
      invalidate();
      setXeroSyncError(null);
    },
    onError: (e) => setXeroSyncError(getErrorMessage(e, "Failed to sync to Xero")),
  });

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleExportPdf = () => {
    if (!data || !tenant || !data.invoice.clients) return;
    if (agencyComplianceError) {
      setExportError(agencyComplianceError);
      return;
    }
    setExporting(true);
    setExportError(null);
    try {
      const agencyBilling =
        jobCard?.is_real_estate_job && agency
          ? {
              ownerLandlordName: property?.owner_landlord_name ?? null,
              agencyName: agency.name,
              billToLandlord: data.invoice.bill_to_landlord,
              ownerLandlordPhone: property?.owner_landlord_phone ?? null,
              ownerLandlordEmail: property?.owner_landlord_email ?? null,
            }
          : undefined;
      const html = buildInvoicePdfHtml({ tenant, invoice: data.invoice, client: data.invoice.clients, lineItems: data.items, agencyBilling, site: currentSite });
      exportPdf(html, `Invoice ${data.invoice.invoice_number}`);
    } catch (e) {
      setExportError(getErrorMessage(e, "Failed to export PDF"));
    } finally {
      setExporting(false);
    }
  };

  if (isLoading || !data) {
    return <div className="p-8 text-sm text-gray-500">Loading...</div>;
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <Link to="/invoices" className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to Invoices
      </Link>

      <h1 className="text-xl font-bold text-gray-900">{data.invoice.invoice_number}</h1>
      <p className="text-sm text-gray-500">{data.invoice.clients?.name ?? "Unknown client"}</p>
      {data.invoice.job_cards ? (
        <Link to={`/jobs/${data.invoice.job_card_id}`} className="text-sm text-blue-700 hover:underline">
          Job: {data.invoice.job_cards.title}
        </Link>
      ) : null}
      <p className="mt-1 text-sm text-gray-600">
        {currentSite ? `${currentSite.label ? `${currentSite.label}: ` : ""}${formatSiteAddress(currentSite)}` : "Client's main address"}{" "}
        <button
          onClick={() => {
            setAddressSiteChoice(data.invoice.site_id ?? "");
            setAddressError(null);
            setAddressModalOpen(true);
          }}
          className="text-xs font-semibold text-blue-700 hover:underline"
        >
          Edit address
        </button>
      </p>

      {jobCard ? (
        jobCard.is_real_estate_job ? (
          <p className="mt-1 text-sm text-gray-600">
            Real estate / strata job{agency ? ` - ${agency.name}` : ""}{" "}
            <button onClick={() => setRealEstateModalOpen(true)} className="text-xs font-semibold text-blue-700 hover:underline">
              Edit
            </button>
          </p>
        ) : (
          <button
            onClick={() => setRealEstateModalOpen(true)}
            className="mt-1 text-xs font-semibold text-blue-700 hover:underline"
          >
            Mark as real estate / strata job
          </button>
        )
      ) : null}

      {jobCard?.is_real_estate_job && agency ? (
        <p className="mt-1 text-sm text-gray-600">
          Billed to: {data.invoice.bill_to_landlord ? (property?.owner_landlord_name ?? "Landlord (name not on file)") : `${agency.name}${data.invoice.clients ? ` (${data.invoice.clients.name})` : ""}`}{" "}
          <button
            onClick={() => {
              setBillToError(null);
              setBillToModalOpen(true);
            }}
            className="text-xs font-semibold text-blue-700 hover:underline"
          >
            Change
          </button>
        </p>
      ) : null}

      {jobCard?.is_real_estate_job ? (
        <p className="mt-1 text-sm text-gray-600">
          Work order #: {jobCard.work_order_number ?? "Not set"}{" "}
          <button onClick={() => setWorkOrderModalOpen(true)} className="text-xs font-semibold text-blue-700 hover:underline">
            {jobCard.work_order_number ? "Edit" : "+ Add"}
          </button>
        </p>
      ) : null}

      {jobCard ? (
        <p className="mt-1 text-sm text-gray-600">
          Referral source: {referralPartner ? referralPartnerLabel(referralPartner) : "None"}{" "}
          <button onClick={() => setReferralModalOpen(true)} className="text-xs font-semibold text-blue-700 hover:underline">
            {jobCard.referral_partner_id ? "Edit" : "+ Add"}
          </button>
        </p>
      ) : null}

      <p className="mt-1 text-sm text-gray-600">
        PO number: {data.invoice.po_number ?? "Not set"}{" "}
        <button onClick={() => setPoModalOpen(true)} className="text-xs font-semibold text-blue-700 hover:underline">
          {data.invoice.po_number ? "Edit" : "+ Add"}
        </button>
      </p>

      {agencyComplianceError ? (
        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
          {agencyComplianceError}{" "}
          <button onClick={() => setWorkOrderModalOpen(true)} className="font-bold underline">
            Add it now
          </button>
        </p>
      ) : null}

      {data.invoice.approval_status ? (
        <div
          className={`mt-2 inline-block rounded-full px-3 py-1 text-xs font-bold ${
            data.invoice.approval_status === "accepted"
              ? "bg-green-100 text-green-700"
              : data.invoice.approval_status === "declined"
                ? "bg-red-100 text-red-700"
                : "bg-yellow-100 text-yellow-800"
          }`}
        >
          {APPROVAL_STATUS_LABELS[data.invoice.approval_status]}
        </div>
      ) : null}
      {data.invoice.approval_status === "declined" && data.invoice.decline_reason ? (
        <p className="mt-2 text-sm text-red-700">Reason: {data.invoice.decline_reason}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          onClick={() => openSendEmail()}
          disabled={openingEmail}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {openingEmail ? "Preparing..." : "Send Invoice via Email"}
        </button>
        <button
          onClick={() => generateLink.mutate()}
          disabled={generateLink.isPending}
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          {generateLink.isPending
            ? "Generating..."
            : linkCopied
              ? "Link copied!"
              : data.invoice.access_token
                ? "Copy approval link"
                : "Generate approval link"}
        </button>
        <button
          onClick={handleExportPdf}
          disabled={exporting || !tenant}
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          {exporting ? "Preparing PDF..." : "Export PDF"}
        </button>
      </div>
      {exportError ? <p className="mt-2 text-sm text-red-600">{exportError}</p> : null}
      {sendEmailError ? <p className="mt-2 text-sm text-red-600">{sendEmailError}</p> : null}
      {sendResult ? <p className="mt-2 text-sm text-green-700">{sendResult}</p> : null}
      {linkError ? <p className="mt-2 text-sm text-red-600">{linkError}</p> : null}

      {data.invoice.approval_status === "accepted" && data.invoice.status !== "paid" ? (
        <div className="mt-3 rounded-md border border-green-200 bg-green-50 p-3">
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-green-800">Stripe payment link</p>
          <p className="mb-2 text-xs text-gray-600">
            Once accepted, the invoice's own link (the one already emailed to the client) takes them straight here instead of back to the
            acceptance page.
          </p>
          {data.invoice.stripe_checkout_url ? (
            <div className="flex items-center gap-2">
              <a href={data.invoice.stripe_checkout_url} target="_blank" rel="noreferrer" className="text-sm font-semibold text-blue-700 hover:underline">
                Open payment page &rarr;
              </a>
              <button
                onClick={() => navigator.clipboard.writeText(data.invoice.stripe_checkout_url!)}
                className="text-xs font-semibold text-gray-600 hover:underline"
              >
                Copy link
              </button>
            </div>
          ) : (
            <button
              onClick={() => generatePaymentLink.mutate()}
              disabled={generatePaymentLink.isPending}
              className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-800 disabled:opacity-60"
            >
              {generatePaymentLink.isPending ? "Creating..." : "Create Stripe payment link"}
            </button>
          )}
          {paymentLinkError ? <p className="mt-2 text-sm text-red-600">{paymentLinkError}</p> : null}
        </div>
      ) : null}

      {data.invoice.status !== "draft" ? (
        <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 p-3">
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-blue-800">Xero</p>
          {data.invoice.xero_synced_at ? (
            <p className="mb-2 text-xs text-gray-600">
              Last synced {new Date(data.invoice.xero_synced_at).toLocaleString("en-AU")}
              {data.invoice.xero_invoice_id ? (
                <>
                  {" - "}
                  <a
                    href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${data.invoice.xero_invoice_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-blue-700 hover:underline"
                  >
                    View in Xero &rarr;
                  </a>
                </>
              ) : null}
            </p>
          ) : (
            <p className="mb-2 text-xs text-gray-600">Not synced to Xero yet.</p>
          )}
          <button
            onClick={() => syncToXero.mutate()}
            disabled={syncToXero.isPending}
            className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {syncToXero.isPending ? "Syncing..." : data.invoice.xero_synced_at ? "Re-sync to Xero" : "Sync to Xero"}
          </button>
          {(xeroSyncError || data.invoice.xero_sync_error) ? (
            <p className="mt-2 text-sm text-red-600">{xeroSyncError || data.invoice.xero_sync_error}</p>
          ) : null}
        </div>
      ) : null}

      <h2 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-gray-500">Status</h2>
      <div className="flex flex-wrap gap-2">
        {STATUSES.map((status) => (
          <button
            key={status}
            onClick={() => changeStatus.mutate(status)}
            className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
              data.invoice.status === status ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"
            }`}
          >
            {STATUS_LABELS[status]}
          </button>
        ))}
      </div>

      <div className="mt-4">
        <label className="mb-1 block text-sm font-semibold text-gray-700">Due date</label>
        <input
          type="date"
          value={dueDate}
          disabled={isLocked}
          onChange={(e) => setDueDate(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
        />
      </div>

      <h2 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-gray-500">Line items</h2>
      {isLocked ? (
        <p className="mb-2 text-sm text-gray-500">
          This invoice has been {data.invoice.approval_status} by the client and its line items are now read-only.
        </p>
      ) : null}
      {!isLocked ? <LineItemEditor items={lineItems} onChange={setLineItems} /> : <LineItemSummary items={lineItems} />}

      <div className="mt-4">
        <label className="mb-1 block text-sm font-semibold text-gray-700">Notes</label>
        <textarea
          rows={3}
          disabled={isLocked}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
        />
      </div>

      {saveError ? <p className="mt-2 text-sm text-red-600">{saveError}</p> : null}
      {saved ? <p className="mt-2 text-sm text-green-700">Saved.</p> : null}

      {!isLocked ? (
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="mt-4 rounded-md bg-blue-700 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {save.isPending ? "Saving..." : "Save changes"}
        </button>
      ) : null}

      <Modal open={addressModalOpen} onClose={() => setAddressModalOpen(false)} title="Edit invoice address">
        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold text-gray-700">Address</label>
          <select
            value={addressSiteChoice}
            onChange={(e) => setAddressSiteChoice(e.target.value)}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">Client's main address</option>
            {(clientSites ?? []).map((site) => (
              <option key={site.id} value={site.id}>
                {site.label || "Site"} - {formatSiteAddress(site)}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-400">
            To add a brand new address, add it on the client's card first (Clients &rarr; this client &rarr; Addresses).
          </p>
        </div>
        {addressError ? <p className="mb-4 text-sm text-red-600">{addressError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setAddressModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => updateSite.mutate()}
            disabled={updateSite.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {updateSite.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      {jobCard?.is_real_estate_job && agency ? (
        <Modal open={billToModalOpen} onClose={() => setBillToModalOpen(false)} title="Who is this invoice billed to?">
          <div className="mb-4 space-y-2">
            <button
              onClick={() => updateBillTo.mutate(false)}
              disabled={updateBillTo.isPending}
              className={`w-full rounded-md border p-3 text-left text-sm ${
                !data.invoice.bill_to_landlord ? "border-blue-500 bg-blue-50" : "border-gray-300 hover:bg-gray-50"
              }`}
            >
              <p className="font-semibold text-gray-900">Agency / Property Manager</p>
              <p className="text-gray-600">
                {agency.name}
                {data.invoice.clients ? ` - ${data.invoice.clients.name}` : ""}
              </p>
            </button>
            <button
              onClick={() => updateBillTo.mutate(true)}
              disabled={updateBillTo.isPending}
              className={`w-full rounded-md border p-3 text-left text-sm ${
                data.invoice.bill_to_landlord ? "border-blue-500 bg-blue-50" : "border-gray-300 hover:bg-gray-50"
              }`}
            >
              <p className="font-semibold text-gray-900">Landlord / Owner</p>
              {property?.owner_landlord_name || property?.owner_landlord_email ? (
                <p className="text-gray-600">
                  {property.owner_landlord_name}
                  {property.owner_landlord_email ? ` - ${property.owner_landlord_email}` : ""}
                </p>
              ) : (
                <p className="text-gray-500">
                  No landlord contact on file yet - add one on the property's Access &amp; Contacts tab first.
                </p>
              )}
            </button>
          </div>
          {billToError ? <p className="mb-4 text-sm text-red-600">{billToError}</p> : null}
          <div className="flex justify-end">
            <button onClick={() => setBillToModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
              Close
            </button>
          </div>
        </Modal>
      ) : null}

      {jobCard ? (
        <RealEstateAssignmentModal
          open={realEstateModalOpen}
          onClose={() => setRealEstateModalOpen(false)}
          jobCardId={jobCard.id}
          initial={{
            is_real_estate_job: jobCard.is_real_estate_job,
            agency_id: jobCard.agency_id,
            property_manager_id: jobCard.property_manager_id,
            property_id: jobCard.property_id,
            work_order_number: jobCard.work_order_number,
            nte_limit_cents: jobCard.nte_limit_cents,
          }}
          invalidateKeys={[["invoice", id]]}
        />
      ) : null}

      {jobCard ? (
        <WorkOrderNumberModal
          open={workOrderModalOpen}
          onClose={() => setWorkOrderModalOpen(false)}
          jobCardId={jobCard.id}
          currentValue={jobCard.work_order_number}
          invalidateKeys={[["invoice", id]]}
        />
      ) : null}

      {jobCard ? (
        <ReferralPartnerModal
          open={referralModalOpen}
          onClose={() => setReferralModalOpen(false)}
          table="job_cards"
          recordId={jobCard.id}
          currentValue={jobCard.referral_partner_id}
          invalidateKeys={[["invoice", id]]}
        />
      ) : null}

      <PurchaseOrderNumberModal
        open={poModalOpen}
        onClose={() => setPoModalOpen(false)}
        table="invoices"
        recordId={id!}
        currentValue={data.invoice.po_number}
      />

      <EmailComposeModal
        open={emailModalOpen}
        onClose={() => setEmailModalOpen(false)}
        title="Send invoice"
        defaultTo={invoiceRecipientEmail}
        defaultSubject={emailDefaults.subject}
        defaultBody={emailDefaults.body}
        defaultAttachments={emailDefaultAttachments}
        recipientOptions={recipientOptions}
        onSend={handleSendEmail}
        sendLabel="Send invoice"
      />
    </div>
  );
}

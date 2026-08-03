import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  type Agency,
  type ApprovalStatus,
  type Client,
  type Invoice,
  type InvoiceStatus,
  type LineItemFormInput,
  type Property,
  type Tenant,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { triggerImmediateDispatch } from "../lib/dispatch-now";
import { buildInvoicePdfHtml } from "../lib/quote-invoice-pdf";
import { exportPdf } from "../lib/print";
import { LineItemEditor, LineItemSummary } from "../components/LineItemEditor";

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
  title: string;
  is_real_estate_job: boolean;
  agency_id: string | null;
  property_id: string | null;
  work_order_number: string | null;
};
type InvoiceRow = Invoice & { clients: Client | null; job_cards: InvoiceJobCard | null };

async function fetchInvoice(id: string): Promise<{ invoice: InvoiceRow; items: LineItemFormInput[] }> {
  const [{ data: invoice, error: invoiceError }, { data: items, error: itemsError }] = await Promise.all([
    supabase
      .from("invoices")
      .select("*, clients(*), job_cards!invoices_job_card_id_fkey(title, is_real_estate_job, agency_id, property_id, work_order_number)")
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

  // Mirrors apps/mobile's handleSendInvoiceEmail exactly, using the
  // invoice_sent trigger_key instead of quote_sent.
  const sendEmail = useMutation({
    mutationFn: async () => {
      if (!data || !profile) throw new Error("Not signed in");
      if (agencyComplianceError) throw new Error(agencyComplianceError);
      const email = data.invoice.clients?.email;
      if (!email) throw new Error("This client has no email address on file - add one on the Clients screen.");

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

      const { data: row, error: insertError } = await supabase
        .from("scheduled_communications")
        .insert({
          tenant_id: profile.tenant_id,
          entity_type: "invoice",
          entity_id: id,
          trigger_key: "invoice_sent",
          template_id: template.id,
          channel: template.type,
          recipient_phone_or_email: email,
          rendered_subject: template.subject,
          rendered_body: template.body,
          scheduled_for: new Date().toISOString(),
          status: "pending",
        })
        .select("id")
        .single();
      if (insertError) throw insertError;

      const wasSent = await triggerImmediateDispatch(row.id);

      const { error: statusError } = await supabase.from("invoices").update({ status: "sent" }).eq("id", id);
      if (statusError) throw statusError;

      return wasSent;
    },
    onSuccess: (wasSent) => {
      invalidate();
      setSendEmailError(null);
      setSendResult(wasSent ? "The invoice email has been sent." : "The invoice is marked sent and the email is queued.");
      setTimeout(() => setSendResult(null), 5000);
    },
    onError: (e) => setSendEmailError(getErrorMessage(e, "Failed to send")),
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
      const agencyBilling = jobCard?.is_real_estate_job && agency ? { ownerLandlordName: property?.owner_landlord_name ?? null, agencyName: agency.name } : undefined;
      const html = buildInvoicePdfHtml({ tenant, invoice: data.invoice, client: data.invoice.clients, lineItems: data.items, agencyBilling });
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

      {agencyComplianceError ? (
        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{agencyComplianceError}</p>
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
          onClick={() => sendEmail.mutate()}
          disabled={sendEmail.isPending}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {sendEmail.isPending ? "Sending..." : "Send Invoice via Email"}
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
    </div>
  );
}

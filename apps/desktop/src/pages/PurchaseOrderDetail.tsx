import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  formatCentsAsAud,
  type Client,
  type JobCard,
  type PoLineItemInput,
  type PurchaseOrder,
  type PurchaseOrderStatus,
  type SubcontractorCompany,
  type SubcontractorContact,
  type Tenant,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { triggerImmediateDispatch } from "../lib/dispatch-now";
import { buildPurchaseOrderPdfBlob } from "../lib/po-pdf";
import { PoLineItemEditor } from "../components/subcontractors/PoLineItemEditor";

const BUCKET = "subcontractor-files";

const STATUSES: PurchaseOrderStatus[] = ["draft", "sent", "quoted", "accepted", "completed", "paid", "cancelled"];
const STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  quoted: "Quoted",
  accepted: "Accepted",
  completed: "Completed",
  paid: "Paid",
  cancelled: "Cancelled",
};

async function fetchPo(id: string): Promise<PurchaseOrder> {
  const { data, error } = await supabase.from("purchase_orders").select("*").eq("id", id).single();
  if (error) throw error;
  return data as PurchaseOrder;
}
async function fetchTenant(tenantId: string): Promise<Tenant> {
  const { data, error } = await supabase.from("tenants").select("*").eq("id", tenantId).single();
  if (error) throw error;
  return data as Tenant;
}
async function fetchSubcontractor(id: string): Promise<SubcontractorCompany> {
  const { data, error } = await supabase.from("subcontractor_companies").select("*").eq("id", id).single();
  if (error) throw error;
  return data as SubcontractorCompany;
}
async function fetchContacts(id: string): Promise<SubcontractorContact[]> {
  const { data, error } = await supabase.from("subcontractor_contacts").select("*").eq("subcontractor_id", id).order("first_name");
  if (error) throw error;
  return data as SubcontractorContact[];
}
async function fetchJob(id: string): Promise<JobCard & { clients: Client | null }> {
  const { data, error } = await supabase.from("job_cards").select("*, clients(*)").eq("id", id).single();
  if (error) throw error;
  return data as JobCard & { clients: Client | null };
}

export default function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: po } = useQuery({ queryKey: ["purchase-order", id], queryFn: () => fetchPo(id!), enabled: !!id });
  const { data: tenant } = useQuery({
    queryKey: ["tenant", profile?.tenant_id],
    queryFn: () => fetchTenant(profile!.tenant_id),
    enabled: !!profile,
  });
  const { data: subcontractor } = useQuery({
    queryKey: ["subcontractor", po?.subcontractor_id],
    queryFn: () => fetchSubcontractor(po!.subcontractor_id),
    enabled: !!po,
  });
  const { data: contacts } = useQuery({
    queryKey: ["subcontractor-contacts", po?.subcontractor_id],
    queryFn: () => fetchContacts(po!.subcontractor_id),
    enabled: !!po,
  });
  const { data: job } = useQuery({ queryKey: ["job", po?.job_card_id], queryFn: () => fetchJob(po!.job_card_id), enabled: !!po });

  const [lineItems, setLineItems] = useState<PoLineItemInput[]>([]);
  const [billedCents, setBilledCents] = useState("");
  const [contactId, setContactId] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<string | null>(null);

  useEffect(() => {
    if (po) {
      setLineItems(po.line_items);
      setBilledCents(po.billed_to_client_cents != null ? String(po.billed_to_client_cents / 100) : "");
      setContactId(po.contact_id ?? "");
    }
  }, [po]);

  const isLocked = po?.status === "cancelled";
  const complianceHold = subcontractor?.status === "compliance_hold";
  const recipientContact = contacts?.find((c) => c.id === contactId) ?? contacts?.find((c) => c.is_primary_contact) ?? contacts?.[0];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["purchase-order", id] });
    queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
    queryClient.invalidateQueries({ queryKey: ["subcontractor-pos", po?.subcontractor_id] });
  };

  const save = useMutation({
    mutationFn: async () => {
      const totalCents = lineItems.reduce((sum, item) => sum + Math.round(item.quantity * item.unit_cost_cents), 0);
      const { error } = await supabase
        .from("purchase_orders")
        .update({
          line_items: lineItems,
          total_cost_cents: totalCents,
          billed_to_client_cents: billedCents ? Math.round(parseFloat(billedCents) * 100) : null,
          contact_id: contactId || null,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      setSaveError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save")),
  });

  const changeStatus = useMutation({
    mutationFn: async (status: PurchaseOrderStatus) => {
      const patch: Record<string, unknown> = { status };
      if (status === "paid") patch.paid_at = new Date().toISOString();
      const { error } = await supabase.from("purchase_orders").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  // Generates the quote-submission token (idempotent), then queues +
  // dispatches the subcontractor_quote_request email - same manual-send
  // shape as QuoteDetail's sendEmail (quote_sent), just entity_type
  // 'purchase_order' and a subcontractor contact as the recipient instead
  // of a client.
  const sendQuoteRequest = useMutation({
    mutationFn: async () => {
      if (!po || !profile) throw new Error("Not signed in");
      if (complianceHold) throw new Error("This subcontractor is on compliance hold.");
      if (!recipientContact?.email) throw new Error("This subcontractor has no contact with an email address - add one first.");

      const { error: linkError } = await supabase.rpc("generate_po_quote_link", { p_po_id: id });
      if (linkError) throw linkError;

      const { data: rule } = await supabase
        .from("communication_rules")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "subcontractor_quote_request")
        .maybeSingle();
      if (!rule || !rule.is_enabled) {
        throw new Error("The 'Subcontractor Quote Request' email is turned off in Settings > Automation & Messaging");
      }
      const { data: templates } = await supabase
        .from("communication_templates")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "subcontractor_quote_request")
        .eq("is_active", true);
      const template = (templates ?? []).find((t) => rule.channel === "both" || rule.channel === t.type);
      if (!template) throw new Error("No active 'Subcontractor Quote Request' email template found");

      const { data: row, error: insertError } = await supabase
        .from("scheduled_communications")
        .insert({
          tenant_id: profile.tenant_id,
          entity_type: "purchase_order",
          entity_id: id,
          trigger_key: "subcontractor_quote_request",
          template_id: template.id,
          channel: template.type,
          recipient_phone_or_email: recipientContact.email,
          rendered_subject: template.subject,
          rendered_body: template.body,
          scheduled_for: new Date().toISOString(),
          status: "pending",
        })
        .select("id")
        .single();
      if (insertError) throw insertError;

      const wasSent = await triggerImmediateDispatch(row.id);

      const { error: statusError } = await supabase.from("purchase_orders").update({ status: "sent", contact_id: recipientContact.id }).eq("id", id);
      if (statusError) throw statusError;

      return wasSent;
    },
    onSuccess: (wasSent) => {
      invalidate();
      setSendError(null);
      setSendResult(wasSent ? "Quote request email sent." : "Quote request is marked sent and the email is queued.");
      setTimeout(() => setSendResult(null), 5000);
    },
    onError: (e) => setSendError(getErrorMessage(e, "Failed to send")),
  });

  // Compiles the PO to PDF (same jsPDF-to-Blob pattern reports uses for
  // Send via Email - see po-pdf.ts's own comment), uploads it, then queues
  // + dispatches the subcontractor_work_order email with that PDF's signed
  // link.
  const sendWorkOrder = useMutation({
    mutationFn: async () => {
      if (!po || !profile || !tenant || !subcontractor || !job) throw new Error("Still loading - try again in a moment");
      if (complianceHold) throw new Error("This subcontractor is on compliance hold.");
      if (!recipientContact?.email) throw new Error("This subcontractor has no contact with an email address - add one first.");

      const blob = buildPurchaseOrderPdfBlob({
        tenant,
        po,
        subcontractor,
        jobTitle: job.title,
        siteAddress: job.clients ? [job.clients.address_line1, job.clients.suburb].filter(Boolean).join(", ") || null : null,
        lineItems,
      });
      const storagePath = `${profile.tenant_id}/${id}/${po.po_number ?? id}.pdf`;
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, blob, { contentType: "application/pdf", upsert: true });
      if (uploadError) throw uploadError;

      const { error: pathError } = await supabase.from("purchase_orders").update({ pdf_storage_path: storagePath }).eq("id", id);
      if (pathError) throw pathError;

      const { data: rule } = await supabase
        .from("communication_rules")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "subcontractor_work_order")
        .maybeSingle();
      if (!rule || !rule.is_enabled) {
        throw new Error("The 'Subcontractor Work Order' email is turned off in Settings > Automation & Messaging");
      }
      const { data: templates } = await supabase
        .from("communication_templates")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "subcontractor_work_order")
        .eq("is_active", true);
      const template = (templates ?? []).find((t) => rule.channel === "both" || rule.channel === t.type);
      if (!template) throw new Error("No active 'Subcontractor Work Order' email template found");

      const { data: row, error: insertError } = await supabase
        .from("scheduled_communications")
        .insert({
          tenant_id: profile.tenant_id,
          entity_type: "purchase_order",
          entity_id: id,
          trigger_key: "subcontractor_work_order",
          template_id: template.id,
          channel: template.type,
          recipient_phone_or_email: recipientContact.email,
          rendered_subject: template.subject,
          rendered_body: template.body,
          scheduled_for: new Date().toISOString(),
          status: "pending",
        })
        .select("id")
        .single();
      if (insertError) throw insertError;

      const wasSent = await triggerImmediateDispatch(row.id);

      const { error: statusError } = await supabase
        .from("purchase_orders")
        .update({ status: "sent", issued_at: new Date().toISOString(), contact_id: recipientContact.id })
        .eq("id", id);
      if (statusError) throw statusError;

      return wasSent;
    },
    onSuccess: (wasSent) => {
      invalidate();
      setSendError(null);
      setSendResult(wasSent ? "Work order PDF compiled and emailed." : "Work order PDF compiled; email is queued.");
      setTimeout(() => setSendResult(null), 5000);
    },
    onError: (e) => setSendError(getErrorMessage(e, "Failed to send")),
  });

  const [downloading, setDownloading] = useState(false);
  const handleDownloadPdf = () => {
    if (!po || !tenant || !subcontractor || !job) return;
    setDownloading(true);
    try {
      const blob = buildPurchaseOrderPdfBlob({
        tenant,
        po,
        subcontractor,
        jobTitle: job.title,
        siteAddress: job.clients ? [job.clients.address_line1, job.clients.suburb].filter(Boolean).join(", ") || null : null,
        lineItems,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${po.po_number ?? "purchase-order"}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  if (!po) return <div className="p-8 text-sm text-gray-500">Loading...</div>;

  const marginCents = billedCents ? Math.round(parseFloat(billedCents) * 100) - po.total_cost_cents : null;

  return (
    <div className="mx-auto max-w-3xl p-8">
      <Link to={`/subcontractors/${po.subcontractor_id}`} className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to {subcontractor?.company_name ?? "subcontractor"}
      </Link>

      <div className="mb-1 flex items-center gap-2">
        <h1 className="text-xl font-bold text-gray-900">{po.po_number ?? "Pending PO number"}</h1>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
          {po.is_quote_request ? "Quote Request" : "Work Order"}
        </span>
      </div>
      {job ? (
        <Link to={`/jobs/${po.job_card_id}`} className="text-sm text-blue-700 hover:underline">
          Job: {job.title}
        </Link>
      ) : null}

      {complianceHold ? (
        <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800">This subcontractor is on compliance hold - sending is disabled.</p>
      ) : null}

      <h2 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-gray-500">Status</h2>
      <div className="flex flex-wrap gap-2">
        {STATUSES.map((status) => (
          <button
            key={status}
            onClick={() => changeStatus.mutate(status)}
            className={`rounded-full px-3 py-1.5 text-sm font-semibold ${po.status === status ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"}`}
          >
            {STATUS_LABELS[status]}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        {po.is_quote_request ? (
          <button
            onClick={() => sendQuoteRequest.mutate()}
            disabled={sendQuoteRequest.isPending || complianceHold}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {sendQuoteRequest.isPending ? "Sending..." : "Send Quote Request"}
          </button>
        ) : (
          <button
            onClick={() => sendWorkOrder.mutate()}
            disabled={sendWorkOrder.isPending || complianceHold}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {sendWorkOrder.isPending ? "Sending..." : "Send Work Order"}
          </button>
        )}
        <button
          onClick={handleDownloadPdf}
          disabled={downloading}
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          {downloading ? "Preparing..." : "Download PDF"}
        </button>
      </div>
      {sendError ? <p className="mt-2 text-sm text-red-600">{sendError}</p> : null}
      {sendResult ? <p className="mt-2 text-sm text-green-700">{sendResult}</p> : null}

      <div className="mt-4">
        <label className="mb-1 block text-sm font-semibold text-gray-700">Contact</label>
        <select
          value={contactId}
          disabled={isLocked}
          onChange={(e) => setContactId(e.target.value)}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm disabled:bg-gray-100"
        >
          <option value="">Use primary contact</option>
          {(contacts ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.first_name} {c.last_name ?? ""} {c.is_primary_contact ? "(Primary)" : ""} - {c.email}
            </option>
          ))}
        </select>
      </div>

      <h2 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-gray-500">
        {po.is_quote_request ? "Scope of work" : "Line items"}
      </h2>
      <PoLineItemEditor items={lineItems} onChange={setLineItems} readOnly={isLocked} />

      <div className="mt-4">
        <label className="mb-1 block text-sm font-semibold text-gray-700">Client billed price (optional)</label>
        <input
          type="text"
          inputMode="decimal"
          disabled={isLocked}
          value={billedCents}
          onChange={(e) => setBilledCents(e.target.value)}
          placeholder="What the client is charged for this work"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
        />
        {marginCents != null ? (
          <p className={`mt-2 text-sm font-semibold ${marginCents < 0 ? "text-red-600" : "text-green-700"}`}>
            Margin: {formatCentsAsAud(marginCents)}
          </p>
        ) : null}
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

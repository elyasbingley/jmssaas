import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  calculateDocumentTotals,
  collectRecipientEmails,
  formatCentsAsAud,
  type ApprovalStatus,
  type Client,
  type ClientContact,
  type ClientSite,
  type EmailAttachment,
  type LineItemFormInput,
  type Quote,
  type QuoteStatus,
  type Tenant,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { queueAndSendEmail } from "../lib/send-email";
import { buildQuotePdfHtml } from "../lib/quote-invoice-pdf";
import { blobToDataUrl, buildQuotePdfBytes } from "../lib/quote-invoice-pdf-bytes";
import { exportPdf } from "../lib/print";
import { LineItemEditor, LineItemSummary } from "../components/LineItemEditor";
import { Modal } from "../components/Modal";
import { EmailComposeModal } from "../components/EmailComposeModal";

function formatSiteAddress(site: Pick<ClientSite, "address_line1" | "address_line2" | "suburb" | "state" | "postcode">): string {
  return [site.address_line1, site.address_line2, [site.suburb, site.state, site.postcode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
}

const STATUSES: QuoteStatus[] = ["draft", "sent", "accepted", "declined", "expired"];
const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};
const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  sent: "Link sent - awaiting response",
  viewed: "Viewed by client - awaiting response",
  accepted: "Accepted by client",
  declined: "Declined by client",
};

type QuoteRow = Quote & { clients: Client | null; job_cards: { title: string } | null };

async function fetchQuote(id: string): Promise<{ quote: QuoteRow; items: LineItemFormInput[] }> {
  const [{ data: quote, error: quoteError }, { data: items, error: itemsError }] = await Promise.all([
    supabase.from("quotes").select("*, clients(*), job_cards!quotes_job_card_id_fkey(title)").eq("id", id).single(),
    supabase.from("quote_line_items").select("*").eq("quote_id", id).order("sort_order"),
  ]);
  if (quoteError) throw quoteError;
  if (itemsError) throw itemsError;
  return { quote: quote as QuoteRow, items: (items ?? []) as LineItemFormInput[] };
}

async function fetchTenant(tenantId: string): Promise<Tenant> {
  const { data, error } = await supabase.from("tenants").select("*").eq("id", tenantId).single();
  if (error) throw error;
  return data as Tenant;
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

export default function QuoteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ["quote", id], queryFn: () => fetchQuote(id!), enabled: !!id });
  const { data: tenant } = useQuery({
    queryKey: ["tenant", profile?.tenant_id],
    queryFn: () => fetchTenant(profile!.tenant_id),
    enabled: !!profile,
  });
  const { data: clientSites } = useQuery({
    queryKey: ["client-sites", data?.quote.client_id],
    queryFn: () => fetchClientSites(data!.quote.client_id),
    enabled: !!data,
  });
  const { data: clientContacts } = useQuery({
    queryKey: ["client-contacts", data?.quote.client_id],
    queryFn: () => fetchClientContacts(data!.quote.client_id),
    enabled: !!data,
  });
  const { data: jobNoteBodies } = useQuery({
    queryKey: ["job-notes-text", data?.quote.job_card_id],
    queryFn: () => fetchJobNoteBodies(data!.quote.job_card_id!),
    enabled: !!data?.quote.job_card_id,
  });

  const [lineItems, setLineItems] = useState<LineItemFormInput[]>([]);
  const [notes, setNotes] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [sendEmailError, setSendEmailError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [dueDate, setDueDate] = useState("");
  const [convertError, setConvertError] = useState<string | null>(null);

  const isLocked = data?.quote.approval_status === "accepted" || data?.quote.approval_status === "declined";

  useEffect(() => {
    if (data) {
      setLineItems(data.items);
      setNotes(data.quote.notes ?? "");
      setExpiryDate(data.quote.expiry_date ?? "");
    }
  }, [data]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["quote", id] });
    queryClient.invalidateQueries({ queryKey: ["quotes"] });
  };

  const changeStatus = useMutation({
    mutationFn: async (status: QuoteStatus) => {
      const { error } = await supabase.from("quotes").update({ status }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  // Same atomic RPC apps/mobile uses (replace_quote_line_items) - deletes +
  // reinserts the set and recomputes subtotal/gst/total in one transaction.
  const save = useMutation({
    mutationFn: async () => {
      const { error: updateError } = await supabase
        .from("quotes")
        .update({ notes: notes || null, expiry_date: expiryDate || null })
        .eq("id", id);
      if (updateError) throw updateError;

      const { error: rpcError } = await supabase.rpc("replace_quote_line_items", { p_quote_id: id, p_items: lineItems });
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

  const convert = useMutation({
    mutationFn: async () => {
      // Persist any pending edits first (see save's own comment) - the
      // convert_quote_to_invoice RPC reads quote_line_items as persisted.
      const { error: updateError } = await supabase
        .from("quotes")
        .update({ notes: notes || null, expiry_date: expiryDate || null })
        .eq("id", id);
      if (updateError) throw updateError;
      const { error: rpcError } = await supabase.rpc("replace_quote_line_items", { p_quote_id: id, p_items: lineItems });
      if (rpcError) throw rpcError;

      const { data: invoiceId, error } = await supabase.rpc("convert_quote_to_invoice", {
        p_quote_id: id,
        p_due_date: dueDate || null,
      });
      if (error) throw error;
      return invoiceId as string;
    },
    onSuccess: (invoiceId) => {
      setConvertOpen(false);
      navigate(`/invoices/${invoiceId}`);
    },
    onError: (e) => setConvertError(getErrorMessage(e, "Failed to convert to invoice")),
  });

  // Generates the token if one doesn't exist yet (idempotent), copies the
  // link to the clipboard - desktop's equivalent of mobile's native Share
  // sheet handoff. handleSendEmail below is the real "send it" action.
  const generateLink = useMutation({
    mutationFn: async () => {
      const approvalPageUrl = import.meta.env.VITE_APPROVAL_PAGE_URL;
      if (!approvalPageUrl) {
        throw new Error("Approval page URL not configured - set VITE_APPROVAL_PAGE_URL in .env (see docs/SETUP.md)");
      }
      const { data: token, error } = await supabase.rpc("generate_quote_approval_link", { p_quote_id: id });
      if (error) throw error;
      const url = `${approvalPageUrl}?type=quote&token=${token}`;
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

  // "Send Quote via Email" now pops the editable EmailComposeModal instead
  // of firing the template straight off - openSendEmail below still looks
  // up the tenant's quote_sent rule/template exactly as before, just to
  // prefill the modal rather than to send immediately. The actual send
  // (handleSendEmail) queues+dispatches via queueAndSendEmail and sets
  // status to 'sent' in the same action (that transition is what starts
  // the reminder ladder), same as the old direct-send mutation did.
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailDefaults, setEmailDefaults] = useState({ subject: "", body: "" });
  const [emailDefaultAttachments, setEmailDefaultAttachments] = useState<EmailAttachment[]>([]);
  const [openingEmail, setOpeningEmail] = useState(false);

  const openSendEmail = async () => {
    if (!data || !profile || !tenant) return;
    if (!data.quote.clients?.email) {
      setSendEmailError("This client has no email address on file - add one on the Clients screen.");
      return;
    }
    setOpeningEmail(true);
    setSendEmailError(null);
    try {
      const { data: rule } = await supabase
        .from("communication_rules")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "quote_sent")
        .maybeSingle();
      if (!rule || !rule.is_enabled) {
        throw new Error("The 'Quote Delivery' email is turned off in Settings > Automation & Messaging");
      }
      const { data: templates } = await supabase
        .from("communication_templates")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "quote_sent")
        .eq("is_active", true);
      const template = (templates ?? []).find((t) => rule.channel === "both" || rule.channel === t.type);
      if (!template) throw new Error("No active 'Quote Delivery' email template found");
      setEmailDefaults({ subject: template.subject ?? "", body: template.body });
      // Best-effort - if PDF generation fails for any reason, the email
      // still sends with just the view-online link, same as before this
      // feature existed, rather than blocking the send entirely.
      try {
        const pdfBlob = await buildQuotePdfBytes({ tenant, quote: data.quote, client: data.quote.clients, lineItems: data.items, site: currentSite });
        const pdfDataUrl = await blobToDataUrl(pdfBlob);
        setEmailDefaultAttachments([{ filename: `Quote ${data.quote.quote_number}.pdf`, content: pdfDataUrl }]);
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
      entityType: "quote",
      entityId: id!,
      triggerKey: "quote_sent",
      ...payload,
    });
    const { error } = await supabase.from("quotes").update({ status: "sent" }).eq("id", id);
    if (error) throw error;
    invalidate();
    setSendEmailError(null);
    setSendResult(wasSent ? "The quote email has been sent." : "The quote is marked sent and the email is queued.");
    setTimeout(() => setSendResult(null), 5000);
  };

  const recipientOptions = collectRecipientEmails({
    clientEmail: data?.quote.clients?.email,
    contactEmails: (clientContacts ?? []).map((c) => c.email),
    freeText: jobNoteBodies ?? [],
  });

  const [addressModalOpen, setAddressModalOpen] = useState(false);
  const [addressSiteChoice, setAddressSiteChoice] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);

  const updateSite = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("quotes").update({ site_id: addressSiteChoice || null }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      setAddressModalOpen(false);
    },
    onError: (e) => setAddressError(getErrorMessage(e, "Failed to update address")),
  });

  const currentSite = (clientSites ?? []).find((s) => s.id === data?.quote.site_id) ?? null;

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Same on-device-generation approach as apps/mobile's own Export PDF
  // button (see docs/SETUP.md's Phase 5 known-gaps note for why this isn't
  // a server-side/Edge Function render) - just the browser's print dialog
  // instead of expo-print's native share sheet, since there's no
  // equivalent here. Uses the persisted line items, not the in-progress
  // edits in `lineItems` state, so exporting always reflects what's
  // actually saved.
  const handleExportPdf = () => {
    if (!data || !tenant || !data.quote.clients) return;
    setExporting(true);
    setExportError(null);
    try {
      const html = buildQuotePdfHtml({ tenant, quote: data.quote, client: data.quote.clients, lineItems: data.items, site: currentSite });
      exportPdf(html, `Quote ${data.quote.quote_number}`);
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
      <Link to="/quotes" className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to Quotes
      </Link>

      <h1 className="text-xl font-bold text-gray-900">{data.quote.quote_number}</h1>
      <p className="text-sm text-gray-500">{data.quote.clients?.name ?? "Unknown client"}</p>
      {data.quote.job_cards ? (
        <Link to={`/jobs/${data.quote.job_card_id}`} className="text-sm text-blue-700 hover:underline">
          Job: {data.quote.job_cards.title}
        </Link>
      ) : null}
      <p className="mt-1 text-sm text-gray-600">
        {currentSite ? `${currentSite.label ? `${currentSite.label}: ` : ""}${formatSiteAddress(currentSite)}` : "Client's main address"}{" "}
        <button
          onClick={() => {
            setAddressSiteChoice(data.quote.site_id ?? "");
            setAddressError(null);
            setAddressModalOpen(true);
          }}
          className="text-xs font-semibold text-blue-700 hover:underline"
        >
          Edit address
        </button>
      </p>

      {data.quote.approval_status ? (
        <div
          className={`mt-2 inline-block rounded-full px-3 py-1 text-xs font-bold ${
            data.quote.approval_status === "accepted"
              ? "bg-green-100 text-green-700"
              : data.quote.approval_status === "declined"
                ? "bg-red-100 text-red-700"
                : "bg-yellow-100 text-yellow-800"
          }`}
        >
          {APPROVAL_STATUS_LABELS[data.quote.approval_status]}
        </div>
      ) : null}
      {data.quote.approval_status === "declined" && data.quote.decline_reason ? (
        <p className="mt-2 text-sm text-red-700">Reason: {data.quote.decline_reason}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          onClick={() => openSendEmail()}
          disabled={openingEmail}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {openingEmail ? "Preparing..." : "Send Quote via Email"}
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
              : data.quote.access_token
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
              data.quote.status === status ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"
            }`}
          >
            {STATUS_LABELS[status]}
          </button>
        ))}
      </div>

      <div className="mt-4">
        <label className="mb-1 block text-sm font-semibold text-gray-700">Expiry date</label>
        <input
          type="date"
          value={expiryDate}
          disabled={isLocked}
          onChange={(e) => setExpiryDate(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
        />
      </div>

      <h2 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-gray-500">Line items</h2>
      {isLocked ? (
        <p className="mb-2 text-sm text-gray-500">
          This quote has been {data.quote.approval_status} by the client and its line items are now read-only.
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

      <button
        onClick={() => setConvertOpen(true)}
        className="ml-3 mt-4 rounded-md bg-gray-100 px-6 py-3 text-sm font-semibold text-blue-700 hover:bg-gray-200"
      >
        Convert to invoice
      </button>

      <Modal open={convertOpen} onClose={() => setConvertOpen(false)} title="Convert to invoice">
        <p className="mb-4 text-2xl font-extrabold text-gray-900">
          {formatCentsAsAud(calculateDocumentTotals(lineItems).total_cents)}
        </p>
        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold text-gray-700">Due date (optional)</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        {convertError ? <p className="mb-4 text-sm text-red-600">{convertError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setConvertOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => convert.mutate()}
            disabled={convert.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {convert.isPending ? "Converting..." : "Create invoice"}
          </button>
        </div>
      </Modal>

      <Modal open={addressModalOpen} onClose={() => setAddressModalOpen(false)} title="Edit quote address">
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

      <EmailComposeModal
        open={emailModalOpen}
        onClose={() => setEmailModalOpen(false)}
        title="Send quote"
        defaultTo={data.quote.clients?.email ?? ""}
        defaultSubject={emailDefaults.subject}
        defaultBody={emailDefaults.body}
        defaultAttachments={emailDefaultAttachments}
        recipientOptions={recipientOptions}
        onSend={handleSendEmail}
        sendLabel="Send quote"
      />
    </div>
  );
}

import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  calculateDocumentTotals,
  collectRecipientEmails,
  formatCentsAsAud,
  type ApprovalStatus,
  type Client,
  type ClientContact,
  type EmailAttachment,
  type LineItemFormInput,
  type Quote,
  type QuoteStatus,
  type Tenant,
} from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { useIsOnline } from "../../../../lib/connectivity";
import { useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../lib/supabase";
import { getErrorMessage } from "../../../../lib/errors";
import { triggerImmediateDispatch } from "../../../../lib/dispatch-now";
import { buildQuotePdfHtml } from "../../../../lib/pdf";
import { buildPdfDataUri, exportPdf } from "../../../../lib/print";
import { RequiresConnectionNotice } from "../../../../components/RequiresConnectionNotice";
import { LineItemEditor, LineItemSummary } from "../../../../components/LineItemEditor";
import { CenteredModal } from "../../../../components/CenteredModal";
import { EmailComposeModal, type EmailTemplateOption } from "../../../../components/EmailComposeModal";
import { FormField } from "../../../../components/FormField";
import { DateField } from "../../../../components/DateField";

const STATUSES: QuoteStatus[] = ["draft", "sent", "accepted", "declined", "expired"];
const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};

// The client's response to the approval link - distinct from the STATUSES
// chips above, which are the admin's own internal workflow state and can
// be changed freely regardless of whether a client has ever seen the doc.
const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  sent: "Link sent - awaiting response",
  viewed: "Viewed by client - awaiting response",
  accepted: "Accepted by client",
  declined: "Declined by client",
};

type QuoteRow = Quote & { clients: Client | null; job_cards: { title: string } | null };

function parseDate(s: string): Date | null {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateInput(d: Date | null): string {
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function QuoteDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";

  const { data, loading, error, refetch } = useSupabaseFetch(async () => {
    const [{ data: quote, error: quoteError }, { data: items, error: itemsError }] = await Promise.all([
      supabase
        .from("quotes")
        .select("*, clients(*), job_cards!quotes_job_card_id_fkey(title)")
        .eq("id", id)
        .single(),
      supabase.from("quote_line_items").select("*").eq("quote_id", id).order("sort_order"),
    ]);
    if (quoteError) throw quoteError;
    if (itemsError) throw itemsError;
    return { quote: quote as QuoteRow, items: (items ?? []) as LineItemFormInput[] };
  }, [id, isOnline]);

  const [lineItems, setLineItems] = useState<LineItemFormInput[]>([]);
  const [notes, setNotes] = useState("");
  const [expiryDate, setExpiryDate] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [convertVisible, setConvertVisible] = useState(false);
  const [dueDate, setDueDate] = useState<Date | null>(null);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [sendEmailError, setSendEmailError] = useState<string | null>(null);
  const [emailModalVisible, setEmailModalVisible] = useState(false);
  const [emailDefaults, setEmailDefaults] = useState({ subject: "", body: "" });
  const [emailDefaultAttachments, setEmailDefaultAttachments] = useState<EmailAttachment[]>([]);
  const [quoteTemplateId, setQuoteTemplateId] = useState<string | null>(null);
  const [openingEmail, setOpeningEmail] = useState(false);
  const { data: clientContacts } = useSupabaseFetch<ClientContact[]>(async () => {
    if (!isOnline || !data?.quote.client_id) return [];
    const { data: rows, error } = await supabase.from("client_contacts").select("*").eq("client_id", data.quote.client_id);
    if (error) throw error;
    return rows as ClientContact[];
  }, [isOnline, data?.quote.client_id]);
  const recipientOptions = collectRecipientEmails({
    clientEmail: data?.quote.clients?.email,
    contactEmails: (clientContacts ?? []).map((c) => c.email),
  });

  // Once the client has actually responded, the line items/totals are
  // locked at the database level too (see the accepted case's trigger in
  // supabase/migrations/20260728000100_quote_invoice_approval.sql) - the
  // editor is hidden for "declined" as well so the admin doesn't edit a
  // document the client has already seen and responded to without
  // re-sending it, even though only "accepted" is hard-enforced in
  // Postgres.
  const isLocked = data?.quote.approval_status === "accepted" || data?.quote.approval_status === "declined";

  useEffect(() => {
    if (data) {
      setLineItems(data.items);
      setNotes(data.quote.notes ?? "");
      setExpiryDate(parseDate(data.quote.expiry_date ?? ""));
    }
  }, [data]);

  const handleStatusChange = async (status: QuoteStatus) => {
    await supabase.from("quotes").update({ status }).eq("id", id);
    refetch();
  };

  // Shared by Save and Convert: persists the quote's notes/expiry_date plus
  // whatever's currently in the line item editor. The line item write goes
  // through the replace_quote_line_items RPC (see
  // supabase/migrations/20260721000100_atomic_line_item_rpcs.sql), which
  // deletes+reinserts the set and recomputes subtotal/gst/total from it in
  // one transaction, instead of the old two-call delete-then-insert that
  // could leave a quote with no line items if the second call failed.
  const persistQuoteAndLineItems = async () => {
    const { error: updateError } = await supabase
      .from("quotes")
      .update({ notes: notes || null, expiry_date: toDateInput(expiryDate) || null })
      .eq("id", id);
    if (updateError) throw updateError;

    const { error: rpcError } = await supabase.rpc("replace_quote_line_items", {
      p_quote_id: id,
      p_items: lineItems,
    });
    if (rpcError) throw rpcError;
  };

  const handleSave = async () => {
    if (!profile) return;
    setSaving(true);
    setSaveError(null);
    try {
      await persistQuoteAndLineItems();
      refetch();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleExportPdf = async () => {
    if (!data || !profile) return;
    setExporting(true);
    setExportError(null);
    try {
      const { data: tenant, error: tenantError } = await supabase
        .from("tenants")
        .select("*")
        .eq("id", profile.tenant_id)
        .single();
      if (tenantError) throw tenantError;
      if (!data.quote.clients) throw new Error("This quote has no client on file");

      const html = buildQuotePdfHtml({
        tenant: tenant as Tenant,
        quote: data.quote,
        client: data.quote.clients,
        lineItems,
      });
      await exportPdf(html, `Quote ${data.quote.quote_number}`);
    } catch (e) {
      console.error("[Quotes] Failed to export PDF", e);
      setExportError(getErrorMessage(e, "Failed to export PDF (see console for details)"));
    } finally {
      setExporting(false);
    }
  };

  const handleConvert = async () => {
    if (!profile || !data) return;
    setConverting(true);
    setConvertError(null);
    try {
      // Persist any pending edits first, so the invoice is created from
      // exactly what's on screen rather than a possibly-stale DB copy - the
      // convert_quote_to_invoice RPC reads quote_line_items as persisted,
      // it doesn't take the in-memory editor state as input.
      await persistQuoteAndLineItems();

      // No invoice number passed - the assign_invoice_number trigger
      // assigns the next INV### automatically, same as every other invoice.
      const { data: invoiceId, error } = await supabase.rpc("convert_quote_to_invoice", {
        p_quote_id: id,
        p_due_date: toDateInput(dueDate) || null,
      });
      if (error) throw error;

      setConvertVisible(false);
      router.replace(`/sales/invoices/${invoiceId}`);
    } catch (e) {
      setConvertError(e instanceof Error ? e.message : "Failed to convert to invoice");
    } finally {
      setConverting(false);
    }
  };

  // Generates the token if one doesn't exist yet (idempotent - see
  // generate_quote_approval_link), then hands the resulting link straight
  // to the native Share sheet - a manual fallback for when the client has
  // no email on file, or the admin would rather text/WhatsApp it
  // themselves. openSendEmail below is the real "send it" action.
  const handleGenerateAndShareLink = async () => {
    if (!data) return;
    // The approval page is deployed externally (Cloudflare Pages/Netlify/
    // etc), not on Supabase itself - see docs/SETUP.md "Quote/invoice
    // digital acceptance" for why (Supabase force-downgrades HTML
    // responses to inert text/plain on its own shared domain, confirmed
    // for both Edge Functions and Storage). EXPO_PUBLIC_APPROVAL_PAGE_URL
    // points at wherever that ended up living.
    const approvalPageUrl = process.env.EXPO_PUBLIC_APPROVAL_PAGE_URL;
    if (!approvalPageUrl) {
      setLinkError("Approval page URL not configured - set EXPO_PUBLIC_APPROVAL_PAGE_URL in .env (see docs/SETUP.md)");
      return;
    }
    setGeneratingLink(true);
    setLinkError(null);
    try {
      const { data: token, error: rpcError } = await supabase.rpc("generate_quote_approval_link", {
        p_quote_id: id,
      });
      if (rpcError) throw rpcError;

      const url = `${approvalPageUrl}?type=quote&token=${token}`;
      await Share.share({ message: `Please review and approve this quote: ${url}` });
      refetch();
    } catch (e) {
      console.error("[Quotes] Failed to generate approval link", e);
      setLinkError(getErrorMessage(e, "Failed to generate approval link (see console for details)"));
    } finally {
      setGeneratingLink(false);
    }
  };

  // The actual "send it" action - was missing entirely until now (only the
  // Share-sheet handoff above existed). Looks up the tenant's quote_sent
  // rule/template (see the manual_send migration - same "manual trigger,
  // admin-editable in Automation Settings" shape as job_on_the_way),
  // queues a scheduled_communications row with the raw template copy, and
  // immediately dispatches it via the same lib/dispatch-now.ts helper the
  // job screen's On The Way button uses. The dispatcher itself generates
  // the approval token and renders {quote_accept_link}/{quote_decline_link}
  // etc. at send time (see process-scheduled-comms's buildEntityContext),
  // so there's no separate generate_quote_approval_link call needed here.
  // Setting status to 'sent' in the same action (rather than leaving it to
  // a separate manual tap of the Status chip) is what actually starts the
  // quote_stage_1/quote_stage_2/quote_expiring_soon/quote_expired reminder
  // ladder - those only fire on that transition.
  const openSendEmail = async () => {
    if (!data || !profile || !data.quote.clients) return;
    const email = data.quote.clients.email;
    if (!email) {
      setSendEmailError("This client has no email address on file - add one on the Client Details screen.");
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
      setQuoteTemplateId(template.id);
      setEmailDefaults({ subject: template.subject ?? "", body: template.body });

      // Best-effort PDF auto-attach - a generation failure still lets the
      // email send without it, same as desktop.
      try {
        const { data: tenant } = await supabase.from("tenants").select("*").eq("id", profile.tenant_id).single();
        const html = buildQuotePdfHtml({ tenant: tenant as Tenant, quote: data.quote, client: data.quote.clients, lineItems });
        const pdfDataUri = await buildPdfDataUri(html);
        setEmailDefaultAttachments([{ filename: `Quote ${data.quote.quote_number}.pdf`, content: pdfDataUri }]);
      } catch {
        setEmailDefaultAttachments([]);
      }
      setEmailModalVisible(true);
    } catch (e) {
      setSendEmailError(getErrorMessage(e, "Failed to prepare email"));
    } finally {
      setOpeningEmail(false);
    }
  };

  const handleSendEmail = async (payload: { to: string; cc: string; bcc: string; subject: string; body: string; attachments: EmailAttachment[] }) => {
    if (!profile) throw new Error("Not signed in");
    const { data: row, error: insertError } = await supabase
      .from("scheduled_communications")
      .insert({
        tenant_id: profile.tenant_id,
        entity_type: "quote",
        entity_id: id,
        trigger_key: "quote_sent",
        template_id: quoteTemplateId,
        channel: "email",
        recipient_phone_or_email: payload.to,
        cc_emails: payload.cc ? payload.cc.split(",").map((s) => s.trim()).filter(Boolean) : [],
        bcc_emails: payload.bcc ? payload.bcc.split(",").map((s) => s.trim()).filter(Boolean) : [],
        rendered_subject: payload.subject,
        rendered_body: payload.body,
        attachments: payload.attachments,
        scheduled_for: new Date().toISOString(),
        status: "pending",
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    const wasSent = await triggerImmediateDispatch(row.id);

    const { error: statusError } = await supabase.from("quotes").update({ status: "sent" }).eq("id", id);
    if (statusError) throw statusError;

    refetch();
    setSendEmailError(null);
    Alert.alert(
      wasSent ? "Sent" : "Queued",
      wasSent ? "The quote email has been sent." : "The quote is marked sent and the email is queued - it'll go out shortly."
    );
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Quotes" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.container}>
        <Text style={styles.error}>{error}</Text>
        <Pressable style={styles.saveButton} onPress={() => refetch()}>
          <Text style={styles.saveButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (loading || !data) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={styles.title}>{data.quote.quote_number}</Text>
        <Text style={styles.subtitle}>{data.quote.clients?.name ?? "Unknown client"}</Text>
        {data.quote.job_cards ? (
          <Pressable onPress={() => router.push(`/sales/jobs/${data.quote.job_card_id}`)}>
            <Text style={styles.link}>Job: {data.quote.job_cards.title}</Text>
          </Pressable>
        ) : null}

        {data.quote.approval_status ? (
          <View
            style={[
              styles.approvalBadge,
              data.quote.approval_status === "accepted" && styles.approvalBadgeAccepted,
              data.quote.approval_status === "declined" && styles.approvalBadgeDeclined,
            ]}
          >
            <Text
              style={[
                styles.approvalBadgeText,
                data.quote.approval_status === "accepted" && styles.approvalBadgeTextAccepted,
                data.quote.approval_status === "declined" && styles.approvalBadgeTextDeclined,
              ]}
            >
              {APPROVAL_STATUS_LABELS[data.quote.approval_status]}
            </Text>
          </View>
        ) : null}
        {data.quote.approval_status === "declined" && data.quote.decline_reason ? (
          <Text style={styles.declineReason}>Reason: {data.quote.decline_reason}</Text>
        ) : null}

        {isAdmin ? (
          <Pressable style={styles.sendEmailButton} onPress={openSendEmail} disabled={openingEmail}>
            <Text style={styles.sendEmailButtonText}>{openingEmail ? "Preparing..." : "Send Quote via Email"}</Text>
          </Pressable>
        ) : null}
        {sendEmailError ? <Text style={styles.error}>{sendEmailError}</Text> : null}

        {isAdmin ? (
          <Pressable style={styles.linkButton} onPress={handleGenerateAndShareLink} disabled={generatingLink}>
            <Text style={styles.linkButtonText}>
              {generatingLink ? "Generating..." : data.quote.access_token ? "Share approval link" : "Generate & share approval link"}
            </Text>
          </Pressable>
        ) : null}
        {linkError ? <Text style={styles.error}>{linkError}</Text> : null}

        <Text style={styles.sectionTitle}>Status</Text>
        <View style={styles.statusRow}>
          {STATUSES.map((status) => (
            <Pressable
              key={status}
              style={[styles.statusChip, data.quote.status === status && styles.statusChipActive]}
              onPress={() => handleStatusChange(status)}
            >
              <Text style={[styles.statusChipText, data.quote.status === status && styles.statusChipTextActive]}>
                {STATUS_LABELS[status]}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.fieldSpacing}>
          <DateField label="Expiry date" value={expiryDate} onChange={setExpiryDate} mode="date" placeholder="No expiry date" />
        </View>

        <Text style={styles.sectionTitle}>Line items</Text>
        {isLocked ? (
          <Text style={styles.lockedNotice}>
            This quote has been {data.quote.approval_status} by the client and its line items are now read-only.
          </Text>
        ) : null}
        {isAdmin && !isLocked ? <LineItemEditor items={lineItems} onChange={setLineItems} /> : <LineItemSummary items={lineItems} />}

        <View style={styles.fieldSpacing}>
          <FormField label="Notes" placeholder="Terms, exclusions, etc." value={notes} onChangeText={setNotes} multiline style={styles.multiline} editable={isAdmin && !isLocked} />
        </View>

        {saveError ? <Text style={styles.error}>{saveError}</Text> : null}

        {isAdmin && !isLocked ? (
          <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
            <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save changes"}</Text>
          </Pressable>
        ) : null}

        {exportError ? <Text style={styles.error}>{exportError}</Text> : null}
        <Pressable style={styles.convertButton} onPress={handleExportPdf} disabled={exporting}>
          <Text style={styles.convertButtonText}>{exporting ? "Preparing PDF..." : "Export PDF"}</Text>
        </Pressable>

        {isAdmin ? (
          <Pressable style={styles.convertButton} onPress={() => setConvertVisible(true)}>
            <Text style={styles.convertButtonText}>Convert to invoice</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      <CenteredModal visible={convertVisible} onClose={() => setConvertVisible(false)}>
        <Text style={styles.modalTitle}>Convert to invoice</Text>
        <Text style={styles.modalTotal}>{formatCentsAsAud(calculateDocumentTotals(lineItems).total_cents)}</Text>
        <DateField label="Due date (optional)" value={dueDate} onChange={setDueDate} mode="date" placeholder="No due date" />
        {convertError ? <Text style={styles.error}>{convertError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setConvertVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.saveButton} onPress={handleConvert} disabled={converting}>
            <Text style={styles.saveButtonText}>{converting ? "Converting..." : "Create invoice"}</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <EmailComposeModal
        visible={emailModalVisible}
        onClose={() => setEmailModalVisible(false)}
        title="Send quote"
        defaultTo={data.quote.clients?.email ?? ""}
        defaultSubject={emailDefaults.subject}
        defaultBody={emailDefaults.body}
        defaultAttachments={emailDefaultAttachments}
        recipientOptions={recipientOptions}
        onSend={handleSendEmail}
        sendLabel="Send quote"
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  title: { fontSize: 20, fontWeight: "700" },
  subtitle: { color: "#6b7280", marginTop: 2 },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginTop: 16, marginBottom: 6 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: "#f3f4f6" },
  statusChipActive: { backgroundColor: "#1d4ed8" },
  statusChipText: { color: "#374151", fontWeight: "600" },
  statusChipTextActive: { color: "#fff" },
  fieldSpacing: { marginTop: 16 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  error: { color: "#dc2626", marginTop: 12 },
  approvalBadge: { alignSelf: "flex-start", backgroundColor: "#fef9c3", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 4, marginTop: 10 },
  approvalBadgeAccepted: { backgroundColor: "#dcfce7" },
  approvalBadgeDeclined: { backgroundColor: "#fee2e2" },
  approvalBadgeText: { fontSize: 12, fontWeight: "700", color: "#854d0e" },
  approvalBadgeTextAccepted: { color: "#15803d" },
  approvalBadgeTextDeclined: { color: "#b91c1c" },
  declineReason: { color: "#b91c1c", fontSize: 13, marginTop: 6 },
  sendEmailButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 14 },
  sendEmailButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  linkButton: { alignSelf: "flex-start", marginTop: 10 },
  linkButtonText: { color: "#1d4ed8", fontWeight: "600" },
  lockedNotice: { color: "#6b7280", fontSize: 13, marginBottom: 8 },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 20 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  convertButton: { borderRadius: 8, padding: 14, alignItems: "center", marginTop: 12, backgroundColor: "#f3f4f6" },
  convertButtonText: { color: "#1d4ed8", fontWeight: "700", fontSize: 16 },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
  modalTitle: { fontSize: 18, fontWeight: "700" },
  modalTotal: { fontSize: 22, fontWeight: "800", color: "#111827" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  link: { color: "#1d4ed8", fontWeight: "600", marginTop: 4 },
});

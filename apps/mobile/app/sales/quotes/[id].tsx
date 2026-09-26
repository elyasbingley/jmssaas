import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Share, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  calculateDocumentTotals,
  collectRecipientEmails,
  formatCentsAsAud,
  renderTemplate,
  type ApprovalStatus,
  type Client,
  type ClientContact,
  type EmailAttachment,
  type LineItemFormInput,
  type Quote,
  type QuoteStatus,
  type ReferralPartner,
  type Tenant,
} from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { supabase } from "../../../lib/supabase";
import { getErrorMessage } from "../../../lib/errors";
import { triggerImmediateDispatch } from "../../../lib/dispatch-now";
import { buildQuotePdfHtml } from "../../../lib/pdf";
import { buildPdfDataUri, exportPdf } from "../../../lib/print";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedModal } from "../../../components/theme/ThemedModal";
import { ThemedFormField } from "../../../components/theme/ThemedFormField";
import { ThemedDateField } from "../../../components/theme/ThemedDateField";
import { ThemedPickerModal } from "../../../components/theme/ThemedPickerModal";
import { ThemedButton } from "../../../components/theme/ThemedButton";
import { LineItemEditor, LineItemSummary } from "../../../components/LineItemEditor";
import { EmailComposeModal, type EmailTemplateOption } from "../../../components/EmailComposeModal";
import { partnerDisplayName } from "../../b2b-referrals/index";

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
  const styles = useThemedStyles(createStyles);

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

  const { data: referralPartners } = useSupabaseFetch<ReferralPartner[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("referral_partners").select("*").order("contact_first_name");
    if (error) throw error;
    return data as ReferralPartner[];
  }, [isOnline]);
  const [referralPickerVisible, setReferralPickerVisible] = useState(false);
  const currentReferralPartner = (referralPartners ?? []).find((p) => p.id === data?.quote.referral_partner_id) ?? null;

  const handleSelectReferralPartner = async (partner: ReferralPartner | null) => {
    const { error } = await supabase.from("quotes").update({ referral_partner_id: partner?.id ?? null }).eq("id", id);
    if (!error) refetch();
  };

  const [poModalVisible, setPoModalVisible] = useState(false);
  const [poNumberInput, setPoNumberInput] = useState("");
  const [poError, setPoError] = useState<string | null>(null);
  const [poSaving, setPoSaving] = useState(false);

  const handleSavePoNumber = async () => {
    setPoSaving(true);
    setPoError(null);
    try {
      const { error } = await supabase.from("quotes").update({ po_number: poNumberInput.trim() || null }).eq("id", id);
      if (error) throw error;
      setPoModalVisible(false);
      refetch();
    } catch (e) {
      setPoError(getErrorMessage(e, "Failed to save PO number"));
    } finally {
      setPoSaving(false);
    }
  };

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
  //
  // Skipped once the quote is locked (accepted/declined): the line item
  // editor is already read-only in that state (see isLocked below) so
  // there's nothing pending to write, and re-submitting the exact same
  // rows would trip quote_line_items_enforce_accepted_lock for no reason
  // - that trigger exists to stop a genuine edit after the client has
  // accepted, not to block Convert from turning the quote they accepted
  // into an invoice. Save's own callers already only run when unlocked, so
  // this only changes behaviour for Convert, which is reachable in any
  // state.
  const persistQuoteAndLineItems = async () => {
    const { error: updateError } = await supabase
      .from("quotes")
      .update({ notes: notes || null, expiry_date: toDateInput(expiryDate) || null })
      .eq("id", id);
    if (updateError) throw updateError;

    if (isLocked) return;

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

      const { data: tenantRow } = await supabase.from("tenants").select("*").eq("id", profile.tenant_id).single();
      const tenant = tenantRow as Tenant;

      // Render tags against this specific client/quote before showing the
      // composer - same fix as desktop's QuoteDetail.tsx, and safe for the
      // same reason: process-scheduled-comms always re-renders rendered_
      // subject/rendered_body against fresh data at actual send time
      // regardless (see that function's own comment), so this only affects
      // what the editable preview looks like, not what a stale approval
      // link would eventually resolve to.
      const approvalPageUrl = process.env.EXPO_PUBLIC_APPROVAL_PAGE_URL;
      let approvalLink: string | null = null;
      if (approvalPageUrl) {
        const { data: token } = await supabase.rpc("generate_quote_approval_link", { p_quote_id: id });
        if (token) approvalLink = `${approvalPageUrl}?type=quote&token=${token}`;
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
        client: { name: data.quote.clients.name, phone: data.quote.clients.phone, email: data.quote.clients.email },
        quote: {
          quote_number: data.quote.quote_number,
          total_cents: data.quote.total_cents,
          issue_date: data.quote.issue_date,
          expiry_date: data.quote.expiry_date,
          approval_link: approvalLink,
          accept_link: approvalLink ? `${approvalLink}&action=accept` : null,
          decline_link: approvalLink ? `${approvalLink}&action=decline` : null,
        },
      };
      setEmailDefaults({
        subject: template.subject ? renderTemplate(template.subject, renderContext) : "",
        body: renderTemplate(template.body, renderContext),
      });

      // Best-effort PDF auto-attach - a generation failure still lets the
      // email send without it, same as desktop.
      try {
        const html = buildQuotePdfHtml({ tenant, quote: data.quote, client: data.quote.clients, lineItems });
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

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Text style={styles.link}>‹ Back</Text>
      </Pressable>
      <Text style={styles.headerTitle}>Quote</Text>
    </View>
  );

  if (!isOnline) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
          {header}
          <ThemedRequiresConnectionNotice label="Quotes" />
        </SafeAreaView>
      </>
    );
  }

  if (error) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
          {header}
          <View style={styles.container}>
            <Text style={styles.error}>{error}</Text>
            <View style={styles.retryButtonWrap}>
              <ThemedButton label="Retry" onPress={() => refetch()} />
            </View>
          </View>
        </SafeAreaView>
      </>
    );
  }

  if (loading || !data) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
          {header}
          <View style={styles.container}>
            <Text style={styles.empty}>Loading...</Text>
          </View>
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        {header}
        <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
          <Text style={styles.title}>{data.quote.quote_number}</Text>
          <Text style={styles.subtitle}>{data.quote.clients?.name ?? "Unknown client"}</Text>
          {data.quote.job_cards ? (
            <Pressable onPress={() => router.push(`/jobs/${data.quote.job_card_id}`)}>
              <Text style={styles.link}>Job: {data.quote.job_cards.title}</Text>
            </Pressable>
          ) : null}

          <View style={styles.referralRow}>
            <Text style={styles.sectionTitle}>Referral source: {currentReferralPartner ? partnerDisplayName(currentReferralPartner) : "None"}</Text>
            <Pressable onPress={() => setReferralPickerVisible(true)}>
              <Text style={styles.linkButtonText}>{data.quote.referral_partner_id ? "Edit" : "+ Add"}</Text>
            </Pressable>
          </View>

          <View style={styles.referralRow}>
            <Text style={styles.sectionTitle}>PO number: {data.quote.po_number ?? "Not set"}</Text>
            <Pressable
              onPress={() => {
                setPoNumberInput(data.quote.po_number ?? "");
                setPoError(null);
                setPoModalVisible(true);
              }}
            >
              <Text style={styles.linkButtonText}>{data.quote.po_number ? "Edit" : "+ Add"}</Text>
            </Pressable>
          </View>

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
            <View style={styles.sendEmailButtonWrap}>
              <ThemedButton label={openingEmail ? "Preparing..." : "Send Quote via Email"} onPress={openSendEmail} disabled={openingEmail} />
            </View>
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
            <ThemedDateField label="Expiry date" value={expiryDate} onChange={setExpiryDate} mode="date" placeholder="No expiry date" />
          </View>

          <Text style={styles.sectionTitle}>Line Items</Text>
          {isLocked ? (
            <Text style={styles.lockedNotice}>
              This quote has been {data.quote.approval_status} by the client and its line items are now read-only.
            </Text>
          ) : null}
          {isAdmin && !isLocked ? (
            <LineItemEditor
              items={lineItems}
              onChange={setLineItems}
              membershipDiscountCents={data.quote.membership_discount_cents}
              tenantId={profile?.tenant_id ?? ""}
            />
          ) : (
            <LineItemSummary items={lineItems} membershipDiscountCents={data.quote.membership_discount_cents} />
          )}

          <View style={styles.fieldSpacing}>
            <ThemedFormField label="Notes" placeholder="Terms, exclusions, etc." value={notes} onChangeText={setNotes} multiline style={styles.multiline} editable={isAdmin && !isLocked} />
          </View>

          {saveError ? <Text style={styles.error}>{saveError}</Text> : null}

          {isAdmin && !isLocked ? (
            <View style={styles.saveButtonWrap}>
              <ThemedButton label={saving ? "Saving..." : "Save Changes"} onPress={handleSave} disabled={saving} />
            </View>
          ) : null}

          {exportError ? <Text style={styles.error}>{exportError}</Text> : null}
          <Pressable style={styles.convertButton} onPress={handleExportPdf} disabled={exporting}>
            <Text style={styles.convertButtonText}>{exporting ? "Preparing PDF..." : "Export PDF"}</Text>
          </Pressable>

          {isAdmin ? (
            <Pressable style={styles.convertButton} onPress={() => setConvertVisible(true)}>
              <Text style={styles.convertButtonText}>Convert to Invoice</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </SafeAreaView>

      <ThemedModal visible={convertVisible} onClose={() => setConvertVisible(false)}>
        <Text style={styles.modalTitle}>Convert to Invoice</Text>
        <Text style={styles.modalTotal}>{formatCentsAsAud(calculateDocumentTotals(lineItems).total_cents)}</Text>
        <ThemedDateField label="Due date (optional)" value={dueDate} onChange={setDueDate} mode="date" placeholder="No due date" />
        {convertError ? <Text style={styles.error}>{convertError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setConvertVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label={converting ? "Converting..." : "Create Invoice"} onPress={handleConvert} disabled={converting} />
        </View>
      </ThemedModal>

      <ThemedPickerModal
        visible={referralPickerVisible}
        title="Referral source"
        items={[null, ...(referralPartners ?? [])]}
        getKey={(p) => p?.id ?? "none"}
        getLabel={(p) => (p ? partnerDisplayName(p) : "None")}
        onSelect={handleSelectReferralPartner}
        onClose={() => setReferralPickerVisible(false)}
      />

      <ThemedModal visible={poModalVisible} onClose={() => setPoModalVisible(false)}>
        <Text style={styles.modalTitle}>PO Number</Text>
        <ThemedFormField label="PO number" placeholder="e.g. PO-4821" value={poNumberInput} onChangeText={setPoNumberInput} />
        {poError ? <Text style={styles.error}>{poError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setPoModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label={poSaving ? "Saving..." : "Save"} onPress={handleSavePoNumber} disabled={poSaving} />
        </View>
      </ThemedModal>

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

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    headerTitle: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    title: { fontSize: font.title, fontWeight: "700" as const, color: tokens.accent, letterSpacing: 1, ...mono },
    subtitle: { color: tokens.textMuted, marginTop: 2, fontSize: font.body - 1, ...mono },
    sectionTitle: {
      fontSize: font.label,
      fontWeight: "700" as const,
      color: tokens.accent,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      marginTop: 16,
      marginBottom: 6,
      ...mono,
    },
    referralRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, marginTop: 4 },
    statusRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    statusChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 3, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface },
    statusChipActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    statusChipText: { color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.body - 1, ...mono },
    statusChipTextActive: { color: tokens.accent },
    fieldSpacing: { marginTop: 16 },
    multiline: { minHeight: 70, textAlignVertical: "top" as const },
    error: { color: tokens.danger, marginTop: 12, ...mono },
    retryButtonWrap: { marginTop: 12, alignSelf: "flex-start" as const },
    approvalBadge: { alignSelf: "flex-start" as const, borderWidth: 1, borderColor: tokens.warning, borderRadius: 3, paddingHorizontal: 12, paddingVertical: 4, marginTop: 10 },
    approvalBadgeAccepted: { borderColor: tokens.accent, backgroundColor: tokens.accentGlow },
    approvalBadgeDeclined: { borderColor: tokens.danger },
    approvalBadgeText: { fontSize: font.label, fontWeight: "700" as const, color: tokens.warning, ...mono },
    approvalBadgeTextAccepted: { color: tokens.accent },
    approvalBadgeTextDeclined: { color: tokens.danger },
    declineReason: { color: tokens.danger, fontSize: font.label, marginTop: 6, ...mono },
    sendEmailButtonWrap: { marginTop: 14 },
    linkButton: { alignSelf: "flex-start" as const, marginTop: 10 },
    linkButtonText: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    lockedNotice: { color: tokens.textMuted, fontSize: font.label, marginBottom: 8, ...mono },
    saveButtonWrap: { marginTop: 20 },
    convertButton: { borderRadius: 3, padding: 14, alignItems: "center" as const, marginTop: 12, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface },
    convertButtonText: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.body, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 24, ...mono },
    modalTitle: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    modalTotal: { fontSize: 22, fontWeight: "800" as const, color: tokens.textPrimary, ...mono },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 20, marginTop: 8 },
    link: { color: tokens.accent, fontWeight: "600" as const, marginTop: 4, ...mono },
  };
}

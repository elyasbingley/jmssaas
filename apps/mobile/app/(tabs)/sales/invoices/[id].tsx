import { useEffect, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { collectRecipientEmails, renderTemplate, type Agency, type ApprovalStatus, type Client, type ClientContact, type EmailAttachment, type Invoice, type InvoiceStatus, type LineItemFormInput, type Property, type ReferralPartner, type Tenant } from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { useIsOnline } from "../../../../lib/connectivity";
import { useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../lib/supabase";
import { getErrorMessage } from "../../../../lib/errors";
import { triggerImmediateDispatch } from "../../../../lib/dispatch-now";
import { buildInvoicePdfHtml } from "../../../../lib/pdf";
import { buildPdfDataUri, exportPdf } from "../../../../lib/print";
import { RequiresConnectionNotice } from "../../../../components/RequiresConnectionNotice";
import { CenteredModal } from "../../../../components/CenteredModal";
import { EmailComposeModal, type EmailTemplateOption } from "../../../../components/EmailComposeModal";
import { LineItemEditor, LineItemSummary } from "../../../../components/LineItemEditor";
import { FormField } from "../../../../components/FormField";
import { DateField } from "../../../../components/DateField";
import { PickerModal } from "../../../../components/PickerModal";
import { partnerDisplayName } from "../../../b2b-referrals/index";

const STATUSES: InvoiceStatus[] = ["draft", "sent", "paid", "overdue", "void"];
const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
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

type InvoiceJobCard = {
  title: string;
  is_real_estate_job: boolean;
  agency_id: string | null;
  property_id: string | null;
  referral_partner_id: string | null;
};
type InvoiceRow = Invoice & { clients: Client | null; job_cards: InvoiceJobCard | null };

function parseDate(s: string): Date | null {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateInput(d: Date | null): string {
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function InvoiceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";

  const { data, loading, error, refetch } = useSupabaseFetch(async () => {
    const [{ data: invoice, error: invoiceError }, { data: items, error: itemsError }] = await Promise.all([
      supabase
        .from("invoices")
        .select("*, clients(*), job_cards!invoices_job_card_id_fkey(title, is_real_estate_job, agency_id, property_id, referral_partner_id)")
        .eq("id", id)
        .single(),
      supabase.from("invoice_line_items").select("*").eq("invoice_id", id).order("sort_order"),
    ]);
    if (invoiceError) throw invoiceError;
    if (itemsError) throw itemsError;
    return { invoice: invoice as InvoiceRow, items: (items ?? []) as LineItemFormInput[] };
  }, [id, isOnline]);

  const jobCard = data?.invoice.job_cards;
  const { data: agency } = useSupabaseFetch<Agency | null>(async () => {
    if (!isOnline || !jobCard?.agency_id) return null;
    const { data, error } = await supabase.from("agencies").select("*").eq("id", jobCard.agency_id).single();
    if (error) throw error;
    return data as Agency;
  }, [isOnline, jobCard?.agency_id]);
  const { data: property } = useSupabaseFetch<Property | null>(async () => {
    if (!isOnline || !jobCard?.property_id) return null;
    const { data, error } = await supabase.from("properties").select("*").eq("id", jobCard.property_id).single();
    if (error) throw error;
    return data as Property;
  }, [isOnline, jobCard?.property_id]);
  const { data: referralPartners } = useSupabaseFetch<ReferralPartner[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("referral_partners").select("*").order("contact_first_name");
    if (error) throw error;
    return data as ReferralPartner[];
  }, [isOnline]);
  const [referralPickerVisible, setReferralPickerVisible] = useState(false);
  const currentReferralPartner = (referralPartners ?? []).find((p) => p.id === jobCard?.referral_partner_id) ?? null;

  // No referral_partner_id column of its own on invoices - this writes
  // through to the linked job_card, same field JobDetail edits directly
  // (see the desktop equivalent's own comment on why).
  const handleSelectReferralPartner = async (partner: ReferralPartner | null) => {
    if (!data?.invoice.job_card_id) return;
    const { error } = await supabase
      .from("job_cards")
      .update({ referral_partner_id: partner?.id ?? null })
      .eq("id", data.invoice.job_card_id);
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
      const { error } = await supabase.from("invoices").update({ po_number: poNumberInput.trim() || null }).eq("id", id);
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
  const [dueDate, setDueDate] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [sendEmailError, setSendEmailError] = useState<string | null>(null);
  const [billToModalVisible, setBillToModalVisible] = useState(false);
  const [billToSaving, setBillToSaving] = useState(false);
  const [billToError, setBillToError] = useState<string | null>(null);
  const [generatingPaymentLink, setGeneratingPaymentLink] = useState(false);
  const [paymentLinkError, setPaymentLinkError] = useState<string | null>(null);
  const [syncingXero, setSyncingXero] = useState(false);
  const [xeroSyncError, setXeroSyncError] = useState<string | null>(null);

  // Mirrors apps/desktop/src/pages/InvoiceDetail.tsx's syncToXero mutation
  // (Phase 1, one-way push) - same xero-sync Edge Function call.
  const handleSyncToXero = async () => {
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl) {
      setXeroSyncError("Supabase URL not configured");
      return;
    }
    setSyncingXero(true);
    setXeroSyncError(null);
    try {
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
      await refetch();
    } catch (e) {
      console.error("[Invoices] Failed to sync to Xero", e);
      setXeroSyncError(getErrorMessage(e, "Failed to sync to Xero"));
    } finally {
      setSyncingXero(false);
    }
  };

  // Stripe Checkout link - regenerated by the same "approve" Edge
  // Function that serves the public approval page, so the link stays
  // valid against whatever Stripe secret is configured server-side (see
  // docs/SETUP.md). Mirrors apps/desktop/src/pages/InvoiceDetail.tsx's
  // generatePaymentLink mutation.
  const handleGeneratePaymentLink = async () => {
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const approvalPageUrl = process.env.EXPO_PUBLIC_APPROVAL_PAGE_URL;
    if (!supabaseUrl) {
      setPaymentLinkError("Supabase URL not configured");
      return;
    }
    setGeneratingPaymentLink(true);
    setPaymentLinkError(null);
    try {
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
      await refetch();
    } catch (e) {
      console.error("[Invoices] Failed to create payment link", e);
      setPaymentLinkError(getErrorMessage(e, "Failed to create payment link (see console for details)"));
    } finally {
      setGeneratingPaymentLink(false);
    }
  };

  const handleSetBillToLandlord = async (billToLandlord: boolean) => {
    setBillToSaving(true);
    setBillToError(null);
    try {
      const { error } = await supabase.from("invoices").update({ bill_to_landlord: billToLandlord }).eq("id", id);
      if (error) throw error;
      await refetch();
      setBillToModalVisible(false);
    } catch (e) {
      setBillToError(getErrorMessage(e, "Failed to update billing recipient"));
    } finally {
      setBillToSaving(false);
    }
  };

  // Once the client has actually responded, the line items/totals are
  // locked at the database level too (see the accepted case's trigger in
  // supabase/migrations/20260728000100_quote_invoice_approval.sql) - the
  // editor is hidden for "declined" as well so the admin doesn't edit a
  // document the client has already seen and responded to without
  // re-sending it, even though only "accepted" is hard-enforced in
  // Postgres.
  const isLocked = data?.invoice.approval_status === "accepted" || data?.invoice.approval_status === "declined";

  useEffect(() => {
    if (data) {
      setLineItems(data.items);
      setNotes(data.invoice.notes ?? "");
      setDueDate(parseDate(data.invoice.due_date ?? ""));
    }
  }, [data]);

  const handleStatusChange = async (status: InvoiceStatus) => {
    await supabase.from("invoices").update({ status }).eq("id", id);
    refetch();
  };

  const handleSave = async () => {
    if (!profile) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { error: updateError } = await supabase
        .from("invoices")
        .update({ notes: notes || null, due_date: toDateInput(dueDate) || null })
        .eq("id", id);
      if (updateError) throw updateError;

      // Atomic: replaces this invoice's line items and recomputes its
      // subtotal/gst/total from them in one transaction (see
      // supabase/migrations/20260721000100_atomic_line_item_rpcs.sql),
      // instead of the old two-call delete-then-insert that could leave an
      // invoice with no line items if the second call failed.
      const { error: rpcError } = await supabase.rpc("replace_invoice_line_items", {
        p_invoice_id: id,
        p_items: lineItems,
      });
      if (rpcError) throw rpcError;

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
      if (!data.invoice.clients) throw new Error("This invoice has no client on file");

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
      const html = buildInvoicePdfHtml({
        tenant: tenant as Tenant,
        invoice: data.invoice,
        client: data.invoice.clients,
        lineItems,
        agencyBilling,
      });
      await exportPdf(html, `Invoice ${data.invoice.invoice_number}`);
    } catch (e) {
      console.error("[Invoices] Failed to export PDF", e);
      setExportError(getErrorMessage(e, "Failed to export PDF (see console for details)"));
    } finally {
      setExporting(false);
    }
  };

  // Generates the token if one doesn't exist yet (idempotent - see
  // generate_invoice_approval_link), then hands the resulting link
  // straight to the native Share sheet - a manual fallback for when the
  // client has no email on file, or the admin would rather text/WhatsApp
  // it themselves. handleSendInvoiceEmail below is the real "send it"
  // action.
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
      const { data: token, error: rpcError } = await supabase.rpc("generate_invoice_approval_link", {
        p_invoice_id: id,
      });
      if (rpcError) throw rpcError;

      const url = `${approvalPageUrl}?type=invoice&token=${token}`;
      await Share.share({ message: `Please review and approve this invoice: ${url}` });
      refetch();
    } catch (e) {
      console.error("[Invoices] Failed to generate approval link", e);
      setLinkError(getErrorMessage(e, "Failed to generate approval link (see console for details)"));
    } finally {
      setGeneratingLink(false);
    }
  };

  // Split into openSendEmail (prefill the composer) + handleSendEmail
  // (the composer's onSend, actually queues+dispatches) - mirrors
  // apps/desktop/src/pages/InvoiceDetail.tsx's identical split, replacing
  // the old one-tap "fire the template unedited" send.
  const [emailModalVisible, setEmailModalVisible] = useState(false);
  const [emailDefaults, setEmailDefaults] = useState({ subject: "", body: "" });
  const [emailDefaultAttachments, setEmailDefaultAttachments] = useState<EmailAttachment[]>([]);
  const [invoiceTemplate, setInvoiceTemplate] = useState<EmailTemplateOption | null>(null);
  const [openingEmail, setOpeningEmail] = useState(false);
  const { data: clientContacts } = useSupabaseFetch<ClientContact[]>(async () => {
    if (!isOnline || !data?.invoice.client_id) return [];
    const { data: rows, error } = await supabase.from("client_contacts").select("*").eq("client_id", data.invoice.client_id);
    if (error) throw error;
    return rows as ClientContact[];
  }, [isOnline, data?.invoice.client_id]);

  const invoiceRecipientEmail =
    data?.invoice.bill_to_landlord && property?.owner_landlord_email ? property.owner_landlord_email : (data?.invoice.clients?.email ?? "");
  const recipientOptions = collectRecipientEmails({
    clientEmail: data?.invoice.clients?.email,
    contactEmails: [...(clientContacts ?? []).map((c) => c.email), property?.owner_landlord_email ?? null, property?.tenant_email ?? null],
  });

  const openSendEmail = async () => {
    if (!data || !profile || !data.invoice.clients) return;
    if (!invoiceRecipientEmail) {
      setSendEmailError(
        data.invoice.bill_to_landlord
          ? "This invoice is set to bill the landlord, but no landlord email is on file - add one on the property's Access & Contacts tab, or switch 'Billed to' back to the agency."
          : "This client has no email address on file - add one on the Client Details screen."
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
      setInvoiceTemplate({ id: template.id, name: template.name, subject: template.subject ?? "", body: template.body });

      const { data: tenantRow } = await supabase.from("tenants").select("*").eq("id", profile.tenant_id).single();
      const tenant = tenantRow as Tenant;

      // Render tags against this specific client/invoice before showing the
      // composer - same fix as desktop's InvoiceDetail.tsx, safe for the
      // same reason (process-scheduled-comms always re-renders at actual
      // send time regardless - see that function's own comment).
      const previewApprovalPageUrl = process.env.EXPO_PUBLIC_APPROVAL_PAGE_URL;
      let previewApprovalLink: string | null = null;
      if (previewApprovalPageUrl) {
        const { data: token } = await supabase.rpc("generate_invoice_approval_link", { p_invoice_id: id });
        if (token) previewApprovalLink = `${previewApprovalPageUrl}?type=invoice&token=${token}`;
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
        client: { name: data.invoice.clients.name, phone: data.invoice.clients.phone, email: data.invoice.clients.email },
        invoice: {
          invoice_number: data.invoice.invoice_number,
          total_cents: data.invoice.total_cents,
          due_date: data.invoice.due_date,
          payment_link: previewApprovalLink,
        },
      };
      setEmailDefaults({
        subject: template.subject ? renderTemplate(template.subject, renderContext) : "",
        body: renderTemplate(template.body, renderContext),
      });

      // Best-effort PDF auto-attach - a generation failure still lets the
      // email send without it, same as desktop.
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
        const html = buildInvoicePdfHtml({ tenant: tenant as Tenant, invoice: data.invoice, client: data.invoice.clients, lineItems, agencyBilling });
        const pdfDataUri = await buildPdfDataUri(html);
        setEmailDefaultAttachments([{ filename: `Invoice ${data.invoice.invoice_number}.pdf`, content: pdfDataUri }]);
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
        entity_type: "invoice",
        entity_id: id,
        trigger_key: "invoice_sent",
        template_id: invoiceTemplate?.id ?? null,
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

    const { error: statusError } = await supabase.from("invoices").update({ status: "sent" }).eq("id", id);
    if (statusError) throw statusError;

    refetch();
    setSendEmailError(null);
    Alert.alert(
      wasSent ? "Sent" : "Queued",
      wasSent ? "The invoice email has been sent." : "The invoice is marked sent and the email is queued - it'll go out shortly."
    );
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Invoices" />
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
      <Text style={styles.title}>{data.invoice.invoice_number}</Text>
      <Text style={styles.subtitle}>{data.invoice.clients?.name ?? "Unknown client"}</Text>
      {data.invoice.job_cards ? (
        <Pressable onPress={() => router.push(`/sales/jobs/${data.invoice.job_card_id}`)}>
          <Text style={styles.link}>Job: {data.invoice.job_cards.title}</Text>
        </Pressable>
      ) : null}

      {jobCard?.is_real_estate_job && agency ? (
        <Pressable onPress={() => { setBillToError(null); setBillToModalVisible(true); }}>
          <Text style={styles.link}>
            Billed to: {data.invoice.bill_to_landlord ? (property?.owner_landlord_name ?? "Landlord (name not on file)") : `${agency.name}${data.invoice.clients ? ` (${data.invoice.clients.name})` : ""}`} - Change
          </Text>
        </Pressable>
      ) : null}

      {jobCard ? (
        <View style={styles.referralRow}>
          <Text style={styles.sectionTitle}>Referral source: {currentReferralPartner ? partnerDisplayName(currentReferralPartner) : "None"}</Text>
          <Pressable onPress={() => setReferralPickerVisible(true)}>
            <Text style={styles.linkButtonText}>{jobCard.referral_partner_id ? "Edit" : "+ Add"}</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.referralRow}>
        <Text style={styles.sectionTitle}>PO number: {data.invoice.po_number ?? "Not set"}</Text>
        <Pressable
          onPress={() => {
            setPoNumberInput(data.invoice.po_number ?? "");
            setPoError(null);
            setPoModalVisible(true);
          }}
        >
          <Text style={styles.linkButtonText}>{data.invoice.po_number ? "Edit" : "+ Add"}</Text>
        </Pressable>
      </View>

      {data.invoice.approval_status ? (
        <View
          style={[
            styles.approvalBadge,
            data.invoice.approval_status === "accepted" && styles.approvalBadgeAccepted,
            data.invoice.approval_status === "declined" && styles.approvalBadgeDeclined,
          ]}
        >
          <Text
            style={[
              styles.approvalBadgeText,
              data.invoice.approval_status === "accepted" && styles.approvalBadgeTextAccepted,
              data.invoice.approval_status === "declined" && styles.approvalBadgeTextDeclined,
            ]}
          >
            {APPROVAL_STATUS_LABELS[data.invoice.approval_status]}
          </Text>
        </View>
      ) : null}
      {data.invoice.approval_status === "declined" && data.invoice.decline_reason ? (
        <Text style={styles.declineReason}>Reason: {data.invoice.decline_reason}</Text>
      ) : null}

      {isAdmin ? (
        <Pressable style={styles.sendEmailButton} onPress={openSendEmail} disabled={openingEmail}>
          <Text style={styles.sendEmailButtonText}>{openingEmail ? "Preparing..." : "Send Invoice via Email"}</Text>
        </Pressable>
      ) : null}
      {sendEmailError ? <Text style={styles.error}>{sendEmailError}</Text> : null}

      {isAdmin ? (
        <Pressable style={styles.linkButton} onPress={handleGenerateAndShareLink} disabled={generatingLink}>
          <Text style={styles.linkButtonText}>
            {generatingLink ? "Generating..." : data.invoice.access_token ? "Share approval link" : "Generate & share approval link"}
          </Text>
        </Pressable>
      ) : null}
      {linkError ? <Text style={styles.error}>{linkError}</Text> : null}

      {data.invoice.approval_status === "accepted" && data.invoice.status !== "paid" ? (
        <View style={styles.paymentLinkCard}>
          <Text style={styles.paymentLinkTitle}>Stripe payment link</Text>
          {data.invoice.stripe_checkout_url ? (
            <View style={styles.paymentLinkRow}>
              <Pressable onPress={() => Linking.openURL(data.invoice.stripe_checkout_url!)}>
                <Text style={styles.link}>Open payment page →</Text>
              </Pressable>
              <Pressable onPress={() => Share.share({ message: data.invoice.stripe_checkout_url! })}>
                <Text style={styles.link}>Share link</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={handleGeneratePaymentLink} disabled={generatingPaymentLink}>
              <Text style={styles.link}>{generatingPaymentLink ? "Generating..." : "Generate payment link"}</Text>
            </Pressable>
          )}
          {paymentLinkError ? <Text style={styles.error}>{paymentLinkError}</Text> : null}
        </View>
      ) : null}

      {data.invoice.status !== "draft" ? (
        <View style={styles.xeroCard}>
          <Text style={styles.xeroCardTitle}>Xero</Text>
          {data.invoice.xero_synced_at ? (
            <Text style={styles.xeroMeta}>
              Last synced {new Date(data.invoice.xero_synced_at).toLocaleString("en-AU")}
              {data.invoice.xero_invoice_id ? (
                <>
                  {" - "}
                  <Text
                    style={styles.link}
                    onPress={() =>
                      Linking.openURL(`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${data.invoice.xero_invoice_id}`)
                    }
                  >
                    View in Xero
                  </Text>
                </>
              ) : null}
            </Text>
          ) : null}
          <Pressable onPress={handleSyncToXero} disabled={syncingXero} style={styles.xeroSyncButton}>
            <Text style={styles.xeroSyncButtonText}>
              {syncingXero ? "Syncing..." : data.invoice.xero_synced_at ? "Re-sync to Xero" : "Sync to Xero"}
            </Text>
          </Pressable>
          {(xeroSyncError || data.invoice.xero_sync_error) ? (
            <Text style={styles.error}>{xeroSyncError || data.invoice.xero_sync_error}</Text>
          ) : null}
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>Status</Text>
      <View style={styles.statusRow}>
        {STATUSES.map((status) => (
          <Pressable
            key={status}
            style={[styles.statusChip, data.invoice.status === status && styles.statusChipActive]}
            onPress={() => handleStatusChange(status)}
          >
            <Text style={[styles.statusChipText, data.invoice.status === status && styles.statusChipTextActive]}>
              {STATUS_LABELS[status]}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.fieldSpacing}>
        <DateField label="Due date" value={dueDate} onChange={setDueDate} mode="date" placeholder="No due date" />
      </View>

      <Text style={styles.sectionTitle}>Line items</Text>
      {isLocked ? (
        <Text style={styles.lockedNotice}>
          This invoice has been {data.invoice.approval_status} by the client and its line items are now read-only.
        </Text>
      ) : null}
      {isAdmin && !isLocked ? (
        <LineItemEditor
          items={lineItems}
          onChange={setLineItems}
          membershipDiscountCents={data.invoice.membership_discount_cents}
          tenantId={profile?.tenant_id ?? ""}
        />
      ) : (
        <LineItemSummary items={lineItems} membershipDiscountCents={data.invoice.membership_discount_cents} />
      )}

      <View style={styles.fieldSpacing}>
        <FormField label="Notes" placeholder="Payment terms, etc." value={notes} onChangeText={setNotes} multiline style={styles.multiline} editable={isAdmin && !isLocked} />
      </View>

      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}

      {isAdmin && !isLocked ? (
        <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
          <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save changes"}</Text>
        </Pressable>
      ) : null}

      {exportError ? <Text style={styles.error}>{exportError}</Text> : null}
      <Pressable style={styles.exportButton} onPress={handleExportPdf} disabled={exporting}>
        <Text style={styles.exportButtonText}>{exporting ? "Preparing PDF..." : "Export PDF"}</Text>
      </Pressable>
    </ScrollView>

    <CenteredModal visible={billToModalVisible} onClose={() => setBillToModalVisible(false)}>
      <Text style={styles.modalTitle}>Who is this invoice billed to?</Text>
      <Pressable
        style={[styles.billToOption, !data.invoice.bill_to_landlord && styles.billToOptionActive]}
        onPress={() => handleSetBillToLandlord(false)}
        disabled={billToSaving}
      >
        <Text style={styles.billToOptionTitle}>Agency / Property Manager</Text>
        <Text style={styles.billToOptionMeta}>
          {agency?.name}
          {data.invoice.clients ? ` - ${data.invoice.clients.name}` : ""}
        </Text>
      </Pressable>
      <Pressable
        style={[styles.billToOption, data.invoice.bill_to_landlord && styles.billToOptionActive]}
        onPress={() => handleSetBillToLandlord(true)}
        disabled={billToSaving}
      >
        <Text style={styles.billToOptionTitle}>Landlord / Owner</Text>
        {property?.owner_landlord_name || property?.owner_landlord_email ? (
          <Text style={styles.billToOptionMeta}>
            {property.owner_landlord_name}
            {property.owner_landlord_email ? ` - ${property.owner_landlord_email}` : ""}
          </Text>
        ) : (
          <Text style={styles.billToOptionMeta}>No landlord contact on file yet - add one from the desktop app first.</Text>
        )}
      </Pressable>
      {billToError ? <Text style={styles.error}>{billToError}</Text> : null}
      <Pressable onPress={() => setBillToModalVisible(false)}>
        <Text style={styles.link}>Close</Text>
      </Pressable>
    </CenteredModal>

    <EmailComposeModal
      visible={emailModalVisible}
      onClose={() => setEmailModalVisible(false)}
      title="Send invoice"
      defaultTo={invoiceRecipientEmail}
      defaultSubject={emailDefaults.subject}
      defaultBody={emailDefaults.body}
      defaultAttachments={emailDefaultAttachments}
      recipientOptions={recipientOptions}
      onSend={handleSendEmail}
      sendLabel="Send invoice"
    />

    <CenteredModal visible={poModalVisible} onClose={() => setPoModalVisible(false)}>
      <Text style={styles.modalTitle}>PO number</Text>
      <FormField label="PO number" placeholder="e.g. PO-4821" value={poNumberInput} onChangeText={setPoNumberInput} />
      {poError ? <Text style={styles.error}>{poError}</Text> : null}
      <View style={styles.modalActions}>
        <Pressable onPress={() => setPoModalVisible(false)}>
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.saveButton} onPress={handleSavePoNumber} disabled={poSaving}>
          <Text style={styles.saveButtonText}>{poSaving ? "Saving..." : "Save"}</Text>
        </Pressable>
      </View>
    </CenteredModal>

    <PickerModal
      visible={referralPickerVisible}
      title="Referral source"
      items={[null, ...(referralPartners ?? [])]}
      getKey={(p) => p?.id ?? "none"}
      getLabel={(p) => (p ? partnerDisplayName(p) : "None")}
      onSelect={handleSelectReferralPartner}
      onClose={() => setReferralPickerVisible(false)}
    />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  title: { fontSize: 20, fontWeight: "700" },
  subtitle: { color: "#6b7280", marginTop: 2 },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginTop: 16, marginBottom: 6 },
  referralRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: "#f3f4f6" },
  statusChipActive: { backgroundColor: "#1d4ed8" },
  statusChipText: { color: "#374151", fontWeight: "600" },
  statusChipTextActive: { color: "#fff" },
  fieldSpacing: { marginTop: 16 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  error: { color: "#dc2626", marginTop: 12 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 16 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  billToOption: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, padding: 12, marginTop: 8 },
  billToOptionActive: { borderColor: "#1d4ed8", backgroundColor: "#eff6ff" },
  billToOptionTitle: { fontSize: 14, fontWeight: "700", color: "#111827" },
  billToOptionMeta: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  paymentLinkCard: { marginTop: 12, borderWidth: 1, borderColor: "#bbf7d0", backgroundColor: "#f0fdf4", borderRadius: 8, padding: 12, gap: 4 },
  paymentLinkTitle: { fontSize: 11, fontWeight: "700", color: "#15803d", textTransform: "uppercase" },
  paymentLinkRow: { flexDirection: "row", gap: 16 },
  xeroCard: { marginTop: 12, borderWidth: 1, borderColor: "#bfdbfe", backgroundColor: "#eff6ff", borderRadius: 8, padding: 12, gap: 4 },
  xeroCardTitle: { fontSize: 11, fontWeight: "700", color: "#1e40af", textTransform: "uppercase" },
  xeroMeta: { fontSize: 12, color: "#6b7280" },
  xeroSyncButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, alignSelf: "flex-start", marginTop: 4 },
  xeroSyncButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
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
  exportButton: { borderRadius: 8, padding: 14, alignItems: "center", marginTop: 12, backgroundColor: "#f3f4f6" },
  exportButtonText: { color: "#1d4ed8", fontWeight: "700", fontSize: 16 },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
  link: { color: "#1d4ed8", fontWeight: "600", marginTop: 4 },
});

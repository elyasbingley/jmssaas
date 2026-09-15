import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { decode as decodeBase64 } from "base64-arraybuffer";
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
import { supabase } from "../../../lib/supabase";
import { useIsOnline } from "../../../lib/connectivity";
import { useAuth } from "../../../lib/auth-context";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../../lib/errors";
import { triggerImmediateDispatch } from "../../../lib/dispatch-now";
import { buildPdfDataUri, exportPdf } from "../../../lib/print";
import { buildPurchaseOrderPdfHtml } from "../../../lib/po-pdf";
import { ThemedRequiresConnectionNotice } from "../../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedPickerModal } from "../../../components/theme/ThemedPickerModal";
import { ThemedButton } from "../../../components/theme/ThemedButton";
import { PoLineItemEditor } from "../../../components/PoLineItemEditor";

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

export default function PurchaseOrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isOnline = useIsOnline();
  const { profile } = useAuth();
  const styles = useThemedStyles(createStyles);

  const { data: po, refetch: refetchPo } = useSupabaseFetch<PurchaseOrder | null>(async () => {
    if (!isOnline) return null;
    const { data, error } = await supabase.from("purchase_orders").select("*").eq("id", id).single();
    if (error) throw error;
    return data as PurchaseOrder;
  }, [isOnline, id]);
  const { data: tenant } = useSupabaseFetch<Tenant | null>(async () => {
    if (!isOnline || !profile) return null;
    const { data, error } = await supabase.from("tenants").select("*").eq("id", profile.tenant_id).single();
    if (error) throw error;
    return data as Tenant;
  }, [isOnline, profile?.tenant_id]);
  const { data: subcontractor } = useSupabaseFetch<SubcontractorCompany | null>(async () => {
    if (!isOnline || !po) return null;
    const { data, error } = await supabase.from("subcontractor_companies").select("*").eq("id", po.subcontractor_id).single();
    if (error) throw error;
    return data as SubcontractorCompany;
  }, [isOnline, po?.subcontractor_id]);
  const { data: contacts } = useSupabaseFetch<SubcontractorContact[]>(async () => {
    if (!isOnline || !po) return [];
    const { data, error } = await supabase.from("subcontractor_contacts").select("*").eq("subcontractor_id", po.subcontractor_id).order("first_name");
    if (error) throw error;
    return data as SubcontractorContact[];
  }, [isOnline, po?.subcontractor_id]);
  const { data: job } = useSupabaseFetch<(JobCard & { clients: Client | null }) | null>(async () => {
    if (!isOnline || !po) return null;
    const { data, error } = await supabase.from("job_cards").select("*, clients(*)").eq("id", po.job_card_id).single();
    if (error) throw error;
    return data as JobCard & { clients: Client | null };
  }, [isOnline, po?.job_card_id]);

  const [lineItems, setLineItems] = useState<PoLineItemInput[]>([]);
  const [billedCents, setBilledCents] = useState("");
  const [contactId, setContactId] = useState("");
  const [contactPickerVisible, setContactPickerVisible] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (po) {
      setLineItems(po.line_items);
      setBilledCents(po.billed_to_client_cents != null ? String(po.billed_to_client_cents / 100) : "");
      setContactId(po.contact_id ?? "");
    }
  }, [po]);

  const isLocked = po?.status === "cancelled";
  const complianceHold = subcontractor?.status === "compliance_hold";
  const recipientContact = (contacts ?? []).find((c) => c.id === contactId) ?? (contacts ?? []).find((c) => c.is_primary_contact) ?? (contacts ?? [])[0];

  const save = async () => {
    setSaving(true);
    setSaveError(null);
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
    setSaving(false);
    if (error) {
      setSaveError(getErrorMessage(error, "Failed to save"));
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
    refetchPo();
  };

  const changeStatus = async (status: PurchaseOrderStatus) => {
    const patch: Record<string, unknown> = { status };
    if (status === "paid") patch.paid_at = new Date().toISOString();
    const { error } = await supabase.from("purchase_orders").update(patch).eq("id", id);
    if (!error) refetchPo();
  };

  const sendQuoteRequest = async () => {
    if (!po || !profile) return;
    if (complianceHold) {
      setSendError("This subcontractor is on compliance hold.");
      return;
    }
    if (!recipientContact?.email) {
      setSendError("This subcontractor has no contact with an email address - add one first.");
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const { error: linkError } = await supabase.rpc("generate_po_quote_link", { p_po_id: id });
      if (linkError) throw linkError;

      const { data: rule } = await supabase
        .from("communication_rules")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "subcontractor_quote_request")
        .maybeSingle();
      if (!rule || !rule.is_enabled) throw new Error("The 'Subcontractor Quote Request' email is turned off in Settings > Automation & Messaging");
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

      setSendResult(wasSent ? "Quote request email sent." : "Quote request is marked sent and the email is queued.");
      setTimeout(() => setSendResult(null), 5000);
      refetchPo();
    } catch (e) {
      setSendError(getErrorMessage(e, "Failed to send"));
    } finally {
      setSending(false);
    }
  };

  const sendWorkOrder = async () => {
    if (!po || !profile || !tenant || !subcontractor || !job) return;
    if (complianceHold) {
      setSendError("This subcontractor is on compliance hold.");
      return;
    }
    if (!recipientContact?.email) {
      setSendError("This subcontractor has no contact with an email address - add one first.");
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const html = buildPurchaseOrderPdfHtml({
        tenant,
        po,
        subcontractor,
        jobTitle: job.title,
        siteAddress: job.clients ? [job.clients.address_line1, job.clients.suburb].filter(Boolean).join(", ") || null : null,
        lineItems,
      });
      const dataUri = await buildPdfDataUri(html);
      const base64 = dataUri.split(",")[1] ?? "";
      const storagePath = `${profile.tenant_id}/${id}/${po.po_number ?? id}.pdf`;
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, decodeBase64(base64), {
        contentType: "application/pdf",
        upsert: true,
      });
      if (uploadError) throw uploadError;

      const { error: pathError } = await supabase.from("purchase_orders").update({ pdf_storage_path: storagePath }).eq("id", id);
      if (pathError) throw pathError;

      const { data: rule } = await supabase
        .from("communication_rules")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "subcontractor_work_order")
        .maybeSingle();
      if (!rule || !rule.is_enabled) throw new Error("The 'Subcontractor Work Order' email is turned off in Settings > Automation & Messaging");
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

      setSendResult(wasSent ? "Work order PDF compiled and emailed." : "Work order PDF compiled; email is queued.");
      setTimeout(() => setSendResult(null), 5000);
      refetchPo();
    } catch (e) {
      setSendError(getErrorMessage(e, "Failed to send"));
    } finally {
      setSending(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!po || !tenant || !subcontractor || !job) return;
    setDownloading(true);
    try {
      const html = buildPurchaseOrderPdfHtml({
        tenant,
        po,
        subcontractor,
        jobTitle: job.title,
        siteAddress: job.clients ? [job.clients.address_line1, job.clients.suburb].filter(Boolean).join(", ") || null : null,
        lineItems,
      });
      await exportPdf(html, po.po_number ?? "Purchase order");
    } finally {
      setDownloading(false);
    }
  };

  const marginCents = billedCents && po ? Math.round(parseFloat(billedCents) * 100) - po.total_cost_cents : null;

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.link}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{po?.po_number ?? "Purchase Order"}</Text>
      </View>

      {!isOnline ? (
        <ThemedRequiresConnectionNotice label="Purchase orders" />
      ) : !po ? (
        <View style={styles.center}>
          <Text style={styles.empty}>Loading...</Text>
        </View>
      ) : (
        <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
          <Pressable onPress={() => router.push(`/subcontractors/${po.subcontractor_id}`)}>
            <Text style={styles.backLink}>&larr; Back to {subcontractor?.company_name ?? "subcontractor"}</Text>
          </Pressable>

          <View style={styles.headerRow}>
            <Text style={styles.heading}>{po.po_number ?? "Pending PO number"}</Text>
            <View style={styles.typeBadge}>
              <Text style={styles.typeBadgeText}>{po.is_quote_request ? "Quote Request" : "Work Order"}</Text>
            </View>
          </View>
          {job ? (
            <Pressable onPress={() => router.push(`/jobs/${po.job_card_id}`)}>
              <Text style={styles.link}>Job: {job.title}</Text>
            </Pressable>
          ) : null}

          {complianceHold ? <Text style={styles.holdNotice}>This subcontractor is on compliance hold - sending is disabled.</Text> : null}

          <Text style={styles.sectionHeading}>Status</Text>
          <View style={styles.statusRow}>
            {STATUSES.map((status) => (
              <Pressable
                key={status}
                style={[styles.statusChip, po.status === status && styles.statusChipActive]}
                onPress={() => changeStatus(status)}
              >
                <Text style={[styles.statusChipText, po.status === status && styles.statusChipTextActive]}>{STATUS_LABELS[status]}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.actionsRow}>
            {po.is_quote_request ? (
              <View style={styles.flex1}>
                <ThemedButton label={sending ? "Sending..." : "Send Quote Request"} onPress={sendQuoteRequest} disabled={sending || complianceHold} />
              </View>
            ) : (
              <View style={styles.flex1}>
                <ThemedButton label={sending ? "Sending..." : "Send Work Order"} onPress={sendWorkOrder} disabled={sending || complianceHold} />
              </View>
            )}
            <Pressable style={styles.secondaryButton} onPress={handleDownloadPdf} disabled={downloading}>
              <Text style={styles.secondaryButtonText}>{downloading ? "Preparing..." : "Download PDF"}</Text>
            </Pressable>
          </View>
          {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
          {sendResult ? <Text style={styles.saved}>{sendResult}</Text> : null}

          <Pressable style={[styles.pickerField, styles.fieldSpacing]} onPress={() => !isLocked && setContactPickerVisible(true)}>
            <Text style={styles.pickerFieldLabel}>Contact</Text>
            <Text style={styles.pickerFieldValue}>
              {recipientContact ? `${recipientContact.first_name} ${recipientContact.last_name ?? ""} - ${recipientContact.email}` : "Use primary contact"}
            </Text>
          </Pressable>

          <Text style={styles.sectionHeading}>{po.is_quote_request ? "Scope of work" : "Line items"}</Text>
          <PoLineItemEditor items={lineItems} onChange={setLineItems} readOnly={isLocked} />

          <View style={styles.fieldSpacing}>
            <Text style={styles.fieldLabel}>Client billed price (optional)</Text>
            <TextInput
              editable={!isLocked}
              keyboardType="decimal-pad"
              value={billedCents}
              onChangeText={setBilledCents}
              placeholder="What the client is charged for this work"
              placeholderTextColor={styles.placeholder.color}
              style={[styles.textInput, isLocked && styles.textInputDisabled]}
            />
            {marginCents != null ? (
              <Text style={[styles.marginText, marginCents < 0 && styles.marginNegative]}>Margin: {formatCentsAsAud(marginCents)}</Text>
            ) : null}
          </View>

          {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
          {saved ? <Text style={styles.saved}>Saved.</Text> : null}

          {!isLocked ? (
            <View style={{ marginTop: 20 }}>
              <ThemedButton label={saving ? "Saving..." : "Save changes"} onPress={save} disabled={saving} />
            </View>
          ) : null}

          <ThemedPickerModal
            visible={contactPickerVisible}
            title="Select contact"
            items={contacts ?? []}
            getKey={(c) => c.id}
            getLabel={(c) => `${c.first_name} ${c.last_name ?? ""} ${c.is_primary_contact ? "(Primary)" : ""} - ${c.email}`}
            onSelect={(c) => setContactId(c.id)}
            onClose={() => setContactPickerVisible(false)}
          />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
    title: { ...mono, fontSize: font.title, fontWeight: "700" as const, color: tokens.textPrimary, flexShrink: 1 },
    container: { flex: 1, backgroundColor: tokens.background },
    center: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const },
    flex1: { flex: 1 },
    empty: { ...mono, color: tokens.textMuted, fontSize: font.body },
    backLink: { ...mono, color: tokens.accent, fontWeight: "600" as const, marginBottom: 12, fontSize: font.body },
    headerRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    heading: { ...mono, fontSize: font.title, fontWeight: "700" as const, color: tokens.textPrimary },
    typeBadge: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
    typeBadgeText: { ...mono, fontSize: font.label, fontWeight: "700" as const, color: tokens.textMuted },
    link: { ...mono, color: tokens.accent, fontWeight: "600" as const, marginTop: 4, fontSize: font.body },
    holdNotice: { ...mono, color: tokens.danger, borderWidth: 1, borderColor: tokens.danger, backgroundColor: tokens.surface, borderRadius: 4, padding: 10, fontSize: font.label, marginTop: 12 },
    sectionHeading: { ...mono, fontSize: font.label, fontWeight: "700" as const, color: tokens.accent, textTransform: "uppercase" as const, letterSpacing: 1, marginTop: 20, marginBottom: 10 },
    statusRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    statusChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 4, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface },
    statusChipActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    statusChipText: { ...mono, color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.label },
    statusChipTextActive: { color: tokens.accent },
    actionsRow: { flexDirection: "row" as const, gap: 10, marginTop: 16, alignItems: "stretch" as const },
    secondaryButton: { flex: 1, borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, alignItems: "center" as const, justifyContent: "center" as const },
    secondaryButtonText: { ...mono, color: tokens.accent, fontWeight: "700" as const, fontSize: font.button, letterSpacing: 1, textTransform: "uppercase" as const },
    error: { ...mono, color: tokens.danger, marginTop: 8, fontSize: font.body },
    saved: { ...mono, color: tokens.accent, marginTop: 8, fontSize: font.body },
    fieldSpacing: { marginTop: 16 },
    pickerField: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, backgroundColor: tokens.surface },
    pickerFieldLabel: { ...mono, fontSize: font.label, color: tokens.textMuted, marginBottom: 2 },
    pickerFieldValue: { ...mono, fontSize: font.body, color: tokens.textPrimary },
    fieldLabel: { ...mono, fontSize: font.label, fontWeight: "700" as const, color: tokens.accent, marginBottom: 6, textTransform: "uppercase" as const, letterSpacing: 1 },
    textInput: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, fontSize: font.body, color: tokens.textPrimary, backgroundColor: tokens.background, ...mono },
    textInputDisabled: { backgroundColor: tokens.surface },
    placeholder: { color: tokens.textMuted },
    marginText: { ...mono, fontSize: font.body, fontWeight: "700" as const, color: tokens.accent, marginTop: 8 },
    marginNegative: { color: tokens.danger },
  };
}

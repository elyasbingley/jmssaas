import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
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
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../../lib/errors";
import { triggerImmediateDispatch } from "../../../lib/dispatch-now";
import { buildPdfDataUri, exportPdf } from "../../../lib/print";
import { buildPurchaseOrderPdfHtml } from "../../../lib/po-pdf";
import { RequiresConnectionNotice } from "../../../components/RequiresConnectionNotice";
import { PickerModal } from "../../../components/PickerModal";
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

  if (!isOnline) {
    return <RequiresConnectionNotice label="Purchase orders" />;
  }
  if (!po) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  const marginCents = billedCents ? Math.round(parseFloat(billedCents) * 100) - po.total_cost_cents : null;

  return (
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
        <Pressable onPress={() => router.push(`/sales/jobs/${po.job_card_id}`)}>
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
          <Pressable style={styles.primaryButton} onPress={sendQuoteRequest} disabled={sending || complianceHold}>
            <Text style={styles.primaryButtonText}>{sending ? "Sending..." : "Send Quote Request"}</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.primaryButton} onPress={sendWorkOrder} disabled={sending || complianceHold}>
            <Text style={styles.primaryButtonText}>{sending ? "Sending..." : "Send Work Order"}</Text>
          </Pressable>
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
          style={[styles.textInput, isLocked && styles.textInputDisabled]}
        />
        {marginCents != null ? (
          <Text style={[styles.marginText, marginCents < 0 && styles.marginNegative]}>Margin: {formatCentsAsAud(marginCents)}</Text>
        ) : null}
      </View>

      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
      {saved ? <Text style={styles.saved}>Saved.</Text> : null}

      {!isLocked ? (
        <Pressable style={styles.saveButton} onPress={save} disabled={saving}>
          <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save changes"}</Text>
        </Pressable>
      ) : null}

      <PickerModal
        visible={contactPickerVisible}
        title="Select contact"
        items={contacts ?? []}
        getKey={(c) => c.id}
        getLabel={(c) => `${c.first_name} ${c.last_name ?? ""} ${c.is_primary_contact ? "(Primary)" : ""} - ${c.email}`}
        onSelect={(c) => setContactId(c.id)}
        onClose={() => setContactPickerVisible(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { color: "#6b7280" },
  backLink: { color: "#1d4ed8", fontWeight: "600", marginBottom: 12 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  heading: { fontSize: 19, fontWeight: "700", color: "#111827" },
  typeBadge: { backgroundColor: "#f3f4f6", borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  typeBadgeText: { fontSize: 11, fontWeight: "700", color: "#4b5563" },
  link: { color: "#1d4ed8", fontWeight: "600", marginTop: 4 },
  holdNotice: { color: "#b91c1c", backgroundColor: "#fef2f2", borderRadius: 8, padding: 10, fontSize: 12, marginTop: 12 },
  sectionHeading: { fontSize: 13, fontWeight: "700", color: "#6b7280", textTransform: "uppercase", marginTop: 20, marginBottom: 10 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: "#f3f4f6" },
  statusChipActive: { backgroundColor: "#1d4ed8" },
  statusChipText: { color: "#374151", fontWeight: "600", fontSize: 13 },
  statusChipTextActive: { color: "#fff" },
  actionsRow: { flexDirection: "row", gap: 10, marginTop: 16 },
  primaryButton: { flex: 1, backgroundColor: "#1d4ed8", borderRadius: 8, padding: 12, alignItems: "center" },
  primaryButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  secondaryButton: { flex: 1, borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, padding: 12, alignItems: "center" },
  secondaryButtonText: { color: "#374151", fontWeight: "700", fontSize: 13 },
  error: { color: "#dc2626", marginTop: 8 },
  saved: { color: "#15803d", marginTop: 8 },
  fieldSpacing: { marginTop: 16 },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  pickerFieldLabel: { fontSize: 12, color: "#6b7280", marginBottom: 2 },
  pickerFieldValue: { fontSize: 15, color: "#111827" },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: "#374151", marginBottom: 6 },
  textInput: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, padding: 12, fontSize: 15 },
  textInputDisabled: { backgroundColor: "#f3f4f6" },
  marginText: { fontSize: 14, fontWeight: "700", color: "#15803d", marginTop: 8 },
  marginNegative: { color: "#dc2626" },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 20 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});

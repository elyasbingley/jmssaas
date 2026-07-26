import { useEffect, useState } from "react";
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ApprovalStatus, Client, Invoice, InvoiceStatus, LineItemFormInput, Tenant } from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { useIsOnline } from "../../../../lib/connectivity";
import { useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase, supabaseUrl } from "../../../../lib/supabase";
import { getErrorMessage } from "../../../../lib/errors";
import { buildInvoicePdfHtml } from "../../../../lib/pdf";
import { exportPdf } from "../../../../lib/print";
import { RequiresConnectionNotice } from "../../../../components/RequiresConnectionNotice";
import { LineItemEditor, LineItemSummary } from "../../../../components/LineItemEditor";
import { FormField } from "../../../../components/FormField";
import { DateField } from "../../../../components/DateField";

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

type InvoiceRow = Invoice & { clients: Client | null; job_cards: { title: string } | null };

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
        .select("*, clients(*), job_cards!invoices_job_card_id_fkey(title)")
        .eq("id", id)
        .single(),
      supabase.from("invoice_line_items").select("*").eq("invoice_id", id).order("sort_order"),
    ]);
    if (invoiceError) throw invoiceError;
    if (itemsError) throw itemsError;
    return { invoice: invoice as InvoiceRow, items: (items ?? []) as LineItemFormInput[] };
  }, [id, isOnline]);

  const [lineItems, setLineItems] = useState<LineItemFormInput[]>([]);
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

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

      const html = buildInvoicePdfHtml({
        tenant: tenant as Tenant,
        invoice: data.invoice,
        client: data.invoice.clients,
        lineItems,
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
  // straight to the native Share sheet. There's no automated delivery
  // (email/SMS) yet - see docs/SETUP.md known-gaps - so the admin picks how
  // to send it themselves from whatever the Share sheet offers.
  const handleGenerateAndShareLink = async () => {
    if (!data) return;
    setGeneratingLink(true);
    setLinkError(null);
    try {
      const { data: token, error: rpcError } = await supabase.rpc("generate_invoice_approval_link", {
        p_invoice_id: id,
      });
      if (rpcError) throw rpcError;

      const url = `${supabaseUrl}/functions/v1/approve/invoice/${token}`;
      await Share.share({ message: `Please review and approve this invoice: ${url}` });
      refetch();
    } catch (e) {
      console.error("[Invoices] Failed to generate approval link", e);
      setLinkError(getErrorMessage(e, "Failed to generate approval link (see console for details)"));
    } finally {
      setGeneratingLink(false);
    }
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
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Text style={styles.title}>{data.invoice.invoice_number}</Text>
      <Text style={styles.subtitle}>{data.invoice.clients?.name ?? "Unknown client"}</Text>
      {data.invoice.job_cards ? (
        <Pressable onPress={() => router.push(`/sales/jobs/${data.invoice.job_card_id}`)}>
          <Text style={styles.link}>Job: {data.invoice.job_cards.title}</Text>
        </Pressable>
      ) : null}

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
        <Pressable style={styles.linkButton} onPress={handleGenerateAndShareLink} disabled={generatingLink}>
          <Text style={styles.linkButtonText}>
            {generatingLink ? "Generating..." : data.invoice.access_token ? "Share approval link" : "Generate & share approval link"}
          </Text>
        </Pressable>
      ) : null}
      {linkError ? <Text style={styles.error}>{linkError}</Text> : null}

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
      {isAdmin && !isLocked ? <LineItemEditor items={lineItems} onChange={setLineItems} /> : <LineItemSummary items={lineItems} />}

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

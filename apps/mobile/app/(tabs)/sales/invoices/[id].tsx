import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { Client, Invoice, InvoiceStatus, LineItemFormInput, Tenant } from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { useIsOnline } from "../../../../lib/connectivity";
import { useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../lib/supabase";
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

  const { data, loading, refetch } = useSupabaseFetch(async () => {
    const [{ data: invoice, error: invoiceError }, { data: items, error: itemsError }] = await Promise.all([
      supabase.from("invoices").select("*, clients(*), job_cards(title)").eq("id", id).single(),
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

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Invoices" />
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
      {isAdmin ? <LineItemEditor items={lineItems} onChange={setLineItems} /> : <LineItemSummary items={lineItems} />}

      <View style={styles.fieldSpacing}>
        <FormField label="Notes" placeholder="Payment terms, etc." value={notes} onChangeText={setNotes} multiline style={styles.multiline} editable={isAdmin} />
      </View>

      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}

      {isAdmin ? (
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
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 20 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  exportButton: { borderRadius: 8, padding: 14, alignItems: "center", marginTop: 12, backgroundColor: "#f3f4f6" },
  exportButtonText: { color: "#1d4ed8", fontWeight: "700", fontSize: 16 },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
  link: { color: "#1d4ed8", fontWeight: "600", marginTop: 4 },
});

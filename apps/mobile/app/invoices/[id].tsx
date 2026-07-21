import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { v4 as uuidv4 } from "uuid";
import { calculateDocumentTotals, type Invoice, type InvoiceStatus, type LineItemFormInput } from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";
import { useIsOnline } from "../../lib/connectivity";
import { useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { supabase } from "../../lib/supabase";
import { RequiresConnectionNotice } from "../../components/RequiresConnectionNotice";
import { LineItemEditor } from "../../components/LineItemEditor";

const STATUSES: InvoiceStatus[] = ["draft", "sent", "paid", "overdue", "void"];
const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
};

type InvoiceRow = Invoice & { clients: { name: string } | null };

export default function InvoiceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";

  const { data, loading, refetch } = useSupabaseFetch(async () => {
    const [{ data: invoice, error: invoiceError }, { data: items, error: itemsError }] = await Promise.all([
      supabase.from("invoices").select("*, clients(name)").eq("id", id).single(),
      supabase.from("invoice_line_items").select("*").eq("invoice_id", id).order("sort_order"),
    ]);
    if (invoiceError) throw invoiceError;
    if (itemsError) throw itemsError;
    return { invoice: invoice as InvoiceRow, items: (items ?? []) as LineItemFormInput[] };
  }, [id, isOnline]);

  const [lineItems, setLineItems] = useState<LineItemFormInput[]>([]);
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setLineItems(data.items);
      setNotes(data.invoice.notes ?? "");
      setDueDate(data.invoice.due_date ?? "");
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
      const totals = calculateDocumentTotals(lineItems);
      const { error: updateError } = await supabase
        .from("invoices")
        .update({
          notes: notes || null,
          due_date: dueDate || null,
          subtotal_cents: totals.subtotal_cents,
          gst_cents: totals.gst_cents,
          total_cents: totals.total_cents,
        })
        .eq("id", id);
      if (updateError) throw updateError;

      const { error: deleteError } = await supabase.from("invoice_line_items").delete().eq("invoice_id", id);
      if (deleteError) throw deleteError;
      const { error: insertError } = await supabase.from("invoice_line_items").insert(
        lineItems.map((item, index) => ({
          id: uuidv4(),
          tenant_id: profile.tenant_id,
          invoice_id: id,
          item_type: item.item_type,
          description: item.description,
          quantity: item.quantity,
          unit_price_cents: item.unit_price_cents,
          gst_applicable: item.gst_applicable,
          sort_order: index,
        }))
      );
      if (insertError) throw insertError;

      refetch();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
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

      <Text style={styles.sectionTitle}>Due date</Text>
      <TextInput style={styles.input} placeholder="YYYY-MM-DD" value={dueDate} onChangeText={setDueDate} editable={isAdmin} />

      <Text style={styles.sectionTitle}>Line items</Text>
      <LineItemEditor items={lineItems} onChange={setLineItems} />

      <Text style={styles.sectionTitle}>Notes</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        value={notes}
        onChangeText={setNotes}
        multiline
        editable={isAdmin}
      />

      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}

      {isAdmin ? (
        <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
          <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save changes"}</Text>
        </Pressable>
      ) : null}
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
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  error: { color: "#dc2626", marginTop: 12 },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 20 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
});

import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { v4 as uuidv4 } from "uuid";
import { calculateDocumentTotals, formatCentsAsAud, type LineItemFormInput, type Quote, type QuoteStatus } from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";
import { useIsOnline } from "../../lib/connectivity";
import { useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { supabase } from "../../lib/supabase";
import { RequiresConnectionNotice } from "../../components/RequiresConnectionNotice";
import { LineItemEditor } from "../../components/LineItemEditor";

const STATUSES: QuoteStatus[] = ["draft", "sent", "accepted", "declined", "expired"];
const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};

type QuoteRow = Quote & { clients: { name: string } | null };

export default function QuoteDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";

  const { data, loading, refetch } = useSupabaseFetch(async () => {
    const [{ data: quote, error: quoteError }, { data: items, error: itemsError }] = await Promise.all([
      supabase.from("quotes").select("*, clients(name)").eq("id", id).single(),
      supabase.from("quote_line_items").select("*").eq("quote_id", id).order("sort_order"),
    ]);
    if (quoteError) throw quoteError;
    if (itemsError) throw itemsError;
    return { quote: quote as QuoteRow, items: (items ?? []) as LineItemFormInput[] };
  }, [id, isOnline]);

  const [lineItems, setLineItems] = useState<LineItemFormInput[]>([]);
  const [notes, setNotes] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [convertVisible, setConvertVisible] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [convertError, setConvertError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);

  useEffect(() => {
    if (data) {
      setLineItems(data.items);
      setNotes(data.quote.notes ?? "");
      setExpiryDate(data.quote.expiry_date ?? "");
    }
  }, [data]);

  const handleStatusChange = async (status: QuoteStatus) => {
    await supabase.from("quotes").update({ status }).eq("id", id);
    refetch();
  };

  const handleSave = async () => {
    if (!profile) return;
    setSaving(true);
    setSaveError(null);
    try {
      const totals = calculateDocumentTotals(lineItems);
      const { error: updateError } = await supabase
        .from("quotes")
        .update({
          notes: notes || null,
          expiry_date: expiryDate || null,
          subtotal_cents: totals.subtotal_cents,
          gst_cents: totals.gst_cents,
          total_cents: totals.total_cents,
        })
        .eq("id", id);
      if (updateError) throw updateError;

      // Simplest correct way to reconcile an edited line item list without
      // diffing adds/edits/removes: replace the set for this quote.
      const { error: deleteError } = await supabase.from("quote_line_items").delete().eq("quote_id", id);
      if (deleteError) throw deleteError;
      const { error: insertError } = await supabase.from("quote_line_items").insert(
        lineItems.map((item, index) => ({
          id: uuidv4(),
          tenant_id: profile.tenant_id,
          quote_id: id,
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

  const handleConvert = async () => {
    if (!profile || !data) return;
    if (!invoiceNumber.trim()) {
      setConvertError("Invoice number is required");
      return;
    }
    setConverting(true);
    setConvertError(null);
    try {
      const totals = calculateDocumentTotals(lineItems);
      const invoiceId = uuidv4();
      const { error: invoiceError } = await supabase.from("invoices").insert({
        id: invoiceId,
        tenant_id: profile.tenant_id,
        client_id: data.quote.client_id,
        job_card_id: data.quote.job_card_id,
        quote_id: data.quote.id,
        invoice_number: invoiceNumber.trim(),
        status: "draft",
        issue_date: new Date().toISOString().slice(0, 10),
        due_date: dueDate || null,
        subtotal_cents: totals.subtotal_cents,
        gst_cents: totals.gst_cents,
        total_cents: totals.total_cents,
        notes: notes || null,
        created_by: profile.id,
      });
      if (invoiceError) throw invoiceError;

      const { error: itemsError } = await supabase.from("invoice_line_items").insert(
        lineItems.map((item, index) => ({
          id: uuidv4(),
          tenant_id: profile.tenant_id,
          invoice_id: invoiceId,
          item_type: item.item_type,
          description: item.description,
          quantity: item.quantity,
          unit_price_cents: item.unit_price_cents,
          gst_applicable: item.gst_applicable,
          sort_order: index,
        }))
      );
      if (itemsError) throw itemsError;

      setConvertVisible(false);
      router.replace(`/invoices/${invoiceId}`);
    } catch (e) {
      setConvertError(e instanceof Error ? e.message : "Failed to convert to invoice");
    } finally {
      setConverting(false);
    }
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Quotes" />
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

        <Text style={styles.sectionTitle}>Expiry date</Text>
        <TextInput style={styles.input} placeholder="YYYY-MM-DD" value={expiryDate} onChangeText={setExpiryDate} editable={isAdmin} />

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

        {isAdmin ? (
          <Pressable style={styles.convertButton} onPress={() => setConvertVisible(true)}>
            <Text style={styles.convertButtonText}>Convert to invoice</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      <Modal visible={convertVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Convert to invoice</Text>
            <Text style={styles.modalTotal}>{formatCentsAsAud(calculateDocumentTotals(lineItems).total_cents)}</Text>
            <TextInput
              style={styles.input}
              placeholder="Invoice number (e.g. INV-1001)"
              value={invoiceNumber}
              onChangeText={setInvoiceNumber}
            />
            <TextInput style={styles.input} placeholder="Due date (YYYY-MM-DD, optional)" value={dueDate} onChangeText={setDueDate} />
            {convertError ? <Text style={styles.error}>{convertError}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable onPress={() => setConvertVisible(false)}>
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.saveButton} onPress={handleConvert} disabled={converting}>
                <Text style={styles.saveButtonText}>{converting ? "Converting..." : "Create invoice"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  error: { color: "#dc2626", marginTop: 12 },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 20 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  convertButton: { borderRadius: 8, padding: 14, alignItems: "center", marginTop: 12, backgroundColor: "#f3f4f6" },
  convertButtonText: { color: "#1d4ed8", fontWeight: "700", fontSize: 16 },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: "#fff", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, gap: 12 },
  modalTitle: { fontSize: 18, fontWeight: "700" },
  modalTotal: { fontSize: 22, fontWeight: "800", color: "#111827" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  link: { color: "#1d4ed8", fontWeight: "600" },
});

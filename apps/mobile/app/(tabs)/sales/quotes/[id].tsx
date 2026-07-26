import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { calculateDocumentTotals, formatCentsAsAud, type Client, type LineItemFormInput, type Quote, type QuoteStatus, type Tenant } from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { useIsOnline } from "../../../../lib/connectivity";
import { useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../lib/supabase";
import { getErrorMessage } from "../../../../lib/errors";
import { buildQuotePdfHtml } from "../../../../lib/pdf";
import { exportPdf } from "../../../../lib/print";
import { RequiresConnectionNotice } from "../../../../components/RequiresConnectionNotice";
import { LineItemEditor, LineItemSummary } from "../../../../components/LineItemEditor";
import { CenteredModal } from "../../../../components/CenteredModal";
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
      supabase.from("quotes").select("*, clients(*), job_cards(title)").eq("id", id).single(),
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
        {isAdmin ? <LineItemEditor items={lineItems} onChange={setLineItems} /> : <LineItemSummary items={lineItems} />}

        <View style={styles.fieldSpacing}>
          <FormField label="Notes" placeholder="Terms, exclusions, etc." value={notes} onChangeText={setNotes} multiline style={styles.multiline} editable={isAdmin} />
        </View>

        {saveError ? <Text style={styles.error}>{saveError}</Text> : null}

        {isAdmin ? (
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

import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  calculateDocumentTotals,
  createInvoiceSchema,
  type Client,
  type JobCard,
  type LineItemFormInput,
  type Template,
} from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";
import { useIsOnline } from "../../lib/connectivity";
import { useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { supabase } from "../../lib/supabase";
import { RequiresConnectionNotice } from "../../components/RequiresConnectionNotice";
import { LineItemEditor, emptyLineItem } from "../../components/LineItemEditor";
import { PickerModal } from "../../components/PickerModal";

export default function NewInvoiceScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();

  const { data: clients } = useQuery<Client>("SELECT * FROM clients ORDER BY name");

  const { data: templates } = useSupabaseFetch<Template[]>(async () => {
    const { data, error } = await supabase.from("templates").select("*").eq("type", "invoice");
    if (error) throw error;
    return (data ?? []) as Template[];
  }, [isOnline]);

  const [client, setClient] = useState<Client | null>(null);
  const [jobCard, setJobCard] = useState<JobCard | null>(null);
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lineItems, setLineItems] = useState<LineItemFormInput[]>([emptyLineItem(0)]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [clientPickerVisible, setClientPickerVisible] = useState(false);
  const [jobPickerVisible, setJobPickerVisible] = useState(false);
  const [templatePickerVisible, setTemplatePickerVisible] = useState(false);

  const { data: clientJobCards } = useQuery<JobCard>(
    "SELECT * FROM job_cards WHERE client_id = ? ORDER BY created_at DESC",
    [client?.id ?? ""]
  );

  const handleSubmit = async () => {
    const result = createInvoiceSchema.safeParse({
      client_id: client?.id,
      job_card_id: jobCard?.id,
      due_date: dueDate || undefined,
      notes,
      line_items: lineItems,
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    if (!profile) return;

    setSubmitting(true);
    setFormError(null);
    try {
      const totals = calculateDocumentTotals(result.data.line_items);
      const invoiceId = uuidv4();
      const now = new Date().toISOString();

      const { error: invoiceError } = await supabase.from("invoices").insert({
        id: invoiceId,
        tenant_id: profile.tenant_id,
        client_id: result.data.client_id,
        job_card_id: result.data.job_card_id ?? null,
        status: "draft",
        issue_date: now.slice(0, 10),
        due_date: result.data.due_date ?? null,
        subtotal_cents: totals.subtotal_cents,
        gst_cents: totals.gst_cents,
        total_cents: totals.total_cents,
        notes: result.data.notes || null,
        created_by: profile.id,
      });
      if (invoiceError) throw invoiceError;

      const { error: lineItemsError } = await supabase.from("invoice_line_items").insert(
        result.data.line_items.map((item, index) => ({
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
      if (lineItemsError) throw lineItemsError;

      router.replace(`/invoices/${invoiceId}`);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to create invoice");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Invoices" />
      </View>
    );
  }

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={styles.sectionTitle}>Client</Text>
        <Pressable style={styles.pickerField} onPress={() => setClientPickerVisible(true)}>
          <Text style={client ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
            {client?.name ?? "Select a client"}
          </Text>
        </Pressable>

        <Text style={styles.sectionTitle}>Linked job card (optional)</Text>
        <Pressable style={styles.pickerField} onPress={() => client && setJobPickerVisible(true)} disabled={!client}>
          <Text style={jobCard ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
            {jobCard?.title ?? (client ? "Select a job card" : "Pick a client first")}
          </Text>
        </Pressable>

        <Text style={styles.sectionTitle}>Due date (optional)</Text>
        <TextInput style={styles.input} placeholder="YYYY-MM-DD" value={dueDate} onChangeText={setDueDate} />

        {templates && templates.length > 0 ? (
          <Pressable style={styles.templateButton} onPress={() => setTemplatePickerVisible(true)}>
            <Text style={styles.templateButtonText}>Load from template</Text>
          </Pressable>
        ) : null}

        <Text style={styles.sectionTitle}>Line items</Text>
        <LineItemEditor items={lineItems} onChange={setLineItems} />

        <Text style={styles.sectionTitle}>Notes (optional)</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          placeholder="Payment terms, etc."
          value={notes}
          onChangeText={setNotes}
          multiline
        />

        {formError ? <Text style={styles.error}>{formError}</Text> : null}

        <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
          <Text style={styles.submitButtonText}>{submitting ? "Saving..." : "Create invoice"}</Text>
        </Pressable>
      </ScrollView>

      <PickerModal
        visible={clientPickerVisible}
        title="Select client"
        items={clients}
        getKey={(c) => c.id}
        getLabel={(c) => c.name}
        onSelect={(c) => {
          setClient(c);
          setJobCard(null);
        }}
        onClose={() => setClientPickerVisible(false)}
      />
      <PickerModal
        visible={jobPickerVisible}
        title="Select job card"
        items={clientJobCards}
        getKey={(j) => j.id}
        getLabel={(j) => j.title}
        onSelect={setJobCard}
        onClose={() => setJobPickerVisible(false)}
      />
      <PickerModal
        visible={templatePickerVisible}
        title="Select template"
        items={templates ?? []}
        getKey={(t) => t.id}
        getLabel={(t) => t.name}
        onSelect={(t) => setLineItems(t.default_line_items.map((item, index) => ({ ...item, sort_order: index })))}
        onClose={() => setTemplatePickerVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginTop: 16, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  pickerFieldText: { fontSize: 16, color: "#111827" },
  pickerFieldPlaceholder: { fontSize: 16, color: "#9ca3af" },
  templateButton: { marginTop: 12, alignSelf: "flex-start" },
  templateButtonText: { color: "#1d4ed8", fontWeight: "600" },
  error: { color: "#dc2626", marginTop: 12 },
  submitButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 20 },
  submitButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});

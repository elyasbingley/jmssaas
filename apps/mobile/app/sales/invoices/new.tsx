import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
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
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { supabase } from "../../../lib/supabase";
import { getErrorMessage } from "../../../lib/errors";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedFormField } from "../../../components/theme/ThemedFormField";
import { ThemedDateField } from "../../../components/theme/ThemedDateField";
import { ThemedPickerModal } from "../../../components/theme/ThemedPickerModal";
import { ThemedButton } from "../../../components/theme/ThemedButton";
import { LineItemEditor } from "../../../components/LineItemEditor";
import { emptyLineItem, normalizeLineItem } from "../../../lib/line-items";

function toDateInput(d: Date | null): string {
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function NewInvoiceScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);
  const { jobCardId, clientId } = useLocalSearchParams<{ jobCardId?: string; clientId?: string }>();

  const { data: clients } = useQuery<Client>("SELECT * FROM clients ORDER BY name");

  const { data: templates } = useSupabaseFetch<Template[]>(async () => {
    const { data, error } = await supabase.from("templates").select("*").eq("type", "invoice");
    if (error) throw error;
    return (data ?? []) as Template[];
  }, [isOnline]);

  const [client, setClient] = useState<Client | null>(null);
  const [jobCard, setJobCard] = useState<JobCard | null>(null);
  const [dueDate, setDueDate] = useState<Date | null>(null);
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

  const lockedFromJob = !!jobCardId;

  useEffect(() => {
    if (clientId && clients.length > 0 && !client) {
      setClient(clients.find((c) => c.id === clientId) ?? null);
    }
  }, [clientId, clients, client]);

  useEffect(() => {
    if (jobCardId && clientJobCards.length > 0 && !jobCard) {
      setJobCard(clientJobCards.find((j) => j.id === jobCardId) ?? null);
    }
  }, [jobCardId, clientJobCards, jobCard]);

  const handleSubmit = async () => {
    const result = createInvoiceSchema.safeParse({
      client_id: client?.id,
      job_card_id: jobCard?.id,
      due_date: toDateInput(dueDate) || undefined,
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
          description: item.description,
          quantity: item.quantity,
          labour_rate_cents: item.labour_rate_cents,
          labour_hours: item.labour_hours,
          material_cost_cents: item.material_cost_cents,
          markup_percent: item.markup_percent,
          unit_price_cents: item.unit_price_cents,
          gst_applicable: item.gst_applicable,
          sort_order: index,
          is_callout_fee: item.is_callout_fee ?? false,
          is_subcontracted: item.is_subcontracted ?? false,
          subcontractor_cost_cents: item.subcontractor_cost_cents ?? 0,
          bundle_name: item.bundle_name || null,
          image_url: item.image_url || null,
        }))
      );
      if (lineItemsError) throw lineItemsError;

      router.replace(`/sales/invoices/${invoiceId}`);
    } catch (e) {
      console.error("[Invoices] Failed to create invoice", e);
      setFormError(getErrorMessage(e, "Failed to create invoice (see console for details)"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>New Invoice</Text>
        </View>

        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Invoices" />
        ) : (
          <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
            <Text style={styles.sectionTitle}>Client</Text>
            <Pressable
              style={styles.pickerField}
              onPress={() => !lockedFromJob && setClientPickerVisible(true)}
              disabled={lockedFromJob}
            >
              <Text style={client ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
                {client?.name ?? "Select a client"}
              </Text>
            </Pressable>

            <Text style={styles.sectionTitle}>Linked Job{lockedFromJob ? "" : " (optional)"}</Text>
            <Pressable
              style={styles.pickerField}
              onPress={() => client && !lockedFromJob && setJobPickerVisible(true)}
              disabled={!client || lockedFromJob}
            >
              <Text style={jobCard ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
                {jobCard?.title ?? (client ? "Select a job" : "Pick a client first")}
              </Text>
            </Pressable>

            <View style={styles.fieldSpacing}>
              <ThemedDateField label="Due date (optional)" value={dueDate} onChange={setDueDate} mode="date" placeholder="No due date" />
            </View>

            {templates && templates.length > 0 ? (
              <Pressable style={styles.templateButton} onPress={() => setTemplatePickerVisible(true)}>
                <Text style={styles.templateButtonText}>Load from template</Text>
              </Pressable>
            ) : null}

            <Text style={styles.sectionTitle}>Line Items</Text>
            <LineItemEditor items={lineItems} onChange={setLineItems} tenantId={profile?.tenant_id ?? ""} />

            <View style={styles.fieldSpacing}>
              <ThemedFormField
                label="Notes (optional)"
                placeholder="Payment terms, etc."
                value={notes}
                onChangeText={setNotes}
                multiline
                style={styles.multiline}
              />
            </View>

            {formError ? <Text style={styles.error}>{formError}</Text> : null}

            <View style={styles.submitButtonWrap}>
              <ThemedButton label={submitting ? "Saving..." : "Create Invoice"} onPress={handleSubmit} disabled={submitting} />
            </View>
          </ScrollView>
        )}
      </SafeAreaView>

      <ThemedPickerModal
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
      <ThemedPickerModal
        visible={jobPickerVisible}
        title="Select a job"
        items={clientJobCards}
        getKey={(j) => j.id}
        getLabel={(j) => j.title}
        onSelect={setJobCard}
        onClose={() => setJobPickerVisible(false)}
      />
      <ThemedPickerModal
        visible={templatePickerVisible}
        title="Select template"
        items={templates ?? []}
        getKey={(t) => t.id}
        getLabel={(t) => t.name}
        onSelect={(t) => setLineItems(t.default_line_items.map((item, index) => normalizeLineItem(item, index)))}
        onClose={() => setTemplatePickerVisible(false)}
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
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
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
    fieldSpacing: { marginTop: 16 },
    multiline: { minHeight: 70, textAlignVertical: "top" as const },
    pickerField: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, backgroundColor: tokens.background },
    pickerFieldText: { fontSize: font.body, color: tokens.textPrimary, ...mono },
    pickerFieldPlaceholder: { fontSize: font.body, color: tokens.textMuted, ...mono },
    templateButton: { marginTop: 12, alignSelf: "flex-start" as const },
    templateButtonText: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    error: { color: tokens.danger, marginTop: 12, ...mono },
    submitButtonWrap: { marginTop: 20 },
  };
}

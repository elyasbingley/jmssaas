import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  calculateDocumentTotals,
  createQuoteSchema,
  type Client,
  type JobCard,
  type LineItemFormInput,
  type ReferralPartner,
  type Template,
} from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { useIsOnline } from "../../../../lib/connectivity";
import { useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../lib/supabase";
import { getErrorMessage } from "../../../../lib/errors";
import { RequiresConnectionNotice } from "../../../../components/RequiresConnectionNotice";
import { LineItemEditor } from "../../../../components/LineItemEditor";
import { emptyLineItem, normalizeLineItem } from "../../../../lib/line-items";
import { PickerModal } from "../../../../components/PickerModal";
import { FormField } from "../../../../components/FormField";
import { DateField } from "../../../../components/DateField";
import { partnerDisplayName } from "../../../b2b-referrals/index";

function toDateInput(d: Date | null): string {
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function NewQuoteScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  // Cross-linking: arriving here from a job card's "+ New quote for this
  // job" button pre-fills and locks the client/job so the created quote
  // automatically links back (job_card_id), matching how the job then shows
  // it in its own linked-quotes list.
  const { jobCardId, clientId } = useLocalSearchParams<{ jobCardId?: string; clientId?: string }>();

  const { data: clients } = useQuery<Client>("SELECT * FROM clients ORDER BY name");

  const { data: templates } = useSupabaseFetch<Template[]>(async () => {
    const { data, error } = await supabase.from("templates").select("*").eq("type", "quote");
    if (error) throw error;
    return (data ?? []) as Template[];
  }, [isOnline]);
  const { data: referralPartners } = useSupabaseFetch<ReferralPartner[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("referral_partners").select("*").order("contact_first_name");
    if (error) throw error;
    return data as ReferralPartner[];
  }, [isOnline]);

  const [client, setClient] = useState<Client | null>(null);
  const [jobCard, setJobCard] = useState<JobCard | null>(null);
  const [expiryDate, setExpiryDate] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  const [lineItems, setLineItems] = useState<LineItemFormInput[]>([emptyLineItem(0)]);
  const [referralPartner, setReferralPartner] = useState<ReferralPartner | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [clientPickerVisible, setClientPickerVisible] = useState(false);
  const [jobPickerVisible, setJobPickerVisible] = useState(false);
  const [templatePickerVisible, setTemplatePickerVisible] = useState(false);
  const [referralPartnerPickerVisible, setReferralPartnerPickerVisible] = useState(false);

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
    const result = createQuoteSchema.safeParse({
      client_id: client?.id,
      job_card_id: jobCard?.id,
      expiry_date: toDateInput(expiryDate) || undefined,
      notes,
      line_items: lineItems,
      referral_partner_id: referralPartner?.id,
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
      const quoteId = uuidv4();
      const now = new Date().toISOString();

      const { error: quoteError } = await supabase.from("quotes").insert({
        id: quoteId,
        tenant_id: profile.tenant_id,
        client_id: result.data.client_id,
        job_card_id: result.data.job_card_id ?? null,
        status: "draft",
        issue_date: now.slice(0, 10),
        expiry_date: result.data.expiry_date ?? null,
        subtotal_cents: totals.subtotal_cents,
        gst_cents: totals.gst_cents,
        total_cents: totals.total_cents,
        notes: result.data.notes || null,
        referral_partner_id: result.data.referral_partner_id ?? null,
        created_by: profile.id,
      });
      if (quoteError) throw quoteError;

      const { error: lineItemsError } = await supabase.from("quote_line_items").insert(
        result.data.line_items.map((item, index) => ({
          id: uuidv4(),
          tenant_id: profile.tenant_id,
          quote_id: quoteId,
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
        }))
      );
      if (lineItemsError) throw lineItemsError;

      router.replace(`/sales/quotes/${quoteId}`);
    } catch (e) {
      console.error("[Quotes] Failed to create quote", e);
      setFormError(getErrorMessage(e, "Failed to create quote (see console for details)"));
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Quotes" />
      </View>
    );
  }

  return (
    <>
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

        <Text style={styles.sectionTitle}>Linked job{lockedFromJob ? "" : " (optional)"}</Text>
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
          <DateField label="Expiry date (optional)" value={expiryDate} onChange={setExpiryDate} mode="date" placeholder="No expiry date" />
        </View>

        <Text style={styles.sectionTitle}>Referral source (optional)</Text>
        <Pressable style={styles.pickerField} onPress={() => setReferralPartnerPickerVisible(true)}>
          <Text style={referralPartner ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
            {referralPartner ? partnerDisplayName(referralPartner) : "None"}
          </Text>
        </Pressable>

        {templates && templates.length > 0 ? (
          <Pressable style={styles.templateButton} onPress={() => setTemplatePickerVisible(true)}>
            <Text style={styles.templateButtonText}>Load from template</Text>
          </Pressable>
        ) : null}

        <Text style={styles.sectionTitle}>Line items</Text>
        <LineItemEditor items={lineItems} onChange={setLineItems} />

        <View style={styles.fieldSpacing}>
          <FormField
            label="Notes (optional)"
            placeholder="Terms, exclusions, etc."
            value={notes}
            onChangeText={setNotes}
            multiline
            style={styles.multiline}
          />
        </View>

        {formError ? <Text style={styles.error}>{formError}</Text> : null}

        <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
          <Text style={styles.submitButtonText}>{submitting ? "Saving..." : "Create quote"}</Text>
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
        title="Select a job"
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
        onSelect={(t) => setLineItems(t.default_line_items.map((item, index) => normalizeLineItem(item, index)))}
        onClose={() => setTemplatePickerVisible(false)}
      />
      <PickerModal
        visible={referralPartnerPickerVisible}
        title="Select referral source"
        items={referralPartners ?? []}
        getKey={(p) => p.id}
        getLabel={(p) => partnerDisplayName(p)}
        onSelect={setReferralPartner}
        onClose={() => setReferralPartnerPickerVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginTop: 16, marginBottom: 6 },
  fieldSpacing: { marginTop: 16 },
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

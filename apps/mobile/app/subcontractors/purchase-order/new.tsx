import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { createPurchaseOrderSchema, type JobCard, type PoLineItemInput, type SubcontractorCompany, type SubcontractorContact } from "@jmssaas/shared";
import { supabase } from "../../../lib/supabase";
import { useIsOnline } from "../../../lib/connectivity";
import { useAuth } from "../../../lib/auth-context";
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../../lib/errors";
import { RequiresConnectionNotice } from "../../../components/RequiresConnectionNotice";
import { PickerModal } from "../../../components/PickerModal";
import { PoLineItemEditor } from "../../../components/PoLineItemEditor";

// Workflow 2 (Direct Work Order) and Workflow 3 (Quote Request) share this
// one creation form, same as desktop's PurchaseOrderNew.tsx - only the
// ?quoteRequest= query param and what happens next on the detail page
// differ.
export default function PurchaseOrderNewScreen() {
  const { subcontractorId: subcontractorIdParam, quoteRequest, jobCardId: jobCardIdParam } = useLocalSearchParams<{
    subcontractorId: string;
    quoteRequest: string;
    jobCardId?: string;
  }>();
  const isQuoteRequest = quoteRequest === "true";
  const lockedFromJob = !!jobCardIdParam;
  const router = useRouter();
  const isOnline = useIsOnline();
  const { profile } = useAuth();

  const { data: subcontractor } = useSupabaseFetch<SubcontractorCompany | null>(async () => {
    if (!isOnline || !subcontractorIdParam) return null;
    const { data, error } = await supabase.from("subcontractor_companies").select("*").eq("id", subcontractorIdParam).single();
    if (error) throw error;
    return data as SubcontractorCompany;
  }, [isOnline, subcontractorIdParam]);
  const { data: contacts } = useSupabaseFetch<SubcontractorContact[]>(async () => {
    if (!isOnline || !subcontractorIdParam) return [];
    const { data, error } = await supabase.from("subcontractor_contacts").select("*").eq("subcontractor_id", subcontractorIdParam).order("first_name");
    if (error) throw error;
    return data as SubcontractorContact[];
  }, [isOnline, subcontractorIdParam]);
  const { data: jobs } = useSupabaseFetch<JobCard[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("job_cards").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return data as JobCard[];
  }, [isOnline]);

  const [jobCardId, setJobCardId] = useState(jobCardIdParam ?? "");
  const [jobPickerVisible, setJobPickerVisible] = useState(false);
  const [contactId, setContactId] = useState("");
  const [contactPickerVisible, setContactPickerVisible] = useState(false);
  const [lineItems, setLineItems] = useState<PoLineItemInput[]>([{ description: "", quantity: 1, unit_cost_cents: 0 }]);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const complianceHold = subcontractor?.status === "compliance_hold";
  const selectedJob = (jobs ?? []).find((j) => j.id === jobCardId);
  const selectedContact = (contacts ?? []).find((c) => c.id === contactId);

  const save = async () => {
    if (complianceHold) {
      setFormError("This subcontractor is on compliance hold and cannot receive new orders.");
      return;
    }
    const result = createPurchaseOrderSchema.safeParse({
      job_card_id: jobCardId,
      subcontractor_id: subcontractorIdParam,
      contact_id: contactId || undefined,
      is_quote_request: isQuoteRequest,
      line_items: lineItems.filter((item) => item.description.trim().length > 0),
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    if (!profile) return;
    setSaving(true);
    setFormError(null);
    const totalCents = result.data.line_items.reduce((sum, item) => sum + Math.round(item.quantity * item.unit_cost_cents), 0);
    const { data: po, error } = await supabase
      .from("purchase_orders")
      .insert({
        tenant_id: profile.tenant_id,
        job_card_id: result.data.job_card_id,
        subcontractor_id: result.data.subcontractor_id,
        contact_id: result.data.contact_id ?? null,
        is_quote_request: result.data.is_quote_request,
        status: "draft",
        line_items: result.data.line_items,
        total_cost_cents: totalCents,
      })
      .select("id")
      .single();
    setSaving(false);
    if (error) {
      setFormError(getErrorMessage(error, "Failed to create purchase order"));
      return;
    }
    router.replace(`/subcontractors/purchase-order/${po.id}`);
  };

  if (!isOnline) {
    return <RequiresConnectionNotice label="Purchase orders" />;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Text style={styles.heading}>{isQuoteRequest ? "New quote request" : "New work order"}</Text>
      <Text style={styles.subheading}>{subcontractor?.company_name ?? "..."}</Text>

      {complianceHold ? (
        <Text style={styles.holdNotice}>
          This subcontractor is on compliance hold - resolve their expired compliance documents before issuing new orders.
        </Text>
      ) : null}

      <Pressable
        style={[styles.pickerField, styles.fieldSpacing, lockedFromJob && styles.pickerFieldDisabled]}
        onPress={() => !lockedFromJob && setJobPickerVisible(true)}
      >
        <Text style={styles.pickerFieldLabel}>Job</Text>
        <Text style={styles.pickerFieldValue}>{selectedJob?.title ?? "Select a job"}</Text>
      </Pressable>

      <Pressable style={[styles.pickerField, styles.fieldSpacing]} onPress={() => setContactPickerVisible(true)}>
        <Text style={styles.pickerFieldLabel}>Contact (optional)</Text>
        <Text style={styles.pickerFieldValue}>
          {selectedContact ? `${selectedContact.first_name} ${selectedContact.last_name ?? ""}`.trim() : "Use primary contact"}
        </Text>
      </Pressable>

      <Text style={styles.sectionHeading}>{isQuoteRequest ? "Scope of work" : "Line items"}</Text>
      <PoLineItemEditor items={lineItems} onChange={setLineItems} />

      {formError ? <Text style={styles.error}>{formError}</Text> : null}

      <Pressable style={styles.saveButton} onPress={save} disabled={saving || !jobCardId || complianceHold}>
        <Text style={styles.saveButtonText}>{saving ? "Saving..." : isQuoteRequest ? "Create quote request" : "Create work order"}</Text>
      </Pressable>

      <PickerModal
        visible={jobPickerVisible}
        title="Select job"
        items={jobs ?? []}
        getKey={(j) => j.id}
        getLabel={(j) => j.title}
        onSelect={(j) => setJobCardId(j.id)}
        onClose={() => setJobPickerVisible(false)}
      />
      <PickerModal
        visible={contactPickerVisible}
        title="Select contact"
        items={contacts ?? []}
        getKey={(c) => c.id}
        getLabel={(c) => `${c.first_name} ${c.last_name ?? ""}`.trim() + (c.is_primary_contact ? " (Primary)" : "")}
        onSelect={(c) => setContactId(c.id)}
        onClose={() => setContactPickerVisible(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  heading: { fontSize: 19, fontWeight: "700" },
  subheading: { fontSize: 13, color: "#6b7280", marginTop: 2, marginBottom: 12 },
  holdNotice: { color: "#b91c1c", backgroundColor: "#fef2f2", borderRadius: 8, padding: 10, fontSize: 12, marginBottom: 12 },
  fieldSpacing: { marginBottom: 12 },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  pickerFieldDisabled: { backgroundColor: "#f3f4f6" },
  pickerFieldLabel: { fontSize: 12, color: "#6b7280", marginBottom: 2 },
  pickerFieldValue: { fontSize: 15, color: "#111827" },
  sectionHeading: { fontSize: 13, fontWeight: "700", color: "#6b7280", textTransform: "uppercase", marginTop: 16, marginBottom: 10 },
  error: { color: "#dc2626", marginTop: 12 },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 16 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});

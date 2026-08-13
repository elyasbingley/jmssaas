import { useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import {
  createComplianceDocSchema,
  createSubcontractorContactSchema,
  formatCentsAsAud,
  type JobCard,
  type PurchaseOrder,
  type SubcontractorCompany,
  type SubcontractorComplianceDoc,
  type SubcontractorContact,
  type SubcontractorDocType,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useIsOnline } from "../../lib/connectivity";
import { useAuth } from "../../lib/auth-context";
import { useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../lib/errors";
import { uploadComplianceDoc } from "../../lib/po-pdf";
import { RequiresConnectionNotice } from "../../components/RequiresConnectionNotice";
import { CenteredModal } from "../../components/CenteredModal";
import { PickerModal } from "../../components/PickerModal";
import { FormField } from "../../components/FormField";
import { STATUS_BADGE, TIER_LABELS, TRADE_LABELS } from "./index";

const BUCKET = "subcontractor-files";
type DetailTab = "contacts" | "orders" | "compliance";

const DOC_TYPE_OPTIONS: { value: SubcontractorDocType; label: string }[] = [
  { value: "public_liability", label: "Public Liability Insurance" },
  { value: "workers_comp", label: "Workers Compensation" },
  { value: "trade_license", label: "Trade License" },
  { value: "white_card", label: "White Card" },
  { value: "safety_induction", label: "Safety Induction" },
  { value: "other", label: "Other" },
];

export default function SubcontractorDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isOnline = useIsOnline();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const [tab, setTab] = useState<DetailTab>("contacts");
  const [tierPickerVisible, setTierPickerVisible] = useState(false);

  const { data: sub, refetch: refetchSub } = useSupabaseFetch<SubcontractorCompany | null>(async () => {
    if (!isOnline) return null;
    const { data, error } = await supabase.from("subcontractor_companies").select("*").eq("id", id).single();
    if (error) throw error;
    return data as SubcontractorCompany;
  }, [isOnline, id]);
  const { data: contacts, refetch: refetchContacts } = useSupabaseFetch<SubcontractorContact[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("subcontractor_contacts").select("*").eq("subcontractor_id", id).order("first_name");
    if (error) throw error;
    return data as SubcontractorContact[];
  }, [isOnline, id]);
  const { data: complianceDocs, refetch: refetchDocs } = useSupabaseFetch<SubcontractorComplianceDoc[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase
      .from("subcontractor_compliance_docs")
      .select("*")
      .eq("subcontractor_id", id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data as SubcontractorComplianceDoc[];
  }, [isOnline, id]);
  const { data: purchaseOrders } = useSupabaseFetch<PurchaseOrder[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("purchase_orders").select("*").eq("subcontractor_id", id).order("created_at", { ascending: false });
    if (error) throw error;
    return data as PurchaseOrder[];
  }, [isOnline, id]);
  const { data: jobs } = useSupabaseFetch<JobCard[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("job_cards").select("*");
    if (error) throw error;
    return data as JobCard[];
  }, [isOnline]);

  const updateTier = async (tier: number) => {
    const { error } = await supabase.from("subcontractor_companies").update({ preference_tier: tier }).eq("id", id);
    if (!error) refetchSub();
  };

  if (!isOnline) {
    return <RequiresConnectionNotice label="Subcontractors" />;
  }
  if (!sub) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  const badge = STATUS_BADGE[sub.status];
  const jobById = new Map((jobs ?? []).map((j) => [j.id, j]));

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.section}>
        <Text style={styles.heading}>{sub.company_name}</Text>
        {sub.abn ? <Text style={styles.subheading}>ABN {sub.abn}</Text> : null}
        {sub.trades.length > 0 ? (
          <View style={styles.tradeRow}>
            {sub.trades.map((t) => (
              <View key={t} style={styles.tradeChip}>
                <Text style={styles.tradeChipText}>{TRADE_LABELS[t]}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.headerRow}>
          <Pressable style={styles.tierPickerField} onPress={() => isAdmin && setTierPickerVisible(true)}>
            <Text style={styles.tierPickerFieldText}>{TIER_LABELS[sub.preference_tier]}</Text>
          </Pressable>
          <View style={[styles.statusBadge, { backgroundColor: badge.bg }]}>
            <Text style={[styles.statusBadgeText, { color: badge.text }]}>{badge.label}</Text>
          </View>
        </View>
        {sub.status === "compliance_hold" ? (
          <Text style={styles.holdNotice}>
            This subcontractor cannot receive new Purchase Orders or Work Orders until their expired compliance documents are renewed.
          </Text>
        ) : null}
      </View>

      <View style={styles.tabRow}>
        {(
          [
            { key: "contacts", label: "Contacts" },
            { key: "orders", label: "Orders" },
            { key: "compliance", label: "Compliance" },
          ] as { key: DetailTab; label: string }[]
        ).map((t) => (
          <Pressable key={t.key} style={[styles.tab, tab === t.key && styles.tabActive]} onPress={() => setTab(t.key)}>
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.tabBody}>
        {tab === "contacts" ? (
          <ContactsTab subcontractorId={id} contacts={contacts ?? []} onCreated={refetchContacts} />
        ) : tab === "orders" ? (
          <OrdersTab
            purchaseOrders={purchaseOrders ?? []}
            jobById={jobById}
            complianceHold={sub.status === "compliance_hold"}
            isAdmin={isAdmin}
            onCreate={(isQuoteRequest) =>
              router.push(`/subcontractors/purchase-order/new?subcontractorId=${id}&quoteRequest=${isQuoteRequest}`)
            }
          />
        ) : (
          <ComplianceRecordsTab subcontractorId={id} docs={complianceDocs ?? []} isAdmin={isAdmin} onChanged={refetchDocs} />
        )}
      </View>

      <PickerModal
        visible={tierPickerVisible}
        title="Preference tier"
        items={[1, 2, 3, 4, 5]}
        getKey={(t) => String(t)}
        getLabel={(t) => TIER_LABELS[t] ?? String(t)}
        onSelect={updateTier}
        onClose={() => setTierPickerVisible(false)}
      />
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

function ContactsTab({
  subcontractorId,
  contacts,
  onCreated,
}: {
  subcontractorId: string;
  contacts: SubcontractorContact[];
  onCreated: () => void;
}) {
  const { profile } = useAuth();
  const [modalVisible, setModalVisible] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [workPhone, setWorkPhone] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const openNew = () => {
    setFirstName("");
    setLastName("");
    setRoleTitle("");
    setEmail("");
    setMobile("");
    setWorkPhone("");
    setIsPrimary(contacts.length === 0);
    setError(null);
    setModalVisible(true);
  };

  const save = async () => {
    const result = createSubcontractorContactSchema.safeParse({
      subcontractor_id: subcontractorId,
      first_name: firstName,
      last_name: lastName,
      role_title: roleTitle,
      email,
      mobile,
      work_phone: workPhone,
      is_primary_contact: isPrimary,
    });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Invalid contact");
      return;
    }
    if (!profile) return;
    setSaving(true);
    try {
      if (result.data.is_primary_contact) {
        await supabase.from("subcontractor_contacts").update({ is_primary_contact: false }).eq("subcontractor_id", subcontractorId);
      }
      const { error: insertError } = await supabase.from("subcontractor_contacts").insert({
        tenant_id: profile.tenant_id,
        subcontractor_id: result.data.subcontractor_id,
        first_name: result.data.first_name,
        last_name: result.data.last_name || null,
        role_title: result.data.role_title || null,
        email: result.data.email,
        mobile: result.data.mobile || null,
        work_phone: result.data.work_phone || null,
        is_primary_contact: result.data.is_primary_contact,
      });
      if (insertError) throw insertError;
      setModalVisible(false);
      onCreated();
    } catch (e) {
      setError(getErrorMessage(e, "Failed to add contact"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      <Pressable style={styles.primaryButton} onPress={openNew}>
        <Text style={styles.primaryButtonText}>+ Add Contact</Text>
      </Pressable>

      {contacts.length === 0 ? (
        <Text style={styles.empty}>No contacts yet.</Text>
      ) : (
        contacts.map((c) => (
          <View key={c.id} style={styles.contactCard}>
            <Text style={styles.contactName}>
              {c.first_name} {c.last_name ?? ""}
              {c.is_primary_contact ? <Text style={styles.primaryTag}> (Primary)</Text> : null}
            </Text>
            {c.role_title ? <Text style={styles.contactMeta}>{c.role_title}</Text> : null}
            <Pressable onPress={() => Linking.openURL(`mailto:${c.email}`)}>
              <Text style={styles.link}>{c.email}</Text>
            </Pressable>
            {c.mobile ? (
              <Pressable onPress={() => Linking.openURL(`tel:${c.mobile}`)}>
                <Text style={styles.link}>{c.mobile}</Text>
              </Pressable>
            ) : null}
          </View>
        ))
      )}

      <CenteredModal visible={modalVisible} onClose={() => setModalVisible(false)}>
        <Text style={styles.modalTitle}>New contact</Text>
        <FormField label="First name" value={firstName} onChangeText={setFirstName} />
        <FormField label="Last name" value={lastName} onChangeText={setLastName} />
        <FormField label="Role / title" value={roleTitle} onChangeText={setRoleTitle} placeholder="e.g. Lead Estimator" />
        <FormField label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <FormField label="Mobile" value={mobile} onChangeText={setMobile} keyboardType="phone-pad" />
        <FormField label="Work phone" value={workPhone} onChangeText={setWorkPhone} keyboardType="phone-pad" />
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Primary contact</Text>
          <Switch value={isPrimary} onValueChange={setIsPrimary} />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={save} disabled={saving}>
            <Text style={styles.primaryButtonText}>{saving ? "Saving..." : "Save"}</Text>
          </Pressable>
        </View>
      </CenteredModal>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function OrdersTab({
  purchaseOrders,
  jobById,
  complianceHold,
  isAdmin,
  onCreate,
}: {
  purchaseOrders: PurchaseOrder[];
  jobById: Map<string, JobCard>;
  complianceHold: boolean;
  isAdmin: boolean;
  onCreate: (isQuoteRequest: boolean) => void;
}) {
  const router = useRouter();
  return (
    <View>
      {isAdmin ? (
        <View style={styles.ordersActionsRow}>
          <Pressable style={styles.secondaryButton} onPress={() => onCreate(true)} disabled={complianceHold}>
            <Text style={styles.secondaryButtonText}>Send Quote Request</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={() => onCreate(false)} disabled={complianceHold}>
            <Text style={styles.primaryButtonText}>Issue Work Order</Text>
          </Pressable>
        </View>
      ) : null}
      {complianceHold ? <Text style={styles.holdNotice}>Compliance hold - new orders are blocked.</Text> : null}

      {purchaseOrders.length === 0 ? (
        <Text style={styles.empty}>No purchase orders or quote requests yet.</Text>
      ) : (
        purchaseOrders.map((po) => (
          <Pressable key={po.id} style={styles.poRow} onPress={() => router.push(`/subcontractors/purchase-order/${po.id}`)}>
            <View style={styles.flex1}>
              <Text style={styles.poNumber}>{po.po_number ?? "Pending"}</Text>
              <Text style={styles.poMeta}>
                {jobById.get(po.job_card_id)?.title ?? "-"} · {po.is_quote_request ? "Quote Request" : "Work Order"} ·{" "}
                {po.status.charAt(0).toUpperCase() + po.status.slice(1)}
              </Text>
            </View>
            <Text style={styles.poCost}>{formatCentsAsAud(po.total_cost_cents)}</Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Compliance Records
// ---------------------------------------------------------------------------

function ComplianceRecordsTab({
  subcontractorId,
  docs,
  isAdmin,
  onChanged,
}: {
  subcontractorId: string;
  docs: SubcontractorComplianceDoc[];
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const { profile } = useAuth();
  const [docType, setDocType] = useState<SubcontractorDocType>("public_liability");
  const [docTypePickerVisible, setDocTypePickerVisible] = useState(false);
  const [docNumber, setDocNumber] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [pickedFile, setPickedFile] = useState<{ name: string; base64: string; mimeType: string; extension: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const pickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: ["application/pdf", "image/*"], copyToCacheDirectory: true });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    try {
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      const extension = asset.name.includes(".") ? asset.name.split(".").pop()!.toLowerCase() : "pdf";
      setPickedFile({ name: asset.name, base64, mimeType: asset.mimeType ?? "application/octet-stream", extension });
    } catch (e) {
      Alert.alert("Couldn't read file", getErrorMessage(e, "Try a different file"));
    }
  };

  const upload = async () => {
    if (!pickedFile) {
      setError("Choose a file to upload");
      return;
    }
    const result = createComplianceDocSchema.safeParse({
      subcontractor_id: subcontractorId,
      doc_type: docType,
      doc_number: docNumber,
    });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Invalid document");
      return;
    }
    if (!profile) return;
    setUploading(true);
    setError(null);
    try {
      const storagePath = await uploadComplianceDoc({
        tenantId: profile.tenant_id,
        subcontractorId,
        base64: pickedFile.base64,
        extension: pickedFile.extension,
        contentType: pickedFile.mimeType,
      });
      const { error: insertError } = await supabase.from("subcontractor_compliance_docs").insert({
        tenant_id: profile.tenant_id,
        subcontractor_id: result.data.subcontractor_id,
        doc_type: result.data.doc_type,
        doc_number: result.data.doc_number || null,
        storage_path: storagePath,
        issue_date: null,
        expiry_date: expiryDate || null,
      });
      if (insertError) throw insertError;
      setDocNumber("");
      setExpiryDate("");
      setPickedFile(null);
      onChanged();
    } catch (e) {
      setError(getErrorMessage(e, "Failed to upload document"));
    } finally {
      setUploading(false);
    }
  };

  const toggleVerified = async (doc: SubcontractorComplianceDoc) => {
    const { error: updateError } = await supabase.from("subcontractor_compliance_docs").update({ is_verified: !doc.is_verified }).eq("id", doc.id);
    if (!updateError) onChanged();
  };

  const confirmDelete = (doc: SubcontractorComplianceDoc) => {
    Alert.alert("Delete this document?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await supabase.storage.from(BUCKET).remove([doc.storage_path]);
          const { error: deleteError } = await supabase.from("subcontractor_compliance_docs").delete().eq("id", doc.id);
          if (!deleteError) onChanged();
        },
      },
    ]);
  };

  const viewDoc = async (doc: SubcontractorComplianceDoc) => {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(doc.storage_path, 3600);
    if (data?.signedUrl) Linking.openURL(data.signedUrl).catch(() => Alert.alert("Couldn't open document"));
  };

  return (
    <View>
      {isAdmin ? (
        <View style={styles.uploadCard}>
          <Text style={styles.uploadCardTitle}>Upload compliance document</Text>
          <Pressable style={styles.pickerField} onPress={() => setDocTypePickerVisible(true)}>
            <Text style={styles.pickerFieldLabel}>Document type</Text>
            <Text style={styles.pickerFieldValue}>{DOC_TYPE_OPTIONS.find((o) => o.value === docType)?.label}</Text>
          </Pressable>
          <FormField label="Doc / policy number (optional)" value={docNumber} onChangeText={setDocNumber} />
          <FormField label="Expiry date (YYYY-MM-DD)" value={expiryDate} onChangeText={setExpiryDate} placeholder="2026-12-31" />
          <Pressable style={styles.secondaryButton} onPress={pickFile}>
            <Text style={styles.secondaryButtonText}>{pickedFile ? pickedFile.name : "Choose file"}</Text>
          </Pressable>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable style={styles.primaryButton} onPress={upload} disabled={uploading || !pickedFile}>
            <Text style={styles.primaryButtonText}>{uploading ? "Uploading..." : "Upload"}</Text>
          </Pressable>
        </View>
      ) : null}

      {docs.length === 0 ? (
        <Text style={styles.empty}>No compliance documents uploaded yet.</Text>
      ) : (
        docs.map((doc) => {
          const expired = doc.expiry_date ? new Date(`${doc.expiry_date}T00:00:00`) < new Date(new Date().toDateString()) : false;
          return (
            <View key={doc.id} style={styles.docCard}>
              <Text style={styles.docCardTitle}>{DOC_TYPE_OPTIONS.find((o) => o.value === doc.doc_type)?.label}</Text>
              {doc.doc_number ? <Text style={styles.docCardMeta}>#{doc.doc_number}</Text> : null}
              {doc.expiry_date ? (
                <Text style={[styles.docCardMeta, expired && styles.docCardExpired]}>
                  Expires {new Date(`${doc.expiry_date}T00:00:00`).toLocaleDateString("en-AU")}
                </Text>
              ) : null}
              <View style={styles.docCardActions}>
                {isAdmin ? (
                  <Pressable style={styles.verifyRow} onPress={() => toggleVerified(doc)}>
                    <Switch value={doc.is_verified} onValueChange={() => toggleVerified(doc)} />
                    <Text style={styles.verifyLabel}>Verified</Text>
                  </Pressable>
                ) : doc.is_verified ? (
                  <Text style={styles.verifyLabel}>✓ Verified</Text>
                ) : null}
                <Pressable onPress={() => viewDoc(doc)}>
                  <Text style={styles.link}>View</Text>
                </Pressable>
                {isAdmin ? (
                  <Pressable onPress={() => confirmDelete(doc)}>
                    <Text style={styles.deleteLink}>Delete</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          );
        })
      )}

      <PickerModal
        visible={docTypePickerVisible}
        title="Document type"
        items={DOC_TYPE_OPTIONS}
        getKey={(o) => o.value}
        getLabel={(o) => o.label}
        onSelect={(o) => setDocType(o.value)}
        onClose={() => setDocTypePickerVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  flex1: { flex: 1 },
  section: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#e5e7eb" },
  heading: { fontSize: 19, fontWeight: "700", color: "#111827" },
  subheading: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 10 },
  holdNotice: { color: "#b91c1c", backgroundColor: "#fef2f2", borderRadius: 8, padding: 10, fontSize: 12, marginTop: 10 },

  tradeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  tradeChip: { backgroundColor: "#f3f4f6", borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  tradeChipText: { fontSize: 11, fontWeight: "600", color: "#374151" },

  tierPickerField: { backgroundColor: "#fef3c7", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  tierPickerFieldText: { fontSize: 12, fontWeight: "700", color: "#92400e" },
  statusBadge: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5 },
  statusBadgeText: { fontSize: 12, fontWeight: "700" },

  tabRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e5e7eb" },
  tab: { flex: 1, paddingVertical: 12, alignItems: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabActive: { borderBottomColor: "#1d4ed8" },
  tabText: { fontSize: 13, fontWeight: "600", color: "#6b7280" },
  tabTextActive: { color: "#1d4ed8" },
  tabBody: { padding: 16 },
  empty: { color: "#6b7280", textAlign: "center", marginVertical: 16 },
  error: { color: "#dc2626", marginTop: 8 },
  link: { color: "#1d4ed8", fontWeight: "600" },
  deleteLink: { color: "#dc2626", fontWeight: "600" },

  primaryButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, alignItems: "center", marginTop: 8 },
  primaryButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  secondaryButton: { flex: 1, borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, alignItems: "center", marginTop: 8 },
  secondaryButtonText: { color: "#374151", fontWeight: "700", fontSize: 13 },
  ordersActionsRow: { flexDirection: "row", gap: 8, marginBottom: 4 },

  contactCard: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 10, padding: 12, marginTop: 10, gap: 2 },
  contactName: { fontSize: 14, fontWeight: "700", color: "#111827" },
  primaryTag: { fontSize: 11, fontWeight: "700", color: "#1d4ed8" },
  contactMeta: { fontSize: 12, color: "#6b7280" },

  poRow: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 10, padding: 12, marginTop: 10 },
  poNumber: { fontSize: 14, fontWeight: "700", color: "#1d4ed8" },
  poMeta: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  poCost: { fontSize: 14, fontWeight: "700", color: "#111827" },

  uploadCard: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 10, padding: 14, marginBottom: 16, gap: 8 },
  uploadCardTitle: { fontSize: 12, fontWeight: "700", color: "#6b7280", textTransform: "uppercase", marginBottom: 4 },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  pickerFieldLabel: { fontSize: 12, color: "#6b7280", marginBottom: 2 },
  pickerFieldValue: { fontSize: 15, color: "#111827" },

  docCard: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 10, padding: 12, marginTop: 10 },
  docCardTitle: { fontSize: 14, fontWeight: "700", color: "#111827" },
  docCardMeta: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  docCardExpired: { color: "#dc2626", fontWeight: "700" },
  docCardActions: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 8 },
  verifyRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  verifyLabel: { fontSize: 12, color: "#4b5563" },

  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  switchLabel: { fontSize: 14, fontWeight: "600", color: "#374151" },
  modalTitle: { fontSize: 17, fontWeight: "700" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 16, marginTop: 4 },
});

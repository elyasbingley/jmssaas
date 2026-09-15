import { useState } from "react";
import { Alert, Linking, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
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
import { useTheme } from "../../lib/theme-context";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../lib/errors";
import { uploadComplianceDoc } from "../../lib/po-pdf";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedModal } from "../../components/theme/ThemedModal";
import { ThemedPickerModal } from "../../components/theme/ThemedPickerModal";
import { ThemedFormField } from "../../components/theme/ThemedFormField";
import { ThemedButton } from "../../components/theme/ThemedButton";
import { getStatusBadge, TIER_LABELS, TRADE_LABELS } from "./index";

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
  const { tokens } = useTheme();
  const isAdmin = profile?.role === "admin";
  const [tab, setTab] = useState<DetailTab>("contacts");
  const [tierPickerVisible, setTierPickerVisible] = useState(false);
  const styles = useThemedStyles(createStyles);
  const statusBadge = getStatusBadge(tokens);

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

  const jobById = new Map((jobs ?? []).map((j) => [j.id, j]));
  const badge = sub ? statusBadge[sub.status] : null;

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.link}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{sub?.company_name ?? "Subcontractor"}</Text>
      </View>

      {!isOnline ? (
        <ThemedRequiresConnectionNotice label="Subcontractors" />
      ) : !sub ? (
        <View style={styles.center}>
          <Text style={styles.empty}>Loading...</Text>
        </View>
      ) : (
        <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
          <View style={styles.section}>
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
              {badge ? (
                <View style={[styles.statusBadge, { backgroundColor: badge.bg, borderColor: badge.border }]}>
                  <Text style={[styles.statusBadgeText, { color: badge.text }]}>{badge.label}</Text>
                </View>
              ) : null}
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

          <ThemedPickerModal
            visible={tierPickerVisible}
            title="Preference tier"
            items={[1, 2, 3, 4, 5]}
            getKey={(t) => String(t)}
            getLabel={(t) => TIER_LABELS[t] ?? String(t)}
            onSelect={updateTier}
            onClose={() => setTierPickerVisible(false)}
          />
        </ScrollView>
      )}
    </SafeAreaView>
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
  const styles = useThemedStyles(createStyles);
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
      <ThemedButton label="+ Add Contact" onPress={openNew} />

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

      <ThemedModal visible={modalVisible} onClose={() => setModalVisible(false)}>
        <Text style={styles.modalTitle}>New contact</Text>
        <ThemedFormField label="First name" value={firstName} onChangeText={setFirstName} />
        <ThemedFormField label="Last name" value={lastName} onChangeText={setLastName} />
        <ThemedFormField label="Role / title" value={roleTitle} onChangeText={setRoleTitle} placeholder="e.g. Lead Estimator" />
        <ThemedFormField label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <ThemedFormField label="Mobile" value={mobile} onChangeText={setMobile} keyboardType="phone-pad" />
        <ThemedFormField label="Work phone" value={workPhone} onChangeText={setWorkPhone} keyboardType="phone-pad" />
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Primary contact</Text>
          <Switch value={isPrimary} onValueChange={setIsPrimary} />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label={saving ? "Saving..." : "Save"} onPress={save} disabled={saving} />
        </View>
      </ThemedModal>
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
  const styles = useThemedStyles(createStyles);
  return (
    <View>
      {isAdmin ? (
        <View style={styles.ordersActionsRow}>
          <Pressable style={[styles.secondaryButton, complianceHold && styles.disabled]} onPress={() => onCreate(true)} disabled={complianceHold}>
            <Text style={styles.secondaryButtonText}>Send Quote Request</Text>
          </Pressable>
          <View style={styles.flex1}>
            <ThemedButton label="Issue Work Order" onPress={() => onCreate(false)} disabled={complianceHold} />
          </View>
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
  const styles = useThemedStyles(createStyles);
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
          <ThemedFormField label="Doc / policy number (optional)" value={docNumber} onChangeText={setDocNumber} />
          <ThemedFormField label="Expiry date (YYYY-MM-DD)" value={expiryDate} onChangeText={setExpiryDate} placeholder="2026-12-31" />
          <Pressable style={styles.secondaryButton} onPress={pickFile}>
            <Text style={styles.secondaryButtonText}>{pickedFile ? pickedFile.name : "Choose file"}</Text>
          </Pressable>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <ThemedButton label={uploading ? "Uploading..." : "Upload"} onPress={upload} disabled={uploading || !pickedFile} />
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

      <ThemedPickerModal
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

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
    title: { ...mono, fontSize: font.title, fontWeight: "700" as const, color: tokens.textPrimary, flexShrink: 1 },
    container: { flex: 1, backgroundColor: tokens.background },
    center: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const },
    flex1: { flex: 1 },
    section: { padding: 16, borderBottomWidth: 1, borderBottomColor: tokens.border },
    subheading: { ...mono, fontSize: font.label, color: tokens.textMuted, marginTop: 2 },
    headerRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, marginTop: 10 },
    holdNotice: { ...mono, color: tokens.danger, borderWidth: 1, borderColor: tokens.danger, backgroundColor: tokens.surface, borderRadius: 4, padding: 10, fontSize: font.label, marginTop: 10 },

    tradeRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginTop: 8 },
    tradeChip: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 5 },
    tradeChipText: { ...mono, fontSize: font.label, fontWeight: "600" as const, color: tokens.textMuted },

    tierPickerField: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 6 },
    tierPickerFieldText: { ...mono, fontSize: font.label, fontWeight: "700" as const, color: tokens.textMuted },
    statusBadge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 5 },
    statusBadgeText: { ...mono, fontSize: font.label, fontWeight: "700" as const },

    tabRow: { flexDirection: "row" as const, borderBottomWidth: 1, borderBottomColor: tokens.border },
    tab: { flex: 1, paddingVertical: 12, alignItems: "center" as const, borderBottomWidth: 2, borderBottomColor: "transparent" },
    tabActive: { borderBottomColor: tokens.accent },
    tabText: { ...mono, fontSize: font.label, fontWeight: "600" as const, color: tokens.textMuted, textTransform: "uppercase" as const },
    tabTextActive: { color: tokens.accent },
    tabBody: { padding: 16 },
    empty: { ...mono, color: tokens.textMuted, textAlign: "center" as const, marginVertical: 16, fontSize: font.body },
    error: { ...mono, color: tokens.danger, marginTop: 8, fontSize: font.body },
    link: { ...mono, color: tokens.accent, fontWeight: "600" as const, fontSize: font.body },
    deleteLink: { ...mono, color: tokens.danger, fontWeight: "600" as const, fontSize: font.body },

    secondaryButton: { flex: 1, borderWidth: 1, borderColor: tokens.border, borderRadius: 3, paddingHorizontal: 14, paddingVertical: 10, alignItems: "center" as const, marginTop: 8 },
    secondaryButtonText: { ...mono, color: tokens.accent, fontWeight: "700" as const, fontSize: font.button, letterSpacing: 1, textTransform: "uppercase" as const },
    disabled: { opacity: 0.5 },
    ordersActionsRow: { flexDirection: "row" as const, gap: 8, marginBottom: 4, alignItems: "flex-start" as const },

    contactCard: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, padding: 12, marginTop: 10, gap: 2 },
    contactName: { ...mono, fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary },
    primaryTag: { ...mono, fontSize: font.label, fontWeight: "700" as const, color: tokens.accent },
    contactMeta: { ...mono, fontSize: font.label, color: tokens.textMuted },

    poRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, padding: 12, marginTop: 10 },
    poNumber: { ...mono, fontSize: font.body, fontWeight: "700" as const, color: tokens.accent },
    poMeta: { ...mono, fontSize: font.label, color: tokens.textMuted, marginTop: 2 },
    poCost: { ...mono, fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary, flexShrink: 0 },

    uploadCard: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, padding: 14, marginBottom: 16, gap: 8 },
    uploadCardTitle: { ...mono, fontSize: font.label, fontWeight: "700" as const, color: tokens.accent, textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 4 },
    pickerField: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, backgroundColor: tokens.background },
    pickerFieldLabel: { ...mono, fontSize: font.label, color: tokens.textMuted, marginBottom: 2 },
    pickerFieldValue: { ...mono, fontSize: font.body, color: tokens.textPrimary },

    docCard: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, padding: 12, marginTop: 10 },
    docCardTitle: { ...mono, fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary },
    docCardMeta: { ...mono, fontSize: font.label, color: tokens.textMuted, marginTop: 2 },
    docCardExpired: { color: tokens.danger, fontWeight: "700" as const },
    docCardActions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 16, marginTop: 8 },
    verifyRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    verifyLabel: { ...mono, fontSize: font.label, color: tokens.textMuted },

    switchRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, marginTop: 8 },
    switchLabel: { ...mono, fontSize: font.body, fontWeight: "600" as const, color: tokens.textPrimary },
    modalTitle: { ...mono, fontSize: font.title, fontWeight: "700" as const, color: tokens.textPrimary },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 16, marginTop: 4 },
  };
}

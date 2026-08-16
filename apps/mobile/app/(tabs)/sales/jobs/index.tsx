import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  createJobCardSchema,
  type Client,
  type JobCard,
  type JobLifecycleStage,
  type ReferralPartner,
  type ServiceCategory,
} from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { useIsOnline } from "../../../../lib/connectivity";
import { useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../lib/supabase";
import { CenteredModal } from "../../../../components/CenteredModal";
import { FormField } from "../../../../components/FormField";
import { PickerModal } from "../../../../components/PickerModal";
import { partnerDisplayName } from "../../../b2b-referrals/index";

type SortOption = "created_at" | "scheduled_at" | "category" | "stage";
const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "created_at", label: "Created" },
  { value: "scheduled_at", label: "Scheduled" },
  { value: "category", label: "Category" },
  { value: "stage", label: "Stage" },
];

// Top-level Jobs list - previously job cards were only reachable by drilling
// into a client first. This is the new home for "Jobs" as its own section
// (see the home screen / tab bar restructure), with client scoped from here
// via a picker instead.
export default function JobsScreen() {
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const isOnline = useIsOnline();

  // referral_partners isn't a PowerSync table (see app/b2b-referrals/
  // index.tsx), so this picker's options only load while online - offline
  // job creation still works, just without a referral source pick (settable
  // later from the B2B & Referrals screen once back online).
  const { data: referralPartners } = useSupabaseFetch<ReferralPartner[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("referral_partners").select("*").order("contact_first_name");
    if (error) throw error;
    return data as ReferralPartner[];
  }, [isOnline]);

  const { data: jobCards } = useQuery<JobCard>(
    isAdmin
      ? "SELECT * FROM job_cards ORDER BY created_at DESC"
      : "SELECT * FROM job_cards WHERE assigned_technician_id = ? ORDER BY created_at DESC",
    isAdmin ? [] : [profile?.id ?? ""]
  );
  const { data: clients } = useQuery<Client>("SELECT * FROM clients ORDER BY name");
  const { data: categories } = useQuery<ServiceCategory>("SELECT * FROM service_categories ORDER BY name");
  const { data: stages } = useQuery<JobLifecycleStage>("SELECT * FROM job_lifecycle_stages ORDER BY position");

  const clientNameById = new Map(clients.map((c) => [c.id, c.name]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const stageById = new Map(stages.map((s) => [s.id, s]));

  // Filtering/sorting is done client-side in JS over the PowerSync-watched
  // query results above, not by building dynamic SQL - matching the
  // established convention from the Schedule/Calendar screens.
  const [filterCategory, setFilterCategory] = useState<ServiceCategory | null>(null);
  const [filterStage, setFilterStage] = useState<JobLifecycleStage | null>(null);
  const [filterCategoryPickerVisible, setFilterCategoryPickerVisible] = useState(false);
  const [filterStagePickerVisible, setFilterStagePickerVisible] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>("created_at");

  const filteredJobs = jobCards.filter(
    (job) =>
      (!filterCategory || job.service_category_id === filterCategory.id) &&
      (!filterStage || job.lifecycle_stage_id === filterStage.id)
  );

  const sortedJobs = [...filteredJobs].sort((a, b) => {
    switch (sortBy) {
      case "scheduled_at":
        return (a.scheduled_at ?? "9999").localeCompare(b.scheduled_at ?? "9999");
      case "category":
        return (categoryById.get(a.service_category_id ?? "")?.name ?? "￿").localeCompare(
          categoryById.get(b.service_category_id ?? "")?.name ?? "￿"
        );
      case "stage":
        return (
          (stageById.get(a.lifecycle_stage_id ?? "")?.position ?? Number.MAX_SAFE_INTEGER) -
          (stageById.get(b.lifecycle_stage_id ?? "")?.position ?? Number.MAX_SAFE_INTEGER)
        );
      case "created_at":
      default:
        return b.created_at.localeCompare(a.created_at);
    }
  });

  const [modalVisible, setModalVisible] = useState(false);
  const [clientPickerVisible, setClientPickerVisible] = useState(false);
  const [categoryPickerVisible, setCategoryPickerVisible] = useState(false);
  const [stagePickerVisible, setStagePickerVisible] = useState(false);
  const [client, setClient] = useState<Client | null>(null);
  const [category, setCategory] = useState<ServiceCategory | null>(null);
  const [stage, setStage] = useState<JobLifecycleStage | null>(null);
  const [referralPartner, setReferralPartner] = useState<ReferralPartner | null>(null);
  const [referralPartnerPickerVisible, setReferralPartnerPickerVisible] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const resetForm = () => {
    setClient(null);
    setCategory(null);
    setStage(null);
    setReferralPartner(null);
    setTitle("");
    setDescription("");
    setFormError(null);
  };

  const handleCreate = async () => {
    const result = createJobCardSchema.safeParse({
      client_id: client?.id,
      title,
      description,
      service_category_id: category?.id,
      lifecycle_stage_id: stage?.id,
      referral_partner_id: referralPartner?.id,
    });
    if (!result.success) {
      setFormError(client ? (result.error.issues[0]?.message ?? "Invalid job") : "Pick a client first");
      return;
    }
    if (!profile) return;

    const jobId = uuidv4();
    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO job_cards (id, tenant_id, client_id, title, description, service_category_id, lifecycle_stage_id, referral_partner_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        profile.tenant_id,
        result.data.client_id,
        result.data.title,
        result.data.description || null,
        result.data.service_category_id ?? null,
        result.data.lifecycle_stage_id ?? null,
        result.data.referral_partner_id ?? null,
        profile.id,
        now,
        now,
      ]
    );

    resetForm();
    setModalVisible(false);
    router.push(`/sales/jobs/${jobId}`);
  };

  return (
    <View style={styles.container}>
      <View style={styles.filterBar}>
        <Pressable style={styles.filterChip} onPress={() => setFilterCategoryPickerVisible(true)}>
          <Text style={styles.filterChipText}>{filterCategory ? filterCategory.name : "All categories"}</Text>
        </Pressable>
        <Pressable style={styles.filterChip} onPress={() => setFilterStagePickerVisible(true)}>
          <Text style={styles.filterChipText}>{filterStage ? filterStage.name : "All stages"}</Text>
        </Pressable>
        {filterCategory || filterStage ? (
          <Pressable
            onPress={() => {
              setFilterCategory(null);
              setFilterStage(null);
            }}
          >
            <Text style={styles.filterClearText}>Clear</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.sortBar}>
        <Text style={styles.sortLabel}>Sort:</Text>
        {SORT_OPTIONS.map((option) => (
          <Pressable
            key={option.value}
            style={[styles.sortChip, sortBy === option.value && styles.sortChipActive]}
            onPress={() => setSortBy(option.value)}
          >
            <Text style={[styles.sortChipText, sortBy === option.value && styles.sortChipTextActive]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={sortedJobs}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => {
          const itemCategory = categoryById.get(item.service_category_id ?? "");
          const itemStage = stageById.get(item.lifecycle_stage_id ?? "");
          return (
            <Pressable style={styles.row} onPress={() => router.push(`/sales/jobs/${item.id}`)}>
              <View style={{ flex: 1 }}>
                <View style={styles.rowTitleRow}>
                  <Text style={styles.rowNumber}>{item.number ?? "Pending sync"}</Text>
                  <Text style={styles.rowTitle}>{item.title}</Text>
                </View>
                <Text style={styles.rowSubtitle}>{clientNameById.get(item.client_id) ?? "Unknown client"}</Text>
                {itemCategory || itemStage ? (
                  <View style={styles.tagRow}>
                    {itemCategory ? (
                      <View style={styles.categoryTag}>
                        <View
                          style={[
                            styles.swatch,
                            itemCategory.color ? { backgroundColor: itemCategory.color } : styles.swatchEmpty,
                          ]}
                        />
                        <Text style={styles.categoryTagText}>{itemCategory.name}</Text>
                      </View>
                    ) : null}
                    {itemStage ? (
                      <View style={[styles.stageBadge, itemStage.color ? { backgroundColor: itemStage.color } : null]}>
                        <Text style={styles.stageBadgeText}>{itemStage.name}</Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No jobs yet.</Text>}
        contentContainerStyle={sortedJobs.length === 0 ? styles.emptyContainer : undefined}
      />

      {isAdmin ? (
        <Pressable style={styles.fab} onPress={() => setModalVisible(true)}>
          <Text style={styles.fabText}>+ New job</Text>
        </Pressable>
      ) : null}

      <CenteredModal
        visible={modalVisible}
        onClose={() => {
          setModalVisible(false);
          resetForm();
        }}
      >
        <Text style={styles.modalTitle}>New job</Text>

        <Pressable style={styles.pickerField} onPress={() => setClientPickerVisible(true)}>
          <Text style={styles.pickerFieldLabel}>Client</Text>
          <Text style={client ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
            {client?.name ?? "Select a client"}
          </Text>
        </Pressable>

        {client ? (
          <View style={styles.clientSummary}>
            {client.phone ? <Text style={styles.clientSummarySub}>{client.phone}</Text> : null}
            {client.email ? <Text style={styles.clientSummarySub}>{client.email}</Text> : null}
            {client.address_line1 ? (
              <Text style={styles.clientSummarySub}>
                {[client.address_line1, client.suburb, client.state, client.postcode].filter(Boolean).join(", ")}
              </Text>
            ) : null}
          </View>
        ) : null}

        <FormField label="Title" placeholder="e.g. Roof inspection" value={title} onChangeText={setTitle} />
        <FormField
          label="Description (optional)"
          placeholder="e.g. valley channel inspection, supply and install"
          value={description}
          onChangeText={setDescription}
          multiline
          style={styles.multiline}
        />

        <View style={styles.pickerRow}>
          <Pressable style={[styles.pickerField, styles.pickerFieldHalf]} onPress={() => setCategoryPickerVisible(true)}>
            <Text style={styles.pickerFieldLabel}>Category (optional)</Text>
            <Text style={category ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
              {category?.name ?? "None"}
            </Text>
          </Pressable>
          <Pressable style={[styles.pickerField, styles.pickerFieldHalf]} onPress={() => setStagePickerVisible(true)}>
            <Text style={styles.pickerFieldLabel}>Stage (optional)</Text>
            <Text style={stage ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>{stage?.name ?? "None"}</Text>
          </Pressable>
        </View>

        <Pressable style={styles.pickerField} onPress={() => setReferralPartnerPickerVisible(true)}>
          <Text style={styles.pickerFieldLabel}>Referral source (optional)</Text>
          <Text style={referralPartner ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
            {referralPartner ? partnerDisplayName(referralPartner) : "None"}
          </Text>
        </Pressable>

        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable
            onPress={() => {
              setModalVisible(false);
              resetForm();
            }}
          >
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleCreate}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <PickerModal
        visible={clientPickerVisible}
        title="Select client"
        items={clients}
        getKey={(c) => c.id}
        getLabel={(c) => c.name}
        onSelect={setClient}
        onClose={() => setClientPickerVisible(false)}
      />

      <PickerModal
        visible={categoryPickerVisible}
        title="Select category"
        items={categories}
        getKey={(c) => c.id}
        getLabel={(c) => c.name}
        onSelect={setCategory}
        onClose={() => setCategoryPickerVisible(false)}
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

      <PickerModal
        visible={stagePickerVisible}
        title="Select stage"
        items={stages}
        getKey={(s) => s.id}
        getLabel={(s) => s.name}
        onSelect={setStage}
        onClose={() => setStagePickerVisible(false)}
      />

      <PickerModal
        visible={filterCategoryPickerVisible}
        title="Filter by category"
        items={categories}
        getKey={(c) => c.id}
        getLabel={(c) => c.name}
        onSelect={setFilterCategory}
        onClose={() => setFilterCategoryPickerVisible(false)}
      />

      <PickerModal
        visible={filterStagePickerVisible}
        title="Filter by stage"
        items={stages}
        getKey={(s) => s.id}
        getLabel={(s) => s.name}
        onSelect={setFilterStage}
        onClose={() => setFilterStagePickerVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  filterBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  filterChip: { backgroundColor: "#f3f4f6", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  filterChipText: { color: "#374151", fontWeight: "600", fontSize: 13 },
  filterClearText: { color: "#dc2626", fontWeight: "600", fontSize: 13 },
  sortBar: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  sortLabel: { color: "#6b7280", fontSize: 12, marginRight: 2 },
  sortChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, backgroundColor: "#f3f4f6" },
  sortChipActive: { backgroundColor: "#1d4ed8" },
  sortChipText: { color: "#374151", fontWeight: "600", fontSize: 12 },
  sortChipTextActive: { color: "#fff" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
  },
  rowTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowNumber: { fontSize: 12, fontWeight: "700", color: "#1d4ed8" },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  rowSubtitle: { color: "#6b7280", marginTop: 2 },
  tagRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6 },
  categoryTag: { flexDirection: "row", alignItems: "center", gap: 4 },
  swatch: { width: 8, height: 8, borderRadius: 4 },
  swatchEmpty: { backgroundColor: "#d1d5db" },
  categoryTagText: { fontSize: 12, color: "#6b7280", fontWeight: "600" },
  stageBadge: { backgroundColor: "#e5e7eb", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  stageBadgeText: { fontSize: 11, color: "#111827", fontWeight: "700" },
  empty: { textAlign: "center", color: "#6b7280" },
  emptyContainer: { flex: 1, justifyContent: "center", padding: 24 },
  link: { color: "#1d4ed8", fontWeight: "600" },
  fab: {
    position: "absolute",
    right: 16,
    bottom: 24,
    backgroundColor: "#1d4ed8",
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  fabText: { color: "#fff", fontWeight: "700" },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, gap: 4 },
  pickerFieldHalf: { flex: 1 },
  pickerRow: { flexDirection: "row", gap: 8 },
  pickerFieldLabel: { fontSize: 13, fontWeight: "600", color: "#374151" },
  pickerFieldText: { fontSize: 16, color: "#111827" },
  pickerFieldPlaceholder: { fontSize: 16, color: "#9ca3af" },
  clientSummary: { backgroundColor: "#f3f4f6", borderRadius: 8, padding: 10, gap: 2 },
  clientSummarySub: { fontSize: 13, color: "#6b7280" },
  multiline: { minHeight: 80, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#dc2626" },
});

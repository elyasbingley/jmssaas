import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  createJobCardSchema,
  type CalendarEvent,
  type Client,
  type JobCard,
  type JobLifecycleStage,
  type ReferralPartner,
  type ServiceCategory,
} from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { supabase } from "../../../lib/supabase";
import { formatClientAddress } from "../../../lib/format";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { ThemedModal } from "../../../components/theme/ThemedModal";
import { ThemedFormField } from "../../../components/theme/ThemedFormField";
import { ThemedPickerModal } from "../../../components/theme/ThemedPickerModal";
import { ThemedButton } from "../../../components/theme/ThemedButton";
import { partnerDisplayName } from "../../b2b-referrals/index";

// "My Schedule" - the new Jobs tab landing screen (see the Home/Jobs/
// Notifications/More tab bar restructure). Every job is split into "Jobs
// Scheduled" and "Unscheduled Jobs" by whether it has an upcoming
// calendar_events booking - calendar_events is the single source of truth
// for "when is this job happening" (see desktop Dashboard.tsx/Dispatch.tsx's
// own comments on this), not job_cards.scheduled_at, which nothing actually
// keeps in sync.
export default function JobsScreen() {
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

  const { data: jobCards } = useQuery<JobCard>(
    isAdmin
      ? "SELECT * FROM job_cards ORDER BY created_at DESC"
      : "SELECT * FROM job_cards WHERE assigned_technician_id = ? ORDER BY created_at DESC",
    isAdmin ? [] : [profile?.id ?? ""]
  );
  const { data: clients } = useQuery<Client>("SELECT * FROM clients ORDER BY name");
  const { data: categories } = useQuery<ServiceCategory>("SELECT * FROM service_categories ORDER BY name");
  const { data: stages } = useQuery<JobLifecycleStage>("SELECT * FROM job_lifecycle_stages ORDER BY position");
  const clientById = new Map(clients.map((c) => [c.id, c]));

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

  const { data: bookedEvents, refetch: refetchBookedEvents } = useSupabaseFetch<CalendarEvent[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase
      .from("calendar_events")
      .select("id, job_card_id, end_at")
      .not("job_card_id", "is", null)
      .gte("end_at", new Date().toISOString());
    if (error) throw error;
    return (data ?? []) as CalendarEvent[];
  }, [isOnline]);
  useRefetchOnFocus(refetchBookedEvents);

  const bookedJobIds = useMemo(
    () => new Set((bookedEvents ?? []).map((e) => e.job_card_id).filter((id): id is string => Boolean(id))),
    [bookedEvents]
  );

  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const searchedJobs = jobCards.filter((job) => {
    if (!query) return true;
    const client = clientById.get(job.client_id);
    return (
      job.title.toLowerCase().includes(query) ||
      (job.number ?? "").toLowerCase().includes(query) ||
      (client?.name ?? "").toLowerCase().includes(query)
    );
  });
  const scheduledJobs = searchedJobs.filter((job) => bookedJobIds.has(job.id));
  const unscheduledJobs = searchedJobs.filter((job) => !bookedJobIds.has(job.id));

  const [modalVisible, setModalVisible] = useState(false);
  const [clientPickerVisible, setClientPickerVisible] = useState(false);
  const [categoryPickerVisible, setCategoryPickerVisible] = useState(false);
  const [stagePickerVisible, setStagePickerVisible] = useState(false);
  const [referralPartnerPickerVisible, setReferralPartnerPickerVisible] = useState(false);
  const [client, setClient] = useState<Client | null>(null);
  const [category, setCategory] = useState<ServiceCategory | null>(null);
  const [stage, setStage] = useState<JobLifecycleStage | null>(null);
  const [referralPartner, setReferralPartner] = useState<ReferralPartner | null>(null);
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

  const closeModal = () => {
    setModalVisible(false);
    resetForm();
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
    router.push(`/jobs/${jobId}`);
  };

  function renderJobRow(job: JobCard) {
    const jobClient = clientById.get(job.client_id);
    const address = jobClient ? formatClientAddress(jobClient) : null;
    return (
      <Pressable key={job.id} style={styles.row} onPress={() => router.push(`/jobs/${job.id}`)}>
        <View style={styles.rowLeft}>
          <Text style={styles.rowClientName} numberOfLines={1}>
            {jobClient?.name ?? "Unknown client"}
          </Text>
          {address ? (
            <Text style={styles.rowAddress} numberOfLines={1}>
              {address}
            </Text>
          ) : null}
          {jobClient?.phone ? (
            <Text style={styles.rowAddress} numberOfLines={1}>
              {jobClient.phone}
            </Text>
          ) : null}
          <Text style={styles.rowJobTitle} numberOfLines={1}>
            {job.title}
          </Text>
        </View>
        <Text style={styles.rowNumber}>{job.number ?? "Pending sync"}</Text>
      </Pressable>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>My Schedule</Text>
          {isAdmin ? (
            <Pressable style={styles.addButton} onPress={() => setModalVisible(true)} hitSlop={8}>
              <Text style={styles.addButtonText}>+</Text>
            </Pressable>
          ) : null}
        </View>

        <TextInput
          style={styles.searchInput}
          placeholder="Search jobs..."
          placeholderTextColor={styles.searchPlaceholder.color}
          value={search}
          onChangeText={setSearch}
        />

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {!isOnline ? (
            <Text style={styles.offlineNotice}>
              Connect to see which jobs are booked - showing every job as unscheduled until then.
            </Text>
          ) : null}

          <Text style={styles.sectionHeader}>{scheduledJobs.length ? "Jobs Scheduled" : "No Jobs Scheduled"}</Text>
          {scheduledJobs.map(renderJobRow)}

          <Text style={[styles.sectionHeader, styles.sectionHeaderSpaced]}>Unscheduled Jobs</Text>
          {unscheduledJobs.length === 0 ? (
            <Text style={styles.empty}>No unscheduled jobs.</Text>
          ) : (
            unscheduledJobs.map(renderJobRow)
          )}
        </ScrollView>
      </SafeAreaView>

      <ThemedModal visible={modalVisible} onClose={closeModal}>
        <Text style={styles.modalTitle}>New Job</Text>

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
            {formatClientAddress(client) ? (
              <Text style={styles.clientSummarySub}>{formatClientAddress(client)}</Text>
            ) : null}
          </View>
        ) : null}

        <ThemedFormField label="Title" placeholder="e.g. Roof inspection" value={title} onChangeText={setTitle} />
        <ThemedFormField
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
          <Pressable onPress={closeModal}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label="Save" onPress={handleCreate} />
        </View>
      </ThemedModal>

      <ThemedPickerModal
        visible={clientPickerVisible}
        title="Select client"
        items={clients}
        getKey={(c) => c.id}
        getLabel={(c) => c.name}
        onSelect={setClient}
        onClose={() => setClientPickerVisible(false)}
      />

      <ThemedPickerModal
        visible={categoryPickerVisible}
        title="Select category"
        items={categories}
        getKey={(c) => c.id}
        getLabel={(c) => c.name}
        onSelect={setCategory}
        onClose={() => setCategoryPickerVisible(false)}
      />

      <ThemedPickerModal
        visible={referralPartnerPickerVisible}
        title="Select referral source"
        items={referralPartners ?? []}
        getKey={(p) => p.id}
        getLabel={(p) => partnerDisplayName(p)}
        onSelect={setReferralPartner}
        onClose={() => setReferralPartnerPickerVisible(false)}
      />

      <ThemedPickerModal
        visible={stagePickerVisible}
        title="Select stage"
        items={stages}
        getKey={(s) => s.id}
        getLabel={(s) => s.name}
        onSelect={setStage}
        onClose={() => setStagePickerVisible(false)}
      />
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    header: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
      paddingHorizontal: 16,
      paddingTop: 12,
    },
    headerTitle: {
      fontSize: font.title + 4,
      fontWeight: "700" as const,
      color: tokens.textPrimary,
      letterSpacing: 1,
      ...mono,
    },
    addButton: {
      width: 36,
      height: 36,
      borderRadius: 3,
      borderWidth: 1,
      borderColor: tokens.accent,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: tokens.accentGlow,
    },
    addButtonText: { color: tokens.accent, fontSize: 22, fontWeight: "700" as const, marginTop: -2, ...mono },
    searchInput: {
      marginHorizontal: 16,
      marginTop: 12,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 3,
      padding: 12,
      fontSize: font.body,
      color: tokens.textPrimary,
      backgroundColor: tokens.surface,
      ...mono,
    },
    searchPlaceholder: { color: tokens.textMuted },
    list: { flex: 1, marginTop: 8 },
    listContent: { paddingBottom: 24 },
    offlineNotice: {
      marginHorizontal: 16,
      marginBottom: 4,
      color: tokens.textMuted,
      fontSize: font.label,
      ...mono,
    },
    sectionHeader: {
      marginHorizontal: 16,
      marginTop: 12,
      marginBottom: 4,
      color: tokens.accent,
      fontWeight: "700" as const,
      fontSize: font.label,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    sectionHeaderSpaced: { marginTop: 20 },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      marginHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
      gap: 12,
    },
    rowLeft: { flex: 1, gap: 1 },
    rowClientName: { fontSize: font.body + 1, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    rowAddress: { fontSize: font.body + 1, color: tokens.textPrimary, ...mono },
    rowJobTitle: { fontSize: font.label, color: tokens.textMuted, marginTop: 3, ...mono },
    rowNumber: { fontSize: font.label, fontWeight: "700" as const, color: tokens.accent, letterSpacing: 1, ...mono },
    empty: { marginHorizontal: 16, color: tokens.textMuted, fontSize: font.body - 1, ...mono },
    modalTitle: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      marginBottom: 4,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    pickerField: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, backgroundColor: tokens.background, gap: 4 },
    pickerFieldHalf: { flex: 1 },
    pickerRow: { flexDirection: "row" as const, gap: 8 },
    pickerFieldLabel: {
      fontSize: font.label,
      fontWeight: "700" as const,
      color: tokens.textMuted,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      ...mono,
    },
    pickerFieldText: { fontSize: font.body, color: tokens.textPrimary, ...mono },
    pickerFieldPlaceholder: { fontSize: font.body, color: tokens.textMuted, ...mono },
    clientSummary: { backgroundColor: tokens.background, borderRadius: 3, borderWidth: 1, borderColor: tokens.border, padding: 10, gap: 2 },
    clientSummarySub: { fontSize: font.label, color: tokens.textMuted, ...mono },
    multiline: { minHeight: 80, textAlignVertical: "top" as const },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 20, marginTop: 8 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    error: { color: tokens.danger, ...mono },
  };
}

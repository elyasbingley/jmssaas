import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ThemeTokens } from "@jmssaas/shared";
import {
  createReportCategorySchema,
  createReportSubcategorySchema,
  type Client,
  type JobCard,
  type Profile,
  type ReportCategory,
  type ReportInstance,
  type ReportInstanceStatus,
  type ReportSubcategory,
  type ReportTemplate,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useIsOnline } from "../../lib/connectivity";
import { useAuth } from "../../lib/auth-context";
import { useTheme } from "../../lib/theme-context";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../lib/errors";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedModal } from "../../components/theme/ThemedModal";
import { ThemedPickerModal } from "../../components/theme/ThemedPickerModal";
import { ThemedFormField } from "../../components/theme/ThemedFormField";
import { ThemedButton } from "../../components/theme/ThemedButton";

// Mobile port of apps/desktop/src/pages/Reports.tsx's three sub-tabs. Like
// Real Estate & Strata (app/real-estate/), none of report_categories/
// report_subcategories/report_templates/report_instances/report_signatures
// are PowerSync tables - RLS on all five is admin-only for insert/update/
// delete (see the reports_safety_engine migration), so there's no offline
// field-technician write path to support even on desktop today. This screen
// is therefore Supabase-direct and connection-gated, same as Real Estate.

type SubTab = "new" | "history" | "studio";

export function getStatusColors(tokens: ThemeTokens): Record<ReportInstanceStatus, { color: string }> {
  return {
    draft: { color: tokens.warning },
    completed: { color: tokens.accent },
    archived: { color: tokens.textMuted },
  };
}

export default function ReportsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";
  const [tab, setTab] = useState<SubTab>("new");
  const styles = useThemedStyles(createStyles);

  const { data: categories, refetch: refetchCategories } = useSupabaseFetch<ReportCategory[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("report_categories").select("*").order("name");
    if (error) throw error;
    return data as ReportCategory[];
  }, [isOnline]);
  const { data: subcategories, refetch: refetchSubcategories } = useSupabaseFetch<ReportSubcategory[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("report_subcategories").select("*").order("name");
    if (error) throw error;
    return data as ReportSubcategory[];
  }, [isOnline]);
  const { data: templates, refetch: refetchTemplates } = useSupabaseFetch<ReportTemplate[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("report_templates").select("*").order("title");
    if (error) throw error;
    return data as ReportTemplate[];
  }, [isOnline]);
  const { data: instances, refetch: refetchInstances } = useSupabaseFetch<ReportInstance[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("report_instances").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return data as ReportInstance[];
  }, [isOnline]);
  const { data: jobs } = useSupabaseFetch<JobCard[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("job_cards").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return data as JobCard[];
  }, [isOnline]);
  const { data: clients } = useSupabaseFetch<Client[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("clients").select("*").order("name");
    if (error) throw error;
    return data as Client[];
  }, [isOnline]);
  const { data: profiles } = useSupabaseFetch<Profile[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("profiles").select("*");
    if (error) throw error;
    return data as Profile[];
  }, [isOnline]);

  useRefetchOnFocus(async () => {
    await Promise.all([refetchCategories(), refetchSubcategories(), refetchTemplates(), refetchInstances()]);
  });

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.link}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Forms & Certificates</Text>
      </View>

      {!isOnline ? (
        <ThemedRequiresConnectionNotice label="Reports & Safety" />
      ) : (
        <View style={styles.container}>
          <View style={styles.tabRow}>
            {(
              [
                { key: "new", label: "New Report" },
                { key: "history", label: "History" },
                { key: "studio", label: "Template Studio" },
              ] as { key: SubTab; label: string }[]
            ).map((t) => (
              <Pressable key={t.key} style={[styles.tab, tab === t.key && styles.tabActive]} onPress={() => setTab(t.key)}>
                <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </View>

          {tab === "new" ? (
            <NewReportTab
              categories={categories ?? []}
              subcategories={subcategories ?? []}
              templates={(templates ?? []).filter((t) => t.is_active)}
            />
          ) : tab === "history" ? (
            <ReportHistoryTab
              instances={instances ?? []}
              templates={templates ?? []}
              jobs={jobs ?? []}
              clients={clients ?? []}
              profiles={profiles ?? []}
              onLinked={refetchInstances}
            />
          ) : (
            <TemplateStudioTab
              categories={categories ?? []}
              subcategories={subcategories ?? []}
              templates={templates ?? []}
              isAdmin={isAdmin}
              onCategoriesChanged={refetchCategories}
              onSubcategoriesChanged={refetchSubcategories}
            />
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// New Report
// ---------------------------------------------------------------------------

function NewReportTab({
  categories,
  subcategories,
  templates,
}: {
  categories: ReportCategory[];
  subcategories: ReportSubcategory[];
  templates: ReportTemplate[];
}) {
  const router = useRouter();
  const { profile } = useAuth();
  const styles = useThemedStyles(createStyles);
  const [search, setSearch] = useState("");
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const filteredTemplates = search.trim()
    ? templates.filter((t) => t.title.toLowerCase().includes(search.trim().toLowerCase()))
    : templates;

  const subcategoriesByCategory = (categoryId: string) => subcategories.filter((s) => s.category_id === categoryId);
  const templatesBySubcategory = (subcategoryId: string) => filteredTemplates.filter((t) => t.subcategory_id === subcategoryId);

  const startReport = async (templateId: string) => {
    if (!profile) return;
    setStarting(templateId);
    setStartError(null);
    const { data, error } = await supabase
      .from("report_instances")
      .insert({ tenant_id: profile.tenant_id, template_id: templateId, created_by: profile.id, status: "draft" })
      .select("id")
      .single();
    setStarting(null);
    if (error) {
      setStartError(getErrorMessage(error, "Failed to start report"));
      return;
    }
    router.push(`/reports/instance/${data.id}`);
  };

  return (
    <ScrollView style={styles.tabBody} contentContainerStyle={{ paddingBottom: 40 }}>
      <ThemedFormField label="Search templates" value={search} onChangeText={setSearch} placeholder="Search by title..." />
      {startError ? <Text style={styles.error}>{startError}</Text> : null}

      {categories.length === 0 ? (
        <Text style={styles.empty}>No report templates yet - build one in Template Studio.</Text>
      ) : (
        categories.map((category) => {
          const catSubcategories = subcategoriesByCategory(category.id);
          const catTemplateCount = catSubcategories.reduce((sum, s) => sum + templatesBySubcategory(s.id).length, 0);
          if (catTemplateCount === 0) return null;
          return (
            <View key={category.id} style={styles.categoryBlock}>
              <Text style={styles.categoryTitle}>{category.name}</Text>
              {catSubcategories.map((sub) => {
                const subTemplates = templatesBySubcategory(sub.id);
                if (subTemplates.length === 0) return null;
                return (
                  <View key={sub.id} style={styles.subBlock}>
                    <Text style={styles.subTitle}>{sub.name}</Text>
                    {subTemplates.map((template) => (
                      <Pressable
                        key={template.id}
                        style={styles.templateCard}
                        onPress={() => startReport(template.id)}
                        disabled={starting === template.id}
                      >
                        <Text style={styles.templateCardTitle}>{template.title}</Text>
                        {template.description ? <Text style={styles.templateCardDesc}>{template.description}</Text> : null}
                        {template.is_swms ? (
                          <View style={styles.swmsBadge}>
                            <Text style={styles.swmsBadgeText}>SWMS sign-off required</Text>
                          </View>
                        ) : null}
                      </Pressable>
                    ))}
                  </View>
                );
              })}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Report History
// ---------------------------------------------------------------------------

function ReportHistoryTab({
  instances,
  templates,
  jobs,
  clients,
  profiles,
  onLinked,
}: {
  instances: ReportInstance[];
  templates: ReportTemplate[];
  jobs: JobCard[];
  clients: Client[];
  profiles: Profile[];
  onLinked: () => void;
}) {
  const router = useRouter();
  const { tokens } = useTheme();
  const styles = useThemedStyles(createStyles);
  const statusColors = getStatusColors(tokens);
  const templateById = new Map(templates.map((t) => [t.id, t]));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  const [linkingInstance, setLinkingInstance] = useState<ReportInstance | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [jobPickerVisible, setJobPickerVisible] = useState(false);

  const linkToJob = async (job: JobCard) => {
    if (!linkingInstance) return;
    const { error } = await supabase
      .from("report_instances")
      .update({ job_card_id: job.id, client_id: job.client_id })
      .eq("id", linkingInstance.id);
    if (error) {
      setLinkError(getErrorMessage(error, "Failed to link report"));
      return;
    }
    setLinkingInstance(null);
    onLinked();
  };

  return (
    <ScrollView style={styles.tabBody} contentContainerStyle={{ paddingBottom: 40 }}>
      {instances.length === 0 ? (
        <Text style={styles.empty}>No reports yet.</Text>
      ) : (
        instances.map((instance) => {
          const template = templateById.get(instance.template_id);
          const job = instance.job_card_id ? jobById.get(instance.job_card_id) : null;
          const author = instance.created_by ? profileById.get(instance.created_by) : null;
          const color = statusColors[instance.status].color;
          return (
            <Pressable key={instance.id} style={styles.historyRow} onPress={() => router.push(`/reports/instance/${instance.id}`)}>
              <View style={styles.historyRowHeader}>
                <Text style={styles.historyTitle}>{template?.title ?? "Unknown template"}</Text>
                <View style={[styles.statusBadge, { borderColor: color }]}>
                  <Text style={[styles.statusBadgeText, { color }]}>
                    {instance.status.charAt(0).toUpperCase() + instance.status.slice(1)}
                  </Text>
                </View>
              </View>
              {job ? (
                <Text style={styles.historyMeta}>Job: {job.number ?? job.title}</Text>
              ) : (
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation();
                    setLinkingInstance(instance);
                    setLinkError(null);
                    setJobPickerVisible(true);
                  }}
                >
                  <Text style={styles.link}>Link to Job</Text>
                </Pressable>
              )}
              <Text style={styles.historyMeta}>Created by: {author?.full_name ?? "-"}</Text>
              {instance.completed_at ? (
                <Text style={styles.historyMeta}>Completed: {new Date(instance.completed_at).toLocaleDateString("en-AU")}</Text>
              ) : null}
            </Pressable>
          );
        })
      )}

      {linkError ? <Text style={styles.error}>{linkError}</Text> : null}

      <ThemedPickerModal
        visible={jobPickerVisible}
        title="Select job"
        items={jobs}
        getKey={(j) => j.id}
        getLabel={(j) => `${j.number ?? "Pending"} - ${j.title} (${clientById.get(j.client_id)?.name ?? "Unknown client"})`}
        onSelect={linkToJob}
        onClose={() => setJobPickerVisible(false)}
      />
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Template Studio
// ---------------------------------------------------------------------------

function TemplateStudioTab({
  categories,
  subcategories,
  templates,
  isAdmin,
  onCategoriesChanged,
  onSubcategoriesChanged,
}: {
  categories: ReportCategory[];
  subcategories: ReportSubcategory[];
  templates: ReportTemplate[];
  isAdmin: boolean;
  onCategoriesChanged: () => void;
  onSubcategoriesChanged: () => void;
}) {
  const router = useRouter();
  const { profile } = useAuth();
  const styles = useThemedStyles(createStyles);
  const [expandedCategoryIds, setExpandedCategoryIds] = useState<Set<string>>(new Set());
  const toggleCategory = (id: string) => {
    setExpandedCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const subcategoriesByCategory = (categoryId: string) => subcategories.filter((s) => s.category_id === categoryId);
  const templatesBySubcategory = (subcategoryId: string) => templates.filter((t) => t.subcategory_id === subcategoryId);

  const [categoryModalVisible, setCategoryModalVisible] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categoryDescription, setCategoryDescription] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [categorySaving, setCategorySaving] = useState(false);

  const openNewCategory = () => {
    setCategoryName("");
    setCategoryDescription("");
    setCategoryError(null);
    setCategoryModalVisible(true);
  };

  const saveCategory = async () => {
    const result = createReportCategorySchema.safeParse({ name: categoryName, description: categoryDescription });
    if (!result.success) {
      setCategoryError(result.error.issues[0]?.message ?? "Invalid category");
      return;
    }
    if (!profile) return;
    setCategorySaving(true);
    const { error } = await supabase.from("report_categories").insert({
      tenant_id: profile.tenant_id,
      name: result.data.name,
      description: result.data.description || null,
    });
    setCategorySaving(false);
    if (error) {
      setCategoryError(getErrorMessage(error, "Failed to create category"));
      return;
    }
    setCategoryModalVisible(false);
    onCategoriesChanged();
  };

  const [subcategoryModalVisible, setSubcategoryModalVisible] = useState(false);
  const [subCategoryId, setSubCategoryId] = useState("");
  const [subName, setSubName] = useState("");
  const [subError, setSubError] = useState<string | null>(null);
  const [subSaving, setSubSaving] = useState(false);
  const [categoryPickerVisible, setCategoryPickerVisible] = useState(false);

  const openNewSubcategory = (categoryId?: string) => {
    setSubCategoryId(categoryId ?? "");
    setSubName("");
    setSubError(null);
    setSubcategoryModalVisible(true);
  };

  const saveSubcategory = async () => {
    const result = createReportSubcategorySchema.safeParse({ category_id: subCategoryId, name: subName });
    if (!result.success) {
      setSubError(result.error.issues[0]?.message ?? "Invalid subcategory");
      return;
    }
    if (!profile) return;
    setSubSaving(true);
    const { error } = await supabase.from("report_subcategories").insert({
      tenant_id: profile.tenant_id,
      category_id: result.data.category_id,
      name: result.data.name,
    });
    setSubSaving(false);
    if (error) {
      setSubError(getErrorMessage(error, "Failed to create subcategory"));
      return;
    }
    setSubcategoryModalVisible(false);
    onSubcategoriesChanged();
  };

  return (
    <ScrollView style={styles.tabBody} contentContainerStyle={{ paddingBottom: 40 }}>
      {isAdmin ? (
        <View style={styles.studioActions}>
          <Pressable style={styles.secondaryButton} onPress={() => openNewSubcategory()}>
            <Text style={styles.secondaryButtonText}>+ Add Subcategory</Text>
          </Pressable>
          <ThemedButton label="+ Add Category" onPress={openNewCategory} />
        </View>
      ) : null}

      {categories.length === 0 ? (
        <Text style={styles.empty}>No categories yet.</Text>
      ) : (
        categories.map((category) => {
          const expanded = expandedCategoryIds.has(category.id);
          const subs = subcategoriesByCategory(category.id);
          return (
            <View key={category.id} style={styles.treeCard}>
              <Pressable style={styles.treeCardHeader} onPress={() => toggleCategory(category.id)}>
                <Text style={styles.treeChevron}>{expanded ? "▾" : "▸"}</Text>
                <Text style={styles.treeCardTitle}>{category.name}</Text>
                <Text style={styles.treeCardMeta}>
                  {subs.length} subcategor{subs.length === 1 ? "y" : "ies"}
                </Text>
              </Pressable>
              {expanded ? (
                <View style={styles.treeCardBody}>
                  {subs.length === 0 ? (
                    <Text style={styles.empty}>No subcategories yet.</Text>
                  ) : (
                    subs.map((sub) => {
                      const subTemplates = templatesBySubcategory(sub.id);
                      return (
                        <View key={sub.id} style={styles.subTreeItem}>
                          <Text style={styles.subTreeTitle}>{sub.name}</Text>
                          {subTemplates.map((template) => (
                            <Pressable
                              key={template.id}
                              style={styles.subTreeTemplateRow}
                              onPress={() => router.push(`/reports/template/${template.id}`)}
                            >
                              <Text style={styles.link}>{template.title}</Text>
                              <Text style={styles.treeCardMeta}>{template.is_active ? "Active" : "Inactive"}</Text>
                            </Pressable>
                          ))}
                          {isAdmin ? (
                            <Pressable onPress={() => router.push(`/reports/template/new?subcategoryId=${sub.id}`)}>
                              <Text style={styles.smallLink}>+ New template in {sub.name}</Text>
                            </Pressable>
                          ) : null}
                        </View>
                      );
                    })
                  )}
                  {isAdmin ? (
                    <Pressable onPress={() => openNewSubcategory(category.id)}>
                      <Text style={styles.smallLink}>+ Add subcategory to {category.name}</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })
      )}

      <ThemedModal visible={categoryModalVisible} onClose={() => setCategoryModalVisible(false)}>
        <Text style={styles.modalTitle}>New category</Text>
        <ThemedFormField label="Name" value={categoryName} onChangeText={setCategoryName} placeholder="e.g. WHS & Safety" />
        <ThemedFormField
          label="Description (optional)"
          value={categoryDescription}
          onChangeText={setCategoryDescription}
          placeholder="Optional description"
          multiline
        />
        {categoryError ? <Text style={styles.error}>{categoryError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setCategoryModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label={categorySaving ? "Saving..." : "Save"} onPress={saveCategory} disabled={categorySaving} />
        </View>
      </ThemedModal>

      <ThemedModal visible={subcategoryModalVisible} onClose={() => setSubcategoryModalVisible(false)}>
        <Text style={styles.modalTitle}>New subcategory</Text>
        <Pressable style={styles.pickerField} onPress={() => setCategoryPickerVisible(true)}>
          <Text style={styles.pickerFieldLabel}>Category</Text>
          <Text style={styles.pickerFieldValue}>
            {categories.find((c) => c.id === subCategoryId)?.name ?? "Select category"}
          </Text>
        </Pressable>
        <ThemedFormField label="Name" value={subName} onChangeText={setSubName} placeholder="e.g. Safety Forms" />
        {subError ? <Text style={styles.error}>{subError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setSubcategoryModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label={subSaving ? "Saving..." : "Save"} onPress={saveSubcategory} disabled={subSaving || !subCategoryId} />
        </View>
      </ThemedModal>

      <ThemedPickerModal
        visible={categoryPickerVisible}
        title="Select category"
        items={categories}
        getKey={(c) => c.id}
        getLabel={(c) => c.name}
        onSelect={(c) => setSubCategoryId(c.id)}
        onClose={() => setCategoryPickerVisible(false)}
      />
    </ScrollView>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
    title: { ...mono, fontSize: font.title, fontWeight: "700" as const, color: tokens.textPrimary },
    container: { flex: 1, backgroundColor: tokens.background },
    tabRow: { flexDirection: "row" as const, borderBottomWidth: 1, borderBottomColor: tokens.border },
    tab: { flex: 1, paddingVertical: 12, alignItems: "center" as const, borderBottomWidth: 2, borderBottomColor: "transparent" },
    tabActive: { borderBottomColor: tokens.accent },
    tabText: { ...mono, fontSize: font.label, fontWeight: "600" as const, color: tokens.textMuted, textTransform: "uppercase" as const },
    tabTextActive: { color: tokens.accent },
    tabBody: { flex: 1, padding: 16 },
    error: { ...mono, color: tokens.danger, marginTop: 8, fontSize: font.body },
    empty: { ...mono, color: tokens.textMuted, textAlign: "center" as const, marginTop: 16, fontSize: font.body },
    link: { ...mono, color: tokens.accent, fontWeight: "600" as const, fontSize: font.body },
    smallLink: { ...mono, color: tokens.accent, fontWeight: "600" as const, fontSize: font.label, marginTop: 4 },

    categoryBlock: { marginTop: 20 },
    categoryTitle: { ...mono, fontSize: font.label, fontWeight: "700" as const, color: tokens.accent, textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 8 },
    subBlock: { marginBottom: 12 },
    subTitle: { ...mono, fontSize: font.label, fontWeight: "600" as const, color: tokens.textMuted, marginBottom: 6 },
    templateCard: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, padding: 14, marginBottom: 8 },
    templateCardTitle: { ...mono, fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary },
    templateCardDesc: { ...mono, fontSize: font.label, color: tokens.textMuted, marginTop: 2 },
    swmsBadge: { alignSelf: "flex-start" as const, borderWidth: 1, borderColor: tokens.warning, backgroundColor: tokens.surface, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, marginTop: 8 },
    swmsBadgeText: { ...mono, fontSize: font.label, fontWeight: "700" as const, color: tokens.warning },

    historyRow: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, padding: 14, marginBottom: 10 },
    historyRowHeader: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "flex-start" as const, gap: 8 },
    historyTitle: { ...mono, fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary, flex: 1 },
    historyMeta: { ...mono, fontSize: font.label, color: tokens.textMuted, marginTop: 4 },
    statusBadge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
    statusBadgeText: { ...mono, fontSize: font.label, fontWeight: "700" as const },

    studioActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: 8, marginBottom: 16 },
    secondaryButton: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, paddingHorizontal: 14, paddingVertical: 10, alignItems: "center" as const },
    secondaryButtonText: { ...mono, color: tokens.accent, fontWeight: "700" as const, fontSize: font.button, letterSpacing: 1, textTransform: "uppercase" as const },

    treeCard: { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 4, marginBottom: 10 },
    treeCardHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, padding: 14 },
    treeChevron: { color: tokens.textMuted, fontSize: font.label },
    treeCardTitle: { flex: 1, ...mono, fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary },
    treeCardMeta: { ...mono, fontSize: font.label, color: tokens.textMuted },
    treeCardBody: { borderTopWidth: 1, borderTopColor: tokens.border, padding: 14, gap: 10 },
    subTreeItem: { marginLeft: 8, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: tokens.border, gap: 4 },
    subTreeTitle: { ...mono, fontSize: font.label, fontWeight: "700" as const, color: tokens.textPrimary },
    subTreeTemplateRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, paddingVertical: 4 },

    modalTitle: { ...mono, fontSize: font.title, fontWeight: "700" as const, color: tokens.textPrimary },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 16, marginTop: 4 },
    pickerField: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, backgroundColor: tokens.background },
    pickerFieldLabel: { ...mono, fontSize: font.label, color: tokens.textMuted, marginBottom: 2 },
    pickerFieldValue: { ...mono, fontSize: font.body, color: tokens.textPrimary },
  };
}

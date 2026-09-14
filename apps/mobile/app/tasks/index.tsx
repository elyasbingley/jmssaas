import { useMemo, useState } from "react";
import { FlatList, Pressable, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createTaskSchema, type Profile, type Task, type TaskPriority, type TaskProject, type TaskSection, type TaskStatus } from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedModal } from "../../components/theme/ThemedModal";
import { ThemedFormField } from "../../components/theme/ThemedFormField";
import { ThemedDateField } from "../../components/theme/ThemedDateField";
import { ThemedPickerModal } from "../../components/theme/ThemedPickerModal";
import { ThemedButton } from "../../components/theme/ThemedButton";

const STATUSES: TaskStatus[] = ["todo", "in_progress", "done"];
const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};
const PRIORITIES: TaskPriority[] = ["low", "medium", "high", "urgent"];
const PRIORITY_LABELS: Record<TaskPriority, string> = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };

type StatusFilter = TaskStatus | "all";
type QuickFilter = "all" | "mine" | "due_today";

function toDateInput(d: Date | null): string | undefined {
  if (!d) return undefined;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function TasksScreen() {
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  // Every device syncs the whole tenant's tasks table (see
  // powersync/sync-rules.yaml), so unlike Postgres RLS this local query has
  // to apply the "assigned to me" restriction itself for technicians.
  const { data: tasks } = useQuery<Task>(
    isAdmin
      ? "SELECT * FROM tasks ORDER BY (due_date IS NULL), due_date, created_at DESC"
      : "SELECT * FROM tasks WHERE assigned_to = ? ORDER BY (due_date IS NULL), due_date, created_at DESC",
    isAdmin ? [] : [profile?.id ?? ""]
  );
  const { data: projects } = useQuery<TaskProject>("SELECT * FROM task_projects ORDER BY name");
  const { data: profiles } = useQuery<Profile>("SELECT * FROM profiles ORDER BY full_name");

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const { data: sections } = useQuery<TaskSection>(
    "SELECT * FROM task_sections WHERE project_id = ? ORDER BY position_order",
    [selectedProjectId ?? ""]
  );
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");

  const todayStr = toDateInput(new Date());

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (selectedProjectId && t.project_id !== selectedProjectId) return false;
      if (selectedSectionId && t.section_id !== selectedSectionId) return false;
      if (quickFilter === "mine" && t.assigned_to !== profile?.id) return false;
      if (quickFilter === "due_today" && t.due_date !== todayStr) return false;
      return true;
    });
  }, [tasks, statusFilter, selectedProjectId, selectedSectionId, quickFilter, profile?.id, todayStr]);

  const [modalVisible, setModalVisible] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState<Date | null>(null);
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [isMilestone, setIsMilestone] = useState(false);
  const [assignee, setAssignee] = useState<Profile | null>(null);
  const [assigneePickerVisible, setAssigneePickerVisible] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setDueDate(null);
    setPriority("medium");
    setIsMilestone(false);
    setAssignee(null);
    setFormError(null);
  };

  const closeModal = () => {
    setModalVisible(false);
    resetForm();
  };

  const handleCreate = async () => {
    const result = createTaskSchema.safeParse({
      title,
      description,
      due_date: toDateInput(dueDate),
      priority,
      is_milestone: isMilestone,
      assigned_to: assignee?.id,
      project_id: selectedProjectId ?? undefined,
      section_id: selectedSectionId ?? undefined,
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Invalid task");
      return;
    }
    if (!profile) return;

    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO tasks (id, tenant_id, title, description, status, due_date, priority, is_milestone, assigned_to, project_id, section_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        profile.tenant_id,
        result.data.title,
        result.data.description || null,
        result.data.due_date || null,
        result.data.priority,
        result.data.is_milestone ? 1 : 0,
        result.data.assigned_to || null,
        result.data.project_id || null,
        result.data.section_id || null,
        profile.id,
        now,
        now,
      ]
    );

    resetForm();
    setModalVisible(false);
  };

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Tasks</Text>
          {isAdmin ? (
            <Pressable style={styles.addButton} onPress={() => setModalVisible(true)} hitSlop={8}>
              <Text style={styles.addButtonText}>+</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.filterRow}>
          <Pressable
            style={[styles.filterChip, selectedProjectId === null && styles.filterChipActive]}
            onPress={() => {
              setSelectedProjectId(null);
              setSelectedSectionId(null);
            }}
          >
            <Text style={[styles.filterChipText, selectedProjectId === null && styles.filterChipTextActive]}>All Projects</Text>
          </Pressable>
          {projects.map((project) => (
            <Pressable
              key={project.id}
              style={[styles.filterChip, selectedProjectId === project.id && styles.filterChipActive]}
              onPress={() => {
                setSelectedProjectId(project.id);
                setSelectedSectionId(null);
              }}
            >
              <Text style={[styles.filterChipText, selectedProjectId === project.id && styles.filterChipTextActive]}>{project.name}</Text>
            </Pressable>
          ))}
        </View>

        {selectedProjectId && sections.length > 0 ? (
          <View style={styles.filterRow}>
            <Pressable
              style={[styles.filterChip, selectedSectionId === null && styles.filterChipActive]}
              onPress={() => setSelectedSectionId(null)}
            >
              <Text style={[styles.filterChipText, selectedSectionId === null && styles.filterChipTextActive]}>All sections</Text>
            </Pressable>
            {sections.map((section) => (
              <Pressable
                key={section.id}
                style={[styles.filterChip, selectedSectionId === section.id && styles.filterChipActive]}
                onPress={() => setSelectedSectionId(section.id)}
              >
                <Text style={[styles.filterChipText, selectedSectionId === section.id && styles.filterChipTextActive]}>{section.name}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={styles.filterRow}>
          {(["all", "mine", "due_today"] as QuickFilter[]).map((f) => (
            <Pressable key={f} style={[styles.filterChip, quickFilter === f && styles.filterChipActive]} onPress={() => setQuickFilter(f)}>
              <Text style={[styles.filterChipText, quickFilter === f && styles.filterChipTextActive]}>
                {f === "all" ? "All" : f === "mine" ? "My Tasks" : "Due Today"}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.filterRow}>
          {(["all", ...STATUSES] as StatusFilter[]).map((status) => (
            <Pressable
              key={status}
              style={[styles.filterChip, statusFilter === status && styles.filterChipActive]}
              onPress={() => setStatusFilter(status)}
            >
              <Text style={[styles.filterChipText, statusFilter === status && styles.filterChipTextActive]}>
                {status === "all" ? "All" : STATUS_LABELS[status]}
              </Text>
            </Pressable>
          ))}
        </View>

        <FlatList
          style={styles.list}
          data={filteredTasks}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => router.push(`/tasks/${item.id}`)}>
              <View style={{ flex: 1 }}>
                <View style={styles.rowTitleRow}>
                  <Text style={styles.rowNumber}>{item.number ?? "Pending sync"}</Text>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {item.is_milestone ? "🔶 " : ""}
                    {item.title}
                  </Text>
                </View>
                {item.due_date ? <Text style={styles.rowSubtitle}>Due {item.due_date}</Text> : null}
              </View>
              <Text style={styles.statusBadge}>{STATUS_LABELS[item.status]}</Text>
            </Pressable>
          )}
          ListEmptyComponent={<Text style={styles.empty}>No tasks here.</Text>}
          contentContainerStyle={filteredTasks.length === 0 ? styles.emptyContainer : styles.listContent}
        />
      </SafeAreaView>

      <ThemedModal visible={modalVisible} onClose={closeModal}>
        <Text style={styles.modalTitle}>New Task</Text>
        <ThemedFormField label="Title" placeholder="Task title" value={title} onChangeText={setTitle} />
        <ThemedFormField
          label="Description (optional)"
          placeholder="Description"
          value={description}
          onChangeText={setDescription}
          multiline
          style={styles.multiline}
        />
        <ThemedDateField label="Due date (optional)" value={dueDate} onChange={setDueDate} mode="date" placeholder="No due date" />

        <Text style={styles.fieldLabel}>Priority</Text>
        <View style={styles.priorityRow}>
          {PRIORITIES.map((p) => (
            <Pressable key={p} style={[styles.filterChip, priority === p && styles.filterChipActive]} onPress={() => setPriority(p)}>
              <Text style={[styles.filterChipText, priority === p && styles.filterChipTextActive]}>{PRIORITY_LABELS[p]}</Text>
            </Pressable>
          ))}
        </View>

        <Pressable style={styles.assigneeRow} onPress={() => setAssigneePickerVisible(true)}>
          <Text style={styles.fieldLabel}>Assignee</Text>
          <Text style={styles.link}>{assignee?.full_name ?? "Unassigned"}</Text>
        </Pressable>

        <View style={styles.switchRow}>
          <Text style={styles.fieldLabel}>Milestone</Text>
          <Switch value={isMilestone} onValueChange={setIsMilestone} trackColor={{ true: styles.switchOn.color }} />
        </View>

        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={closeModal}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label="Save" onPress={handleCreate} />
        </View>
      </ThemedModal>

      <ThemedPickerModal
        visible={assigneePickerVisible}
        title="Select assignee"
        items={[null, ...profiles]}
        getKey={(p) => p?.id ?? "none"}
        getLabel={(p) => p?.full_name ?? "Unassigned"}
        onSelect={setAssignee}
        onClose={() => setAssigneePickerVisible(false)}
      />
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
      paddingHorizontal: 16,
      paddingTop: 12,
    },
    headerTitle: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
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
    filterRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, paddingHorizontal: 12, paddingTop: 12 },
    filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 3, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface },
    filterChipActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    filterChipText: { color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.label, ...mono },
    filterChipTextActive: { color: tokens.accent },
    list: { flex: 1, marginTop: 8 },
    listContent: { paddingBottom: 24 },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      marginHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
      gap: 8,
    },
    rowTitleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    rowNumber: { fontSize: font.label, fontWeight: "700" as const, color: tokens.accent, flexShrink: 0, ...mono },
    rowTitle: { fontSize: font.body, fontWeight: "600" as const, color: tokens.textPrimary, flex: 1, ...mono },
    rowSubtitle: { color: tokens.textMuted, marginTop: 2, fontSize: font.label, ...mono },
    statusBadge: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.label, flexShrink: 0, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, ...mono },
    emptyContainer: { flex: 1, justifyContent: "center" as const, padding: 24 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    modalTitle: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      marginBottom: 4,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    multiline: { minHeight: 70, textAlignVertical: "top" as const },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 20, marginTop: 8 },
    error: { color: tokens.danger, ...mono },
    fieldLabel: {
      fontWeight: "700" as const,
      color: tokens.textMuted,
      marginTop: 10,
      marginBottom: 6,
      fontSize: font.label,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      ...mono,
    },
    priorityRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginBottom: 6 },
    assigneeRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, marginTop: 4 },
    switchRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, marginTop: 10 },
    switchOn: { color: tokens.accent },
  };
}

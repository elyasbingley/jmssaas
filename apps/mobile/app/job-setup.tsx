import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  createJobLifecycleStageSchema,
  createServiceCategorySchema,
  type JobLifecycleStage,
  type ServiceCategory,
} from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { CenteredModal } from "../components/CenteredModal";
import { FormField } from "../components/FormField";

// Reached via a small admin-only "Job Setup" link on Home, alongside
// "Company Settings" and "Team" - same "occasional setup screen, not a
// daily tool" reasoning (see team.tsx). Unlike Team/Company Settings/Price
// Book, this screen edits PowerSync-synced tables (service_categories,
// job_lifecycle_stages are in the tenant_reference_data bucket - see
// powersync/sync-rules.yaml), so it works offline like the Jobs screen
// does: reads via useQuery, writes via powersync.execute(), no
// RequiresConnectionNotice gate.
export default function JobSetupScreen() {
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  const { data: categories } = useQuery<ServiceCategory>("SELECT * FROM service_categories ORDER BY name");
  const { data: stages } = useQuery<JobLifecycleStage>("SELECT * FROM job_lifecycle_stages ORDER BY position");

  const [categoryModalVisible, setCategoryModalVisible] = useState(false);
  const [editingCategory, setEditingCategory] = useState<ServiceCategory | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryColor, setCategoryColor] = useState("");
  const [categoryMaintenanceInterval, setCategoryMaintenanceInterval] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const [stageModalVisible, setStageModalVisible] = useState(false);
  const [editingStage, setEditingStage] = useState<JobLifecycleStage | null>(null);
  const [stageName, setStageName] = useState("");
  const [stageColor, setStageColor] = useState("");
  const [stageIsClosed, setStageIsClosed] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);

  const openNewCategory = () => {
    setEditingCategory(null);
    setCategoryName("");
    setCategoryColor("");
    setCategoryMaintenanceInterval("");
    setCategoryError(null);
    setCategoryModalVisible(true);
  };

  const openEditCategory = (category: ServiceCategory) => {
    setEditingCategory(category);
    setCategoryName(category.name);
    setCategoryColor(category.color ?? "");
    setCategoryMaintenanceInterval(
      category.maintenance_interval_months != null ? String(category.maintenance_interval_months) : ""
    );
    setCategoryError(null);
    setCategoryModalVisible(true);
  };

  const handleSaveCategory = async () => {
    const result = createServiceCategorySchema.safeParse({
      name: categoryName,
      color: categoryColor || undefined,
      maintenance_interval_months: categoryMaintenanceInterval ? Number(categoryMaintenanceInterval) : undefined,
    });
    if (!result.success) {
      setCategoryError(result.error.issues[0]?.message ?? "Invalid category");
      return;
    }
    if (!profile) return;

    const now = new Date().toISOString();
    if (editingCategory) {
      await powersync.execute(
        "UPDATE service_categories SET name = ?, color = ?, maintenance_interval_months = ?, updated_at = ? WHERE id = ?",
        [result.data.name, result.data.color || null, result.data.maintenance_interval_months ?? null, now, editingCategory.id]
      );
    } else {
      await powersync.execute(
        "INSERT INTO service_categories (id, tenant_id, name, color, maintenance_interval_months, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          uuidv4(),
          profile.tenant_id,
          result.data.name,
          result.data.color || null,
          result.data.maintenance_interval_months ?? null,
          now,
          now,
        ]
      );
    }
    setCategoryModalVisible(false);
  };

  const handleDeleteCategory = (category: ServiceCategory) => {
    Alert.alert("Delete category", `Delete "${category.name}"? Jobs using it will just lose the tag.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await powersync.execute("DELETE FROM service_categories WHERE id = ?", [category.id]);
        },
      },
    ]);
  };

  const openNewStage = () => {
    setEditingStage(null);
    setStageName("");
    setStageColor("");
    setStageIsClosed(false);
    setStageError(null);
    setStageModalVisible(true);
  };

  const openEditStage = (stage: JobLifecycleStage) => {
    setEditingStage(stage);
    setStageName(stage.name);
    setStageColor(stage.color ?? "");
    setStageIsClosed(stage.is_closed);
    setStageError(null);
    setStageModalVisible(true);
  };

  const handleSaveStage = async () => {
    const nextPosition = stages.length > 0 ? Math.max(...stages.map((s) => s.position)) + 1 : 1;
    const result = createJobLifecycleStageSchema.safeParse({
      name: stageName,
      color: stageColor || undefined,
      position: editingStage?.position ?? nextPosition,
      is_closed: stageIsClosed,
    });
    if (!result.success) {
      setStageError(result.error.issues[0]?.message ?? "Invalid stage");
      return;
    }
    if (!profile) return;

    const now = new Date().toISOString();
    if (editingStage) {
      await powersync.execute(
        "UPDATE job_lifecycle_stages SET name = ?, color = ?, is_closed = ?, updated_at = ? WHERE id = ?",
        [result.data.name, result.data.color || null, result.data.is_closed ? 1 : 0, now, editingStage.id]
      );
    } else {
      await powersync.execute(
        `INSERT INTO job_lifecycle_stages (id, tenant_id, name, position, color, is_system_default, is_closed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [
          uuidv4(),
          profile.tenant_id,
          result.data.name,
          result.data.position,
          result.data.color || null,
          result.data.is_closed ? 1 : 0,
          now,
          now,
        ]
      );
    }
    setStageModalVisible(false);
  };

  const handleDeleteStage = (stage: JobLifecycleStage) => {
    const note = stage.is_system_default
      ? " This is one of the default stages - jobs currently in it will just become unstaged."
      : " Jobs currently in it will just become unstaged.";
    Alert.alert("Delete stage", `Delete "${stage.name}"?${note}`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await powersync.execute("DELETE FROM job_lifecycle_stages WHERE id = ?", [stage.id]);
        },
      },
    ]);
  };

  // Tap-based reordering (no drag-and-drop), matching the rest of the app's
  // established convention - swap this stage's position with its neighbor's.
  const handleMoveStage = async (stage: JobLifecycleStage, direction: "up" | "down") => {
    const index = stages.findIndex((s) => s.id === stage.id);
    const neighborIndex = direction === "up" ? index - 1 : index + 1;
    if (index === -1 || neighborIndex < 0 || neighborIndex >= stages.length) return;
    const neighbor = stages[neighborIndex];
    const now = new Date().toISOString();
    await powersync.execute("UPDATE job_lifecycle_stages SET position = ?, updated_at = ? WHERE id = ?", [
      neighbor.position,
      now,
      stage.id,
    ]);
    await powersync.execute("UPDATE job_lifecycle_stages SET position = ?, updated_at = ? WHERE id = ?", [
      stage.position,
      now,
      neighbor.id,
    ]);
  };

  if (!isAdmin) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Only admins can manage job setup.</Text>
      </View>
    );
  }

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={styles.sectionTitle}>Service categories</Text>
        <Text style={styles.subtitle}>Tags shown on jobs, e.g. "Roof Restoration" or "Gutter Cleaning".</Text>

        {categories.map((category) => (
          <View key={category.id} style={styles.row}>
            <View style={styles.rowLabel}>
              <View style={[styles.swatch, category.color ? { backgroundColor: category.color } : styles.swatchEmpty]} />
              <Text style={styles.rowText}>{category.name}</Text>
              {category.maintenance_interval_months ? (
                <Text style={styles.defaultTag}>Every {category.maintenance_interval_months}mo</Text>
              ) : null}
            </View>
            <View style={styles.rowActions}>
              <Pressable onPress={() => openEditCategory(category)}>
                <Text style={styles.link}>Edit</Text>
              </Pressable>
              <Pressable onPress={() => handleDeleteCategory(category)}>
                <Text style={styles.deleteLink}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ))}
        {categories.length === 0 ? <Text style={styles.empty}>No categories yet.</Text> : null}

        <Pressable style={styles.addButton} onPress={openNewCategory}>
          <Text style={styles.addButtonText}>+ New category</Text>
        </Pressable>

        <Text style={[styles.sectionTitle, styles.secondSection]}>Job lifecycle stages</Text>
        <Text style={styles.subtitle}>A custom pipeline for jobs - this is the only status a job has.</Text>

        {stages.map((stage, index) => (
          <View key={stage.id} style={styles.row}>
            <View style={styles.rowLabel}>
              <View style={[styles.swatch, stage.color ? { backgroundColor: stage.color } : styles.swatchEmpty]} />
              <Text style={styles.rowText}>{stage.name}</Text>
              {stage.is_system_default ? <Text style={styles.defaultTag}>Default</Text> : null}
              {stage.is_closed ? <Text style={styles.defaultTag}>Closed</Text> : null}
            </View>
            <View style={styles.rowActions}>
              <Pressable onPress={() => handleMoveStage(stage, "up")} disabled={index === 0}>
                <Text style={[styles.reorderLink, index === 0 && styles.reorderLinkDisabled]}>Up</Text>
              </Pressable>
              <Pressable onPress={() => handleMoveStage(stage, "down")} disabled={index === stages.length - 1}>
                <Text style={[styles.reorderLink, index === stages.length - 1 && styles.reorderLinkDisabled]}>
                  Down
                </Text>
              </Pressable>
              <Pressable onPress={() => openEditStage(stage)}>
                <Text style={styles.link}>Edit</Text>
              </Pressable>
              <Pressable onPress={() => handleDeleteStage(stage)}>
                <Text style={styles.deleteLink}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ))}
        {stages.length === 0 ? <Text style={styles.empty}>No stages yet.</Text> : null}

        <Pressable style={styles.addButton} onPress={openNewStage}>
          <Text style={styles.addButtonText}>+ New stage</Text>
        </Pressable>
      </ScrollView>

      <CenteredModal visible={categoryModalVisible} onClose={() => setCategoryModalVisible(false)}>
        <Text style={styles.modalTitle}>{editingCategory ? "Edit category" : "New category"}</Text>
        <FormField label="Name" placeholder="e.g. Roof Restoration" value={categoryName} onChangeText={setCategoryName} />
        <View style={styles.fieldSpacing}>
          <FormField
            label="Color (optional hex, e.g. #1d4ed8)"
            placeholder="#1d4ed8"
            value={categoryColor}
            onChangeText={setCategoryColor}
            autoCapitalize="none"
          />
        </View>
        <View style={styles.fieldSpacing}>
          <FormField
            label="Maintenance reminder every (months, optional)"
            placeholder="e.g. 6 for aircon winterisation, 12 for annual pest control"
            value={categoryMaintenanceInterval}
            onChangeText={setCategoryMaintenanceInterval}
            keyboardType="number-pad"
          />
        </View>
        {categoryError ? <Text style={styles.error}>{categoryError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setCategoryModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleSaveCategory}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <CenteredModal visible={stageModalVisible} onClose={() => setStageModalVisible(false)}>
        <Text style={styles.modalTitle}>{editingStage ? "Edit stage" : "New stage"}</Text>
        <FormField label="Name" placeholder="e.g. Deposit Paid" value={stageName} onChangeText={setStageName} />
        <View style={styles.fieldSpacing}>
          <FormField
            label="Color (optional hex, e.g. #1d4ed8)"
            placeholder="#1d4ed8"
            value={stageColor}
            onChangeText={setStageColor}
            autoCapitalize="none"
          />
        </View>
        <View style={[styles.fieldSpacing, styles.switchRow]}>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.switchLabel}>Job is done in this stage</Text>
            <Text style={styles.switchHint}>Triggers the completion summary email and maintenance reminders.</Text>
          </View>
          <Switch value={stageIsClosed} onValueChange={setStageIsClosed} />
        </View>
        {stageError ? <Text style={styles.error}>{stageError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setStageModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleSaveStage}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: "#111827" },
  secondSection: { marginTop: 28 },
  subtitle: { color: "#6b7280", marginTop: 2, marginBottom: 12 },
  // Stacked (label row, then actions row) rather than a single crammed
  // row - a stage can carry a name plus two tags (Default/Closed) next to
  // four action links (Up/Down/Edit/Delete), which squeezed the name text
  // down to nothing on a phone-width screen. Each row wraps independently
  // instead.
  row: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
    gap: 6,
  },
  rowLabel: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  swatch: { width: 14, height: 14, borderRadius: 7 },
  swatchEmpty: { backgroundColor: "#e5e7eb" },
  rowText: { fontSize: 15, fontWeight: "600", color: "#111827", flexShrink: 1 },
  defaultTag: {
    fontSize: 11,
    fontWeight: "700",
    color: "#6b7280",
    backgroundColor: "#f3f4f6",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  rowActions: { flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" },
  link: { color: "#1d4ed8", fontWeight: "600" },
  deleteLink: { color: "#dc2626", fontWeight: "600" },
  reorderLink: { color: "#374151", fontWeight: "600" },
  reorderLinkDisabled: { color: "#d1d5db" },
  empty: { textAlign: "center", color: "#6b7280", padding: 16 },
  addButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 16 },
  addButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  fieldSpacing: { marginTop: 16 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  switchLabel: { fontSize: 15, fontWeight: "600", color: "#111827" },
  switchHint: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  error: { color: "#dc2626", marginTop: 12 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 16 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
});

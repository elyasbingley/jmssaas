import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { usePowerSync, useQuery } from "@powersync/react";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { v4 as uuidv4 } from "uuid";
import type {
  JobLeakCheck,
  JobLeakCheckCategory,
  JobLeakCheckItem,
  LeakCheckItemResult,
  LeakCheckItemType,
  LeakCheckTemplate,
  LeakCheckTemplateCategory,
  LeakCheckTemplateItem,
} from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { addLeakCheckItemPhoto } from "../lib/powersync";
import { getErrorMessage } from "../lib/errors";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { CenteredModal } from "./CenteredModal";
import { ThemedButton } from "./theme/ThemedButton";
import { ThemedFormField } from "./theme/ThemedFormField";
import { ThemedPhotoAttachments } from "./theme/ThemedPhotoAttachments";

// Mobile port of apps/desktop/src/components/quote-tools/LeakCheckTool.tsx -
// same shape/behaviour, offline-capable via PowerSync instead of
// Supabase-direct (the one quote-tool besides MeasureRoofTool that needs
// to work with no signal, see the leak_check_checklist migration's own
// comment). Writes go straight through powersync.execute against the
// local SQLite replica - PowerSync's own CRUD queue uploads them when back
// online, same as every other offline-capable write in this app.

const RESULT_LABELS: Record<LeakCheckItemResult, string> = { pass: "Pass", fail: "Fail", na: "N/A" };

export function LeakCheckTool({ jobCardId }: { jobCardId: string }) {
  const styles = useThemedStyles(createStyles);
  const powersync = usePowerSync();
  const { profile } = useAuth();

  const { data: leakChecks } = useQuery<JobLeakCheck>(
    "SELECT * FROM job_leak_checks WHERE job_card_id = ? ORDER BY created_at DESC",
    [jobCardId]
  );
  const { data: templates } = useQuery<LeakCheckTemplate>("SELECT * FROM leak_check_templates WHERE is_archived = 0 ORDER BY sort_order, name");

  const [activeId, setActiveId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string>("");
  const [pickerVisible, setPickerVisible] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;

  const handleStart = async () => {
    if (!profile) return;
    setStarting(true);
    setStartError(null);
    try {
      const now = new Date().toISOString();
      const leakCheckId = uuidv4();
      await powersync.execute(
        `INSERT INTO job_leak_checks (id, tenant_id, job_card_id, template_id, title, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, ?)`,
        [leakCheckId, profile.tenant_id, jobCardId, selectedTemplate?.id ?? null, selectedTemplate?.name ?? "Leak Check", profile.id, now, now]
      );

      if (selectedTemplate) {
        const templateCategories = await powersync.getAll<LeakCheckTemplateCategory>(
          "SELECT * FROM leak_check_template_categories WHERE template_id = ? ORDER BY sort_order",
          [selectedTemplate.id]
        );
        const templateItems = await powersync.getAll<LeakCheckTemplateItem>(
          "SELECT * FROM leak_check_template_items WHERE template_id = ? ORDER BY sort_order",
          [selectedTemplate.id]
        );

        const categoryIdMap = new Map<string, string>();
        for (const [i, c] of templateCategories.entries()) {
          const newId = uuidv4();
          categoryIdMap.set(c.id, newId);
          await powersync.execute(
            `INSERT INTO job_leak_check_categories (id, tenant_id, leak_check_id, job_card_id, name, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [newId, profile.tenant_id, leakCheckId, jobCardId, c.name, i, now, now]
          );
        }
        for (const [i, it] of templateItems.entries()) {
          const categoryId = categoryIdMap.get(it.category_id);
          if (!categoryId) continue;
          await powersync.execute(
            `INSERT INTO job_leak_check_items (id, tenant_id, leak_check_id, category_id, job_card_id, item_type, label, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [uuidv4(), profile.tenant_id, leakCheckId, categoryId, jobCardId, it.item_type, it.label, i, now, now]
          );
        }
      }

      setActiveId(leakCheckId);
    } catch (e) {
      setStartError(getErrorMessage(e, "Failed to start leak check"));
    } finally {
      setStarting(false);
    }
  };

  if (activeId) {
    return <LeakCheckEditor leakCheckId={activeId} jobCardId={jobCardId} onBack={() => setActiveId(null)} />;
  }

  return (
    <View>
      {leakChecks.length > 0 ? (
        <View style={styles.historyList}>
          {leakChecks.map((lc) => (
            <Pressable key={lc.id} style={styles.historyRow} onPress={() => setActiveId(lc.id)}>
              <Text style={styles.historyTitle}>{lc.title}</Text>
              <View style={styles.historyMeta}>
                <Text style={styles.historyDate}>{new Date(lc.created_at).toLocaleDateString()}</Text>
                <View style={[styles.statusBadge, lc.status === "completed" && styles.statusBadgeDone]}>
                  <Text style={[styles.statusBadgeText, lc.status === "completed" && styles.statusBadgeTextDone]}>
                    {lc.status === "completed" ? "Completed" : "In progress"}
                  </Text>
                </View>
              </View>
            </Pressable>
          ))}
        </View>
      ) : (
        <Text style={styles.empty}>No leak checks started on this job yet.</Text>
      )}

      <View style={styles.startBox}>
        <Text style={styles.startLabel}>Start a new leak check</Text>
        <Pressable style={styles.templatePicker} onPress={() => setPickerVisible(true)}>
          <Text style={styles.templatePickerText}>{selectedTemplate ? selectedTemplate.name : "Blank checklist (no template)"}</Text>
        </Pressable>
        {startError ? <Text style={styles.error}>{startError}</Text> : null}
        <ThemedButton label={starting ? "Starting..." : "Start"} onPress={handleStart} disabled={starting} />
      </View>

      <CenteredModal visible={pickerVisible} onClose={() => setPickerVisible(false)}>
        <Text style={styles.modalTitle}>Choose a template</Text>
        <Pressable
          style={styles.templateOption}
          onPress={() => {
            setTemplateId("");
            setPickerVisible(false);
          }}
        >
          <Text style={styles.templateOptionText}>Blank checklist (no template)</Text>
        </Pressable>
        {templates.map((t) => (
          <Pressable
            key={t.id}
            style={styles.templateOption}
            onPress={() => {
              setTemplateId(t.id);
              setPickerVisible(false);
            }}
          >
            <Text style={styles.templateOptionText}>{t.name}</Text>
          </Pressable>
        ))}
      </CenteredModal>
    </View>
  );
}

interface LeakCheckItemFileRow {
  id: string;
  local_uri: string | null;
  file_name: string | null;
  mime_type: string | null;
  upload_state: number | null;
}

function LeakCheckEditor({ leakCheckId, jobCardId, onBack }: { leakCheckId: string; jobCardId: string; onBack: () => void }) {
  const styles = useThemedStyles(createStyles);
  const powersync = usePowerSync();
  const { profile } = useAuth();

  const { data: leakCheckRows } = useQuery<JobLeakCheck>("SELECT * FROM job_leak_checks WHERE id = ?", [leakCheckId]);
  const leakCheck = leakCheckRows[0];
  const { data: categories } = useQuery<JobLeakCheckCategory>(
    "SELECT * FROM job_leak_check_categories WHERE leak_check_id = ? ORDER BY sort_order",
    [leakCheckId]
  );
  const { data: items } = useQuery<JobLeakCheckItem>("SELECT * FROM job_leak_check_items WHERE leak_check_id = ? ORDER BY sort_order", [leakCheckId]);

  const [newCategoryName, setNewCategoryName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const addCategory = async () => {
    if (!profile || !newCategoryName.trim()) return;
    const now = new Date().toISOString();
    try {
      await powersync.execute(
        `INSERT INTO job_leak_check_categories (id, tenant_id, leak_check_id, job_card_id, name, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), profile.tenant_id, leakCheckId, jobCardId, newCategoryName.trim(), categories.length, now, now]
      );
      setNewCategoryName("");
      setActionError(null);
    } catch (e) {
      setActionError(getErrorMessage(e, "Failed to add category"));
    }
  };

  const removeCategory = async (categoryId: string) => {
    await powersync.execute("DELETE FROM job_leak_check_categories WHERE id = ?", [categoryId]);
  };

  const addItem = async (categoryId: string, itemType: LeakCheckItemType) => {
    if (!profile) return;
    const now = new Date().toISOString();
    const sortOrder = items.filter((i) => i.category_id === categoryId).length;
    try {
      await powersync.execute(
        `INSERT INTO job_leak_check_items (id, tenant_id, leak_check_id, category_id, job_card_id, item_type, label, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), profile.tenant_id, leakCheckId, categoryId, jobCardId, itemType, itemType === "water_meter" ? "Water meter test" : "", sortOrder, now, now]
      );
    } catch (e) {
      setActionError(getErrorMessage(e, "Failed to add item"));
    }
  };

  const removeItem = async (itemId: string) => {
    await powersync.execute("DELETE FROM job_leak_check_items WHERE id = ?", [itemId]);
  };

  const setStatus = async (status: "in_progress" | "completed") => {
    if (!profile) return;
    const now = new Date().toISOString();
    if (status === "completed") {
      await powersync.execute("UPDATE job_leak_checks SET status = ?, completed_at = ?, completed_by = ?, updated_at = ? WHERE id = ?", [
        status,
        now,
        profile.id,
        now,
        leakCheckId,
      ]);
    } else {
      await powersync.execute("UPDATE job_leak_checks SET status = ?, completed_at = NULL, completed_by = NULL, updated_at = ? WHERE id = ?", [
        status,
        now,
        leakCheckId,
      ]);
    }
  };

  if (!leakCheck) {
    return <Text style={styles.empty}>Loading...</Text>;
  }

  const failCount = items.filter((i) => i.result === "fail").length;

  return (
    <View>
      <View style={styles.editorHeader}>
        <Pressable onPress={onBack}>
          <Text style={styles.backLink}>&larr; All leak checks</Text>
        </Pressable>
        <View style={styles.editorHeaderActions}>
          {failCount > 0 ? (
            <View style={styles.issuesBadge}>
              <Text style={styles.issuesBadgeText}>
                {failCount} issue{failCount === 1 ? "" : "s"}
              </Text>
            </View>
          ) : null}
          {leakCheck.status === "completed" ? (
            <Pressable onPress={() => setStatus("in_progress")}>
              <Text style={styles.reopenLink}>Reopen</Text>
            </Pressable>
          ) : (
            <ThemedButton label="Mark complete" onPress={() => setStatus("completed")} />
          )}
        </View>
      </View>

      {actionError ? <Text style={styles.error}>{actionError}</Text> : null}

      {categories.map((category) => (
        <View key={category.id} style={styles.categoryBox}>
          <View style={styles.categoryHeader}>
            <Text style={styles.categoryName}>{category.name}</Text>
            <Pressable onPress={() => removeCategory(category.id)}>
              <Text style={styles.removeLink}>Remove category</Text>
            </Pressable>
          </View>

          {items
            .filter((i) => i.category_id === category.id)
            .map((item) => (
              <LeakCheckItemRow key={item.id} item={item} powersync={powersync} onRemove={() => removeItem(item.id)} />
            ))}

          <View style={styles.addItemRow}>
            <Pressable onPress={() => addItem(category.id, "standard")}>
              <Text style={styles.addLink}>+ Add fixture</Text>
            </Pressable>
            <Pressable onPress={() => addItem(category.id, "water_meter")}>
              <Text style={styles.addLink}>+ Add water meter test</Text>
            </Pressable>
          </View>
        </View>
      ))}

      <View style={styles.addCategoryRow}>
        <View style={styles.addCategoryInput}>
          <ThemedFormField label="New category" placeholder="e.g. Irrigation" value={newCategoryName} onChangeText={setNewCategoryName} />
        </View>
        <ThemedButton label="+ Add category" onPress={addCategory} disabled={!newCategoryName.trim()} />
      </View>
    </View>
  );
}

function LeakCheckItemRow({
  item,
  powersync,
  onRemove,
}: {
  item: JobLeakCheckItem;
  powersync: ReturnType<typeof usePowerSync>;
  onRemove: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { profile } = useAuth();

  const { data: files } = useQuery<LeakCheckItemFileRow>(
    `SELECT f.id, f.file_name, f.mime_type, a.local_uri, a.state AS upload_state
       FROM job_leak_check_item_files f
       LEFT JOIN attachments a ON a.id = f.id
      WHERE f.item_id = ?
      ORDER BY f.created_at`,
    [item.id]
  );

  const [label, setLabel] = useState(item.label);
  const [notes, setNotes] = useState(item.notes ?? "");
  const [meterStart, setMeterStart] = useState(item.meter_start_reading != null ? String(item.meter_start_reading) : "");
  const [meterEnd, setMeterEnd] = useState(item.meter_end_reading != null ? String(item.meter_end_reading) : "");
  const [meterWait, setMeterWait] = useState(item.meter_wait_minutes != null ? String(item.meter_wait_minutes) : "");
  const [uploading, setUploading] = useState(false);

  const meterMoved = item.meter_start_reading != null && item.meter_end_reading != null && item.meter_start_reading !== item.meter_end_reading;

  const commitLabel = async () => {
    if (label === item.label) return;
    await powersync.execute("UPDATE job_leak_check_items SET label = ?, updated_at = ? WHERE id = ?", [label, new Date().toISOString(), item.id]);
  };
  const commitResult = async (result: LeakCheckItemResult) => {
    await powersync.execute("UPDATE job_leak_check_items SET result = ?, updated_at = ? WHERE id = ?", [result, new Date().toISOString(), item.id]);
  };
  const commitNotes = async () => {
    if (notes === (item.notes ?? "")) return;
    await powersync.execute("UPDATE job_leak_check_items SET notes = ?, updated_at = ? WHERE id = ?", [notes || null, new Date().toISOString(), item.id]);
  };
  const commitMeterField = async (column: "meter_start_reading" | "meter_end_reading" | "meter_wait_minutes", value: string) => {
    await powersync.execute(`UPDATE job_leak_check_items SET ${column} = ?, updated_at = ? WHERE id = ?`, [
      value === "" ? null : Number(value),
      new Date().toISOString(),
      item.id,
    ]);
  };

  const handleUploadPhoto = async (photo: { base64: string; mimeType: string; fileExtension: string }) => {
    if (!profile) return;
    setUploading(true);
    try {
      await addLeakCheckItemPhoto({
        tenantId: profile.tenant_id,
        itemId: item.id,
        jobCardId: item.job_card_id,
        uploadedBy: profile.id,
        imageArrayBuffer: decodeBase64(photo.base64),
        mediaType: photo.mimeType,
        fileExtension: photo.fileExtension,
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <View style={styles.itemRow}>
      <View style={styles.itemTopRow}>
        <View style={styles.itemLabelWrap}>
          <TextInput
            value={label}
            onChangeText={setLabel}
            onBlur={commitLabel}
            editable={item.item_type !== "water_meter"}
            placeholder="e.g. Kitchen tap"
            placeholderTextColor={styles.placeholder.color}
            style={styles.itemLabelInput}
          />
        </View>
        <Pressable onPress={onRemove}>
          <Text style={styles.removeIcon}>&#10005;</Text>
        </Pressable>
      </View>

      {item.item_type === "standard" ? (
        <View style={styles.resultRow}>
          {(["pass", "fail", "na"] as LeakCheckItemResult[]).map((r) => (
            <Pressable
              key={r}
              onPress={() => commitResult(r)}
              style={[styles.resultButton, item.result === r && (r === "fail" ? styles.resultButtonFail : styles.resultButtonActive)]}
            >
              <Text style={[styles.resultButtonText, item.result === r && (r === "fail" ? styles.resultButtonTextFail : styles.resultButtonTextActive)]}>
                {RESULT_LABELS[r]}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={styles.meterRow}>
          <TextInput
            value={meterStart}
            onChangeText={setMeterStart}
            onBlur={() => commitMeterField("meter_start_reading", meterStart)}
            placeholder="Start reading"
            placeholderTextColor={styles.placeholder.color}
            keyboardType="decimal-pad"
            style={styles.meterInput}
          />
          <TextInput
            value={meterEnd}
            onChangeText={setMeterEnd}
            onBlur={() => commitMeterField("meter_end_reading", meterEnd)}
            placeholder="End reading"
            placeholderTextColor={styles.placeholder.color}
            keyboardType="decimal-pad"
            style={styles.meterInput}
          />
          <TextInput
            value={meterWait}
            onChangeText={setMeterWait}
            onBlur={() => commitMeterField("meter_wait_minutes", meterWait)}
            placeholder="Wait (min)"
            placeholderTextColor={styles.placeholder.color}
            keyboardType="decimal-pad"
            style={styles.meterInput}
          />
        </View>
      )}
      {item.item_type === "water_meter" && meterStart !== "" && meterEnd !== "" ? (
        <Text style={[styles.meterReadout, meterMoved && styles.meterReadoutLeak]}>
          {meterMoved ? "Meter moved - likely leak" : "Meter steady - no leak detected"}
        </Text>
      ) : null}

      <TextInput
        value={notes}
        onChangeText={setNotes}
        onBlur={commitNotes}
        placeholder="Notes"
        placeholderTextColor={styles.placeholder.color}
        multiline
        style={styles.notesInput}
      />

      <ThemedPhotoAttachments photos={files} uploading={uploading} onUpload={handleUploadPhoto} />
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return StyleSheet.create({
    historyList: { gap: 8, marginBottom: 12 },
    historyRow: {
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 10,
      padding: 12,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    historyTitle: { fontSize: font.body - 1, fontWeight: "600", color: tokens.textPrimary, ...mono },
    historyMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
    historyDate: { fontSize: font.label, color: tokens.textMuted, ...mono },
    statusBadge: { borderWidth: 1, borderColor: tokens.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
    statusBadgeDone: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    statusBadgeText: { fontSize: font.label - 1, fontWeight: "700", textTransform: "uppercase", color: tokens.textMuted, ...mono },
    statusBadgeTextDone: { color: tokens.accent },
    empty: { color: tokens.textMuted, fontSize: font.body - 1, marginBottom: 12, ...mono },
    startBox: { borderWidth: 1, borderColor: tokens.border, borderRadius: 10, padding: 12, backgroundColor: tokens.surface, gap: 8 },
    startLabel: { fontSize: font.label - 1, fontWeight: "700", textTransform: "uppercase", color: tokens.textMuted, ...mono },
    templatePicker: { borderWidth: 1, borderColor: tokens.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: tokens.background },
    templatePickerText: { fontSize: font.body - 1, color: tokens.textPrimary, ...mono },
    modalTitle: { fontSize: font.title - 2, fontWeight: "700", color: tokens.accent, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1, ...mono },
    templateOption: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: tokens.border },
    templateOptionText: { fontSize: font.body - 1, color: tokens.textPrimary, ...mono },
    error: { color: tokens.danger, fontSize: font.body - 2, marginVertical: 4, ...mono },
    editorHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
    editorHeaderActions: { flexDirection: "row", alignItems: "center", gap: 10 },
    backLink: { color: tokens.accent, fontWeight: "600", fontSize: font.body - 1, ...mono },
    reopenLink: { color: tokens.textMuted, fontWeight: "600", fontSize: font.label, ...mono },
    issuesBadge: { backgroundColor: tokens.danger, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
    issuesBadgeText: { color: tokens.background, fontWeight: "700", fontSize: font.label - 1, textTransform: "uppercase", ...mono },
    categoryBox: { borderWidth: 1, borderColor: tokens.border, borderRadius: 10, padding: 10, marginBottom: 10 },
    categoryHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
    categoryName: { fontSize: font.label, fontWeight: "700", textTransform: "uppercase", color: tokens.accent, letterSpacing: 0.5, ...mono },
    removeLink: { color: tokens.danger, fontSize: font.label, fontWeight: "600", ...mono },
    addItemRow: { flexDirection: "row", gap: 16, marginTop: 4 },
    addLink: { color: tokens.accent, fontWeight: "600", fontSize: font.label, ...mono },
    addCategoryRow: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
    addCategoryInput: { flex: 1 },
    itemRow: { backgroundColor: tokens.surface, borderRadius: 8, padding: 8, marginBottom: 8 },
    itemTopRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    itemLabelWrap: { flex: 1 },
    itemLabelInput: {
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: tokens.textPrimary,
      backgroundColor: tokens.background,
      fontSize: font.body - 1,
      ...mono,
    },
    removeIcon: { color: tokens.danger, fontSize: font.body },
    resultRow: { flexDirection: "row", gap: 6, marginTop: 8 },
    resultButton: { borderWidth: 1, borderColor: tokens.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: tokens.background },
    resultButtonActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    resultButtonFail: { backgroundColor: tokens.danger, borderColor: tokens.danger },
    resultButtonText: { fontSize: font.label, fontWeight: "600", color: tokens.textMuted, ...mono },
    resultButtonTextActive: { color: tokens.accent },
    resultButtonTextFail: { color: tokens.background },
    meterRow: { flexDirection: "row", gap: 6, marginTop: 8 },
    meterInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
      color: tokens.textPrimary,
      backgroundColor: tokens.background,
      fontSize: font.label,
      ...mono,
    },
    meterReadout: { marginTop: 6, fontSize: font.label, color: tokens.accent, ...mono },
    meterReadoutLeak: { color: tokens.danger },
    notesInput: {
      marginTop: 8,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: tokens.textPrimary,
      backgroundColor: tokens.background,
      fontSize: font.body - 1,
      minHeight: 40,
      textAlignVertical: "top",
      ...mono,
    },
    placeholder: { color: tokens.textMuted },
  });
}

import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { v4 as uuidv4 } from "uuid";
import {
  createReportTemplateSchema,
  FIELD_TYPE_LABELS,
  type ReportFieldDefinition,
  type ReportFieldType,
  type ReportSectionDefinition,
  type ReportStructureSchema,
  type ReportSubcategory,
  type ReportTemplate,
} from "@jmssaas/shared";
import { supabase } from "../../../lib/supabase";
import { useIsOnline } from "../../../lib/connectivity";
import { useAuth } from "../../../lib/auth-context";
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../../lib/errors";
import { RequiresConnectionNotice } from "../../../components/RequiresConnectionNotice";
import { FormField } from "../../../components/FormField";
import { PickerModal } from "../../../components/PickerModal";

// Mobile port of desktop's ReportTemplateEditor.tsx - same up/down
// reordering (no drag-and-drop) rather than each field's own dedicated page.

const FIELD_TYPES: ReportFieldType[] = ["pass_fail", "risk_matrix", "photo", "text", "long_text", "meter_reading", "signature"];

function newField(type: ReportFieldType): ReportFieldDefinition {
  return {
    id: uuidv4(),
    type,
    label: FIELD_TYPE_LABELS[type],
    required: false,
    requireActionOnFail: type === "pass_fail" ? true : undefined,
  };
}

function newSection(): ReportSectionDefinition {
  return { id: uuidv4(), title: "", fields: [] };
}

function moveItem<T>(arr: T[], index: number, direction: -1 | 1): T[] {
  const next = [...arr];
  const target = index + direction;
  if (target < 0 || target >= next.length) return next;
  const a = next[index];
  const b = next[target];
  if (a === undefined || b === undefined) return next;
  next[index] = b;
  next[target] = a;
  return next;
}

export default function ReportTemplateEditorScreen() {
  const { id, subcategoryId: preselectedSubcategoryId } = useLocalSearchParams<{ id: string; subcategoryId?: string }>();
  const isNew = id === "new";
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();

  const { data: subcategories } = useSupabaseFetch<ReportSubcategory[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("report_subcategories").select("*").order("name");
    if (error) throw error;
    return data as ReportSubcategory[];
  }, [isOnline]);

  const { data: template } = useSupabaseFetch<ReportTemplate | null>(async () => {
    if (!isOnline || isNew) return null;
    const { data, error } = await supabase.from("report_templates").select("*").eq("id", id).single();
    if (error) throw error;
    return data as ReportTemplate;
  }, [isOnline, isNew, id]);

  const [subcategoryId, setSubcategoryId] = useState(preselectedSubcategoryId ?? "");
  const [subcategoryPickerVisible, setSubcategoryPickerVisible] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isSwms, setIsSwms] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [sections, setSections] = useState<ReportStructureSchema>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (template) {
      setSubcategoryId(template.subcategory_id);
      setTitle(template.title);
      setDescription(template.description ?? "");
      setIsSwms(template.is_swms);
      setIsActive(template.is_active);
      setSections(template.structure_schema);
    }
  }, [template]);

  const addSection = () => setSections((prev) => [...prev, newSection()]);
  const removeSection = (sectionId: string) => setSections((prev) => prev.filter((s) => s.id !== sectionId));
  const updateSection = (sectionId: string, patch: Partial<ReportSectionDefinition>) =>
    setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, ...patch } : s)));
  const moveSection = (index: number, direction: -1 | 1) => setSections((prev) => moveItem(prev, index, direction));

  const addField = (sectionId: string, type: ReportFieldType) =>
    setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, fields: [...s.fields, newField(type)] } : s)));
  const removeField = (sectionId: string, fieldId: string) =>
    setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, fields: s.fields.filter((f) => f.id !== fieldId) } : s)));
  const updateField = (sectionId: string, fieldId: string, patch: Partial<ReportFieldDefinition>) =>
    setSections((prev) =>
      prev.map((s) => (s.id === sectionId ? { ...s, fields: s.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)) } : s))
    );
  const moveField = (sectionId: string, index: number, direction: -1 | 1) =>
    setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, fields: moveItem(s.fields, index, direction) } : s)));

  const save = async () => {
    const result = createReportTemplateSchema.safeParse({
      subcategory_id: subcategoryId,
      title,
      description,
      is_swms: isSwms,
      structure_schema: sections,
      is_active: isActive,
    });
    if (!result.success) {
      setSaveError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    if (!profile) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (isNew) {
        const { data, error } = await supabase
          .from("report_templates")
          .insert({ tenant_id: profile.tenant_id, ...result.data })
          .select("id")
          .single();
        if (error) throw error;
        router.replace(`/reports/template/${data.id}`);
      } else {
        const { error } = await supabase.from("report_templates").update(result.data).eq("id", id);
        if (error) throw error;
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch (e) {
      setSaveError(getErrorMessage(e, "Failed to save template"));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert("Delete template", `Delete "${title}"? This does not delete reports already completed from it.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const { error } = await supabase.from("report_templates").delete().eq("id", id);
          if (!error) router.replace("/reports");
        },
      },
    ]);
  };

  if (!isOnline) {
    return <RequiresConnectionNotice label="Report templates" />;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Text style={styles.heading}>{isNew ? "New report template" : "Edit report template"}</Text>

      <View style={styles.fieldSpacing}>
        <Pressable style={styles.pickerField} onPress={() => setSubcategoryPickerVisible(true)}>
          <Text style={styles.pickerFieldLabel}>Subcategory</Text>
          <Text style={styles.pickerFieldValue}>
            {(subcategories ?? []).find((s) => s.id === subcategoryId)?.name ?? "Select subcategory"}
          </Text>
        </Pressable>
      </View>
      <View style={styles.fieldSpacing}>
        <FormField label="Title" value={title} onChangeText={setTitle} placeholder="e.g. Roof Inspection Report" />
      </View>
      <View style={styles.fieldSpacing}>
        <FormField label="Description (optional)" value={description} onChangeText={setDescription} multiline style={styles.multiline} />
      </View>

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Requires SWMS worker sign-off roster</Text>
        <Switch value={isSwms} onValueChange={setIsSwms} />
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Active (visible in New Report)</Text>
        <Switch value={isActive} onValueChange={setIsActive} />
      </View>

      <Text style={styles.sectionHeading}>Sections</Text>
      {sections.map((section, sectionIndex) => (
        <View key={section.id} style={styles.sectionCard}>
          <View style={styles.sectionCardHeader}>
            <TextInput
              value={section.title}
              onChangeText={(v) => updateSection(section.id, { title: v })}
              placeholder="Section title"
              style={styles.sectionTitleInput}
            />
            <Pressable onPress={() => moveSection(sectionIndex, -1)} disabled={sectionIndex === 0}>
              <Text style={[styles.reorderArrow, sectionIndex === 0 && styles.disabledArrow]}>↑</Text>
            </Pressable>
            <Pressable onPress={() => moveSection(sectionIndex, 1)} disabled={sectionIndex === sections.length - 1}>
              <Text style={[styles.reorderArrow, sectionIndex === sections.length - 1 && styles.disabledArrow]}>↓</Text>
            </Pressable>
            <Pressable onPress={() => removeSection(section.id)}>
              <Text style={styles.removeLink}>Remove</Text>
            </Pressable>
          </View>

          {section.fields.map((field, fieldIndex) => (
            <View key={field.id} style={styles.fieldCard}>
              <View style={styles.fieldCardHeader}>
                <TextInput
                  value={field.label}
                  onChangeText={(v) => updateField(section.id, field.id, { label: v })}
                  placeholder="Field label / question"
                  style={styles.fieldLabelInput}
                />
              </View>
              <View style={styles.fieldTypeRow}>
                <Text style={styles.fieldTypeBadge}>{FIELD_TYPE_LABELS[field.type]}</Text>
                <Pressable onPress={() => moveField(section.id, fieldIndex, -1)} disabled={fieldIndex === 0}>
                  <Text style={[styles.reorderArrow, fieldIndex === 0 && styles.disabledArrow]}>↑</Text>
                </Pressable>
                <Pressable onPress={() => moveField(section.id, fieldIndex, 1)} disabled={fieldIndex === section.fields.length - 1}>
                  <Text style={[styles.reorderArrow, fieldIndex === section.fields.length - 1 && styles.disabledArrow]}>↓</Text>
                </Pressable>
                <Pressable onPress={() => removeField(section.id, field.id)}>
                  <Text style={styles.removeLink}>Remove</Text>
                </Pressable>
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Required</Text>
                <Switch value={field.required} onValueChange={(v) => updateField(section.id, field.id, { required: v })} />
              </View>
              {field.type === "pass_fail" ? (
                <View style={styles.toggleRow}>
                  <Text style={styles.toggleLabel}>"Fail" requires action note + photo</Text>
                  <Switch
                    value={field.requireActionOnFail ?? false}
                    onValueChange={(v) => updateField(section.id, field.id, { requireActionOnFail: v })}
                  />
                </View>
              ) : null}
            </View>
          ))}

          <View style={styles.addFieldRow}>
            {FIELD_TYPES.map((type) => (
              <Pressable key={type} style={styles.addFieldChip} onPress={() => addField(section.id, type)}>
                <Text style={styles.addFieldChipText}>+ {FIELD_TYPE_LABELS[type]}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}

      <Pressable style={styles.addSectionButton} onPress={addSection}>
        <Text style={styles.addSectionButtonText}>+ Add section</Text>
      </Pressable>

      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
      {saved ? <Text style={styles.saved}>Saved.</Text> : null}

      <Pressable style={styles.saveButton} onPress={save} disabled={saving}>
        <Text style={styles.saveButtonText}>{saving ? "Saving..." : isNew ? "Create template" : "Save changes"}</Text>
      </Pressable>
      {!isNew ? (
        <Pressable style={styles.deleteButton} onPress={confirmDelete}>
          <Text style={styles.deleteButtonText}>Delete template</Text>
        </Pressable>
      ) : null}

      <PickerModal
        visible={subcategoryPickerVisible}
        title="Select subcategory"
        items={subcategories ?? []}
        getKey={(s) => s.id}
        getLabel={(s) => s.name}
        onSelect={(s) => setSubcategoryId(s.id)}
        onClose={() => setSubcategoryPickerVisible(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  heading: { fontSize: 19, fontWeight: "700", marginBottom: 16 },
  fieldSpacing: { marginBottom: 14 },
  multiline: { minHeight: 60, textAlignVertical: "top" },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  pickerFieldLabel: { fontSize: 13, fontWeight: "600", color: "#374151", marginBottom: 4 },
  pickerFieldValue: { fontSize: 16, color: "#111827" },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8 },
  switchLabel: { fontSize: 14, fontWeight: "600", color: "#374151", flex: 1, marginRight: 12 },
  sectionHeading: { fontSize: 13, fontWeight: "700", color: "#6b7280", textTransform: "uppercase", marginTop: 20, marginBottom: 10 },
  sectionCard: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 10, padding: 14, marginBottom: 12, backgroundColor: "#fff" },
  sectionCardHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  sectionTitleInput: { flex: 1, borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, padding: 10, fontSize: 14, fontWeight: "700" },
  reorderArrow: { fontSize: 18, color: "#6b7280", paddingHorizontal: 4 },
  disabledArrow: { opacity: 0.3 },
  removeLink: { color: "#dc2626", fontWeight: "700", fontSize: 12 },
  fieldCard: { backgroundColor: "#f9fafb", borderRadius: 8, padding: 10, marginBottom: 8, gap: 6 },
  fieldCardHeader: { flexDirection: "row" },
  fieldLabelInput: { flex: 1, borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, padding: 8, fontSize: 14, backgroundColor: "#fff" },
  fieldTypeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  fieldTypeBadge: { flex: 1, backgroundColor: "#e5e7eb", borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, fontSize: 11, fontWeight: "700", color: "#374151" },
  toggleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  toggleLabel: { fontSize: 12, color: "#4b5563", flex: 1, marginRight: 8 },
  addFieldRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  addFieldChip: { backgroundColor: "#eff6ff", borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  addFieldChipText: { color: "#1d4ed8", fontWeight: "600", fontSize: 11 },
  addSectionButton: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, padding: 12, alignItems: "center", marginTop: 4 },
  addSectionButtonText: { fontWeight: "700", color: "#374151" },
  error: { color: "#dc2626", marginTop: 14 },
  saved: { color: "#15803d", marginTop: 14 },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 16 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  deleteButton: { alignItems: "center", marginTop: 14 },
  deleteButtonText: { color: "#dc2626", fontWeight: "700" },
});

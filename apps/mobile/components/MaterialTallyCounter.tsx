import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { v4 as uuidv4 } from "uuid";
import { createJobMaterialTallySchema, type MaterialTallyItem } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { ThemedFormField } from "./theme/ThemedFormField";

// On-Site Material Tally Engine (mobile) - same walkthrough-counter idea
// as desktop's MaterialTally.tsx, native touch version: large 44px +/-
// steppers since this is meant to be usable one-handed while walking a
// site. Supabase-direct (not PowerSync) - same "occasional site tool,
// requires connectivity" treatment as Reports/Purchase Orders, not the
// "always needs to work offline" treatment tasks/jobs/notes get.
export function MaterialTallyCounter({
  jobCardId,
  onTransferToOrder,
}: {
  jobCardId: string;
  onTransferToOrder?: (items: MaterialTallyItem[]) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { profile } = useAuth();
  const [tallyName, setTallyName] = useState("");
  const [items, setItems] = useState<MaterialTallyItem[]>([]);
  const [newItemName, setNewItemName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleAddItem = () => {
    if (!newItemName.trim()) return;
    setItems((prev) => [...prev, { id: uuidv4(), name: newItemName.trim(), count: 1, category: "" }]);
    setNewItemName("");
  };
  const handleAdjust = (itemId: string, delta: number) => {
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, count: Math.max(0, i.count + delta) } : i)));
  };
  const handleDelete = (itemId: string) => setItems((prev) => prev.filter((i) => i.id !== itemId));

  const handleSaveToNotes = async () => {
    const result = createJobMaterialTallySchema.safeParse({ job_card_id: jobCardId, tally_name: tallyName || undefined, items });
    if (!result.success) {
      setSaveError(result.error.issues[0]?.message ?? "Add at least one item first");
      return;
    }
    if (!profile) return;

    setSaving(true);
    setSaveError(null);
    try {
      const { error: tallyError } = await supabase.from("job_material_tallies").insert({
        tenant_id: profile.tenant_id,
        job_card_id: jobCardId,
        tally_name: result.data.tally_name || null,
        items: result.data.items,
        saved_to_notes: true,
        created_by: profile.id,
      });
      if (tallyError) throw tallyError;

      const heading = result.data.tally_name ? `📋 Material Site Tally (${result.data.tally_name}):` : "📋 Material Site Tally:";
      const lines = [heading, ...result.data.items.map((i) => `- ${i.name}: ${i.count}`)];
      const { error: noteError } = await supabase.from("job_notes").insert({
        tenant_id: profile.tenant_id,
        job_card_id: jobCardId,
        author_id: profile.id,
        body: lines.join("\n"),
      });
      if (noteError) throw noteError;

      setSavedMessage("Tally saved to Job Notes.");
      setTimeout(() => setSavedMessage(null), 4000);
    } catch (e) {
      setSaveError(getErrorMessage(e, "Failed to save tally"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      <ThemedFormField label="Tally name (optional)" placeholder='e.g. "Ground Floor Walkthrough"' value={tallyName} onChangeText={setTallyName} />

      <View style={styles.addRow}>
        <TextInput
          style={styles.addInput}
          placeholder="+ Material name..."
          placeholderTextColor={styles.placeholder.color}
          value={newItemName}
          onChangeText={setNewItemName}
          onSubmitEditing={handleAddItem}
        />
        <Pressable style={styles.addButton} onPress={handleAddItem}>
          <Text style={styles.addButtonText}>Add</Text>
        </Pressable>
      </View>

      {items.length === 0 ? (
        <Text style={styles.empty}>No materials added yet.</Text>
      ) : (
        items.map((item) => (
          <View key={item.id} style={styles.itemRow}>
            <Text style={styles.itemName} numberOfLines={1}>
              {item.name}
            </Text>
            <View style={styles.stepper}>
              <Pressable style={styles.stepperButton} onPress={() => handleAdjust(item.id, -1)}>
                <Text style={styles.stepperButtonText}>-</Text>
              </Pressable>
              <Text style={styles.stepperCount}>{item.count}</Text>
              <Pressable style={[styles.stepperButton, styles.stepperButtonPlus]} onPress={() => handleAdjust(item.id, 1)}>
                <Text style={styles.stepperButtonTextPlus}>+</Text>
              </Pressable>
            </View>
            <Pressable onPress={() => handleDelete(item.id)}>
              <Text style={styles.deleteLink}>Delete</Text>
            </Pressable>
          </View>
        ))
      )}

      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
      {savedMessage ? <Text style={styles.success}>{savedMessage}</Text> : null}

      <Pressable style={[styles.saveButton, (saving || items.length === 0) && styles.saveButtonDisabled]} onPress={handleSaveToNotes} disabled={saving || items.length === 0}>
        <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save Tally to Job Notes"}</Text>
      </Pressable>
      {onTransferToOrder ? (
        <Pressable
          style={[styles.transferButton, items.length === 0 && styles.saveButtonDisabled]}
          onPress={() => onTransferToOrder(items)}
          disabled={items.length === 0}
        >
          <Text style={styles.transferButtonText}>Transfer to Material Order Form</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function createStyles({ tokens, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return StyleSheet.create({
    addRow: { flexDirection: "row", gap: 8, marginTop: 12, marginBottom: 12 },
    addInput: { flex: 1, borderWidth: 1, borderColor: tokens.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: tokens.textPrimary, backgroundColor: tokens.background, ...mono },
    placeholder: { color: tokens.textMuted },
    addButton: { backgroundColor: tokens.accent, borderRadius: 8, paddingHorizontal: 18, justifyContent: "center" },
    addButtonText: { color: tokens.background, fontWeight: "700", ...mono },
    empty: { color: tokens.textMuted, fontSize: 14, ...mono },
    itemRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border },
    itemName: { flex: 1, fontSize: 15, fontWeight: "600", color: tokens.textPrimary, ...mono },
    stepper: { flexDirection: "row", alignItems: "center", gap: 8 },
    stepperButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: tokens.border, alignItems: "center", justifyContent: "center" },
    stepperButtonPlus: { backgroundColor: tokens.accent },
    stepperButtonText: { fontSize: 20, fontWeight: "800", color: tokens.textPrimary, ...mono },
    stepperButtonTextPlus: { fontSize: 20, fontWeight: "800", color: tokens.background, ...mono },
    stepperCount: { width: 28, textAlign: "center", fontSize: 16, fontWeight: "700", color: tokens.textPrimary, ...mono },
    deleteLink: { color: tokens.danger, fontWeight: "600", fontSize: 13, ...mono },
    error: { color: tokens.danger, marginTop: 10, ...mono },
    success: { color: tokens.accent, marginTop: 10, ...mono },
    saveButton: { backgroundColor: tokens.accent, borderRadius: 8, paddingVertical: 14, alignItems: "center", marginTop: 16, boxShadow: `0 0 12px ${tokens.accentGlow}` },
    saveButtonDisabled: { opacity: 0.6 },
    saveButtonText: { color: tokens.background, fontWeight: "700", fontSize: 16, ...mono },
    transferButton: { borderWidth: 1, borderColor: tokens.accent, borderRadius: 8, paddingVertical: 14, alignItems: "center", marginTop: 10 },
    transferButtonText: { color: tokens.accent, fontWeight: "700", fontSize: 15, ...mono },
  });
}

import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  computeLineItemUnitPriceCents,
  createPriceBookItemSchema,
  createPriceBookVariationSchema,
  formatCentsAsAud,
  type PriceBookItem,
  type PriceBookItemVariation,
} from "@jmssaas/shared";
import { useIsOnline } from "../../../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../../lib/supabase";
import { getErrorMessage } from "../../../../../lib/errors";
import { RequiresConnectionNotice } from "../../../../../components/RequiresConnectionNotice";
import { CenteredModal } from "../../../../../components/CenteredModal";
import { FormField } from "../../../../../components/FormField";

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

interface VariationFormState {
  name: string;
  labourRate: string;
  labourHours: string;
  materialCost: string;
  markupPercent: string;
}

const emptyVariationForm: VariationFormState = {
  name: "",
  labourRate: "0",
  labourHours: "0",
  materialCost: "0",
  markupPercent: "0",
};

export default function PriceBookItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isOnline = useIsOnline();

  const { data: item, refetch: refetchItem } = useSupabaseFetch<PriceBookItem>(async () => {
    const { data, error } = await supabase.from("price_book_items").select("*").eq("id", id).single();
    if (error) throw error;
    return data as PriceBookItem;
  }, [id, isOnline]);

  const { data: variations, refetch: refetchVariations } = useSupabaseFetch<PriceBookItemVariation[]>(async () => {
    const { data, error } = await supabase
      .from("price_book_item_variations")
      .select("*")
      .eq("price_book_item_id", id)
      .order("sort_order")
      .order("name");
    if (error) throw error;
    return (data ?? []) as PriceBookItemVariation[];
  }, [id, isOnline]);
  useRefetchOnFocus(refetchVariations);

  const [description, setDescription] = useState("");
  const [labourRate, setLabourRate] = useState("0");
  const [labourHours, setLabourHours] = useState("0");
  const [materialCost, setMaterialCost] = useState("0");
  const [markupPercent, setMarkupPercent] = useState("0");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (item) {
      setDescription(item.description);
      setLabourRate((item.labour_rate_cents / 100).toString());
      setLabourHours(item.labour_hours.toString());
      setMaterialCost((item.material_cost_cents / 100).toString());
      setMarkupPercent(item.markup_percent.toString());
    }
  }, [item]);

  const previewCents = computeLineItemUnitPriceCents({
    labour_rate_cents: Math.round(parseNumber(labourRate) * 100),
    labour_hours: parseNumber(labourHours),
    material_cost_cents: Math.round(parseNumber(materialCost) * 100),
    markup_percent: parseNumber(markupPercent),
  });

  const handleSave = async () => {
    if (!item) return;
    const result = createPriceBookItemSchema.safeParse({
      category_id: item.category_id,
      description,
      labour_rate_cents: Math.round(parseNumber(labourRate) * 100),
      labour_hours: parseNumber(labourHours),
      material_cost_cents: Math.round(parseNumber(materialCost) * 100),
      markup_percent: parseNumber(markupPercent),
    });
    if (!result.success) {
      setSaveError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const { error } = await supabase.from("price_book_items").update(result.data).eq("id", id);
      if (error) throw error;
      refetchItem();
    } catch (e) {
      console.error("[PriceBook] Failed to save item", e);
      setSaveError(getErrorMessage(e, "Failed to save (see console for details)"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    Alert.alert("Delete item", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await supabase.from("price_book_items").delete().eq("id", id);
          router.back();
        },
      },
    ]);
  };

  // --- Variations ---
  const [variationModalVisible, setVariationModalVisible] = useState(false);
  const [editingVariationId, setEditingVariationId] = useState<string | null>(null);
  const [variationForm, setVariationForm] = useState<VariationFormState>(emptyVariationForm);
  const [variationError, setVariationError] = useState<string | null>(null);

  const openNewVariation = () => {
    setEditingVariationId(null);
    setVariationForm(emptyVariationForm);
    setVariationError(null);
    setVariationModalVisible(true);
  };

  const openEditVariation = (variation: PriceBookItemVariation) => {
    setEditingVariationId(variation.id);
    setVariationForm({
      name: variation.name,
      labourRate: (variation.labour_rate_cents / 100).toString(),
      labourHours: variation.labour_hours.toString(),
      materialCost: (variation.material_cost_cents / 100).toString(),
      markupPercent: variation.markup_percent.toString(),
    });
    setVariationError(null);
    setVariationModalVisible(true);
  };

  const handleSaveVariation = async () => {
    const result = createPriceBookVariationSchema.safeParse({
      price_book_item_id: id,
      name: variationForm.name,
      labour_rate_cents: Math.round(parseNumber(variationForm.labourRate) * 100),
      labour_hours: parseNumber(variationForm.labourHours),
      material_cost_cents: Math.round(parseNumber(variationForm.materialCost) * 100),
      markup_percent: parseNumber(variationForm.markupPercent),
    });
    if (!result.success) {
      setVariationError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    try {
      const { error } = editingVariationId
        ? await supabase.from("price_book_item_variations").update(result.data).eq("id", editingVariationId)
        : await supabase.from("price_book_item_variations").insert(result.data);
      if (error) throw error;
      setVariationModalVisible(false);
      refetchVariations();
    } catch (e) {
      console.error("[PriceBook] Failed to save variation", e);
      setVariationError(getErrorMessage(e, "Failed to save variation (see console for details)"));
    }
  };

  const handleDeleteVariation = () => {
    if (!editingVariationId) return;
    Alert.alert("Delete variation", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await supabase.from("price_book_item_variations").delete().eq("id", editingVariationId);
          setVariationModalVisible(false);
          refetchVariations();
        },
      },
    ]);
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Price book" />
      </View>
    );
  }

  if (!item) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <FormField label="Description" value={description} onChangeText={setDescription} />

        <View style={styles.fieldGrid}>
          <View style={styles.fieldCell}>
            <FormField label="Labour rate ($/hr)" keyboardType="decimal-pad" value={labourRate} onChangeText={setLabourRate} />
          </View>
          <View style={styles.fieldCell}>
            <FormField label="Labour hours" keyboardType="decimal-pad" value={labourHours} onChangeText={setLabourHours} />
          </View>
        </View>

        <View style={styles.fieldGrid}>
          <View style={styles.fieldCell}>
            <FormField label="Material cost ($)" keyboardType="decimal-pad" value={materialCost} onChangeText={setMaterialCost} />
          </View>
          <View style={styles.fieldCell}>
            <FormField label="Markup (%)" keyboardType="decimal-pad" value={markupPercent} onChangeText={setMarkupPercent} />
          </View>
        </View>

        <View style={styles.previewBox}>
          <Text style={styles.previewLabel}>Computed price</Text>
          <Text style={styles.previewValue}>{formatCentsAsAud(previewCents)}</Text>
        </View>

        {saveError ? <Text style={styles.error}>{saveError}</Text> : null}

        <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
          <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save changes"}</Text>
        </Pressable>

        <Text style={styles.sectionTitle}>Variations</Text>
        {(variations ?? []).map((variation) => (
          <Pressable key={variation.id} style={styles.variationRow} onPress={() => openEditVariation(variation)}>
            <Text style={styles.variationName}>{variation.name}</Text>
            <Text style={styles.variationPrice}>{formatCentsAsAud(computeLineItemUnitPriceCents(variation))}</Text>
          </Pressable>
        ))}
        {(variations ?? []).length === 0 ? <Text style={styles.empty}>No variations yet.</Text> : null}
        <Pressable style={styles.addVariationButton} onPress={openNewVariation}>
          <Text style={styles.addVariationButtonText}>+ Add variation</Text>
        </Pressable>

        <Pressable style={styles.deleteButton} onPress={handleDelete}>
          <Text style={styles.deleteButtonText}>Delete item</Text>
        </Pressable>
      </ScrollView>

      <CenteredModal visible={variationModalVisible} onClose={() => setVariationModalVisible(false)}>
        <Text style={styles.modalTitle}>{editingVariationId ? "Edit variation" : "New variation"}</Text>
        <FormField
          label="Name"
          placeholder="e.g. Standard, Premium"
          value={variationForm.name}
          onChangeText={(text) => setVariationForm((f) => ({ ...f, name: text }))}
        />
        <View style={styles.fieldGrid}>
          <View style={styles.fieldCell}>
            <FormField
              label="Labour rate ($/hr)"
              keyboardType="decimal-pad"
              value={variationForm.labourRate}
              onChangeText={(text) => setVariationForm((f) => ({ ...f, labourRate: text }))}
            />
          </View>
          <View style={styles.fieldCell}>
            <FormField
              label="Labour hours"
              keyboardType="decimal-pad"
              value={variationForm.labourHours}
              onChangeText={(text) => setVariationForm((f) => ({ ...f, labourHours: text }))}
            />
          </View>
        </View>
        <View style={styles.fieldGrid}>
          <View style={styles.fieldCell}>
            <FormField
              label="Material cost ($)"
              keyboardType="decimal-pad"
              value={variationForm.materialCost}
              onChangeText={(text) => setVariationForm((f) => ({ ...f, materialCost: text }))}
            />
          </View>
          <View style={styles.fieldCell}>
            <FormField
              label="Markup (%)"
              keyboardType="decimal-pad"
              value={variationForm.markupPercent}
              onChangeText={(text) => setVariationForm((f) => ({ ...f, markupPercent: text }))}
            />
          </View>
        </View>
        {variationError ? <Text style={styles.error}>{variationError}</Text> : null}
        <View style={styles.modalActions}>
          {editingVariationId ? (
            <Pressable onPress={handleDeleteVariation}>
              <Text style={styles.deleteLink}>Delete</Text>
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => setVariationModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleSaveVariation}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  fieldGrid: { flexDirection: "row", gap: 12, marginTop: 16 },
  fieldCell: { flex: 1 },
  previewBox: { marginTop: 20, backgroundColor: "#f3f4f6", borderRadius: 8, padding: 12 },
  previewLabel: { fontSize: 12, fontWeight: "700", color: "#6b7280" },
  previewValue: { fontSize: 20, fontWeight: "800", color: "#111827", marginTop: 2 },
  error: { color: "#dc2626", marginTop: 12 },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 20 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginTop: 28, marginBottom: 6 },
  variationRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f0f0f0",
  },
  variationName: { fontSize: 15, fontWeight: "600", color: "#111827" },
  variationPrice: { fontSize: 14, color: "#1d4ed8", fontWeight: "600" },
  addVariationButton: { alignSelf: "flex-start", paddingVertical: 10 },
  addVariationButtonText: { color: "#1d4ed8", fontWeight: "600" },
  deleteButton: { borderRadius: 8, padding: 14, alignItems: "center", marginTop: 24, backgroundColor: "#fef2f2" },
  deleteButtonText: { color: "#dc2626", fontWeight: "700" },
  deleteLink: { color: "#dc2626", fontWeight: "600" },
  empty: { textAlign: "center", color: "#6b7280", padding: 12 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  link: { color: "#1d4ed8", fontWeight: "600" },
});

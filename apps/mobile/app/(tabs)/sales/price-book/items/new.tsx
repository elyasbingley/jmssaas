import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  computeLineItemUnitPriceCents,
  createPriceBookItemSchema,
  formatCentsAsAud,
} from "@jmssaas/shared";
import { useAuth } from "../../../../../lib/auth-context";
import { supabase } from "../../../../../lib/supabase";
import { getErrorMessage } from "../../../../../lib/errors";
import { FormField } from "../../../../../components/FormField";

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

export default function NewPriceBookItemScreen() {
  const { categoryId } = useLocalSearchParams<{ categoryId: string }>();
  const router = useRouter();
  const { profile } = useAuth();

  const [description, setDescription] = useState("");
  const [labourRate, setLabourRate] = useState("0");
  const [labourHours, setLabourHours] = useState("0");
  const [materialCost, setMaterialCost] = useState("0");
  const [markupPercent, setMarkupPercent] = useState("0");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const previewCents = computeLineItemUnitPriceCents({
    labour_rate_cents: Math.round(parseNumber(labourRate) * 100),
    labour_hours: parseNumber(labourHours),
    material_cost_cents: Math.round(parseNumber(materialCost) * 100),
    markup_percent: parseNumber(markupPercent),
  });

  const handleSubmit = async () => {
    const result = createPriceBookItemSchema.safeParse({
      category_id: categoryId,
      description,
      labour_rate_cents: Math.round(parseNumber(labourRate) * 100),
      labour_hours: parseNumber(labourHours),
      material_cost_cents: Math.round(parseNumber(materialCost) * 100),
      markup_percent: parseNumber(markupPercent),
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    if (!profile) return;

    setSubmitting(true);
    setFormError(null);
    try {
      const { data, error } = await supabase
        .from("price_book_items")
        .insert({ ...result.data, tenant_id: profile.tenant_id })
        .select()
        .single();
      if (error) throw error;
      router.replace(`/sales/price-book/items/${data.id}`);
    } catch (e) {
      console.error("[PriceBook] Failed to create item", e);
      setFormError(getErrorMessage(e, "Failed to create item (see console for details)"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <FormField
        label="Description"
        placeholder="e.g. Supply and install colorbond gutter"
        value={description}
        onChangeText={setDescription}
      />

      <View style={styles.fieldGrid}>
        <View style={styles.fieldCell}>
          <FormField label="Labour rate ($/hr)" placeholder="0" keyboardType="decimal-pad" value={labourRate} onChangeText={setLabourRate} />
        </View>
        <View style={styles.fieldCell}>
          <FormField label="Labour hours" placeholder="0" keyboardType="decimal-pad" value={labourHours} onChangeText={setLabourHours} />
        </View>
      </View>

      <View style={styles.fieldGrid}>
        <View style={styles.fieldCell}>
          <FormField label="Material cost ($)" placeholder="0" keyboardType="decimal-pad" value={materialCost} onChangeText={setMaterialCost} />
        </View>
        <View style={styles.fieldCell}>
          <FormField label="Markup (%)" placeholder="0" keyboardType="decimal-pad" value={markupPercent} onChangeText={setMarkupPercent} />
        </View>
      </View>

      <View style={styles.previewBox}>
        <Text style={styles.previewLabel}>Computed price</Text>
        <Text style={styles.previewValue}>{formatCentsAsAud(previewCents)}</Text>
      </View>

      {formError ? <Text style={styles.error}>{formError}</Text> : null}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        <Text style={styles.submitButtonText}>{submitting ? "Saving..." : "Create item"}</Text>
      </Pressable>
    </ScrollView>
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
  submitButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 20 },
  submitButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});

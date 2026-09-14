import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  computeLineItemUnitPriceCents,
  createPriceBookItemSchema,
  createPriceBookVariationSchema,
  formatCentsAsAud,
  type PriceBookItem,
  type PriceBookItemVariation,
} from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { useIsOnline } from "../../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../lib/supabase";
import { getErrorMessage } from "../../../../lib/errors";
import { useThemedStyles, type StyleTheme } from "../../../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedModal } from "../../../../components/theme/ThemedModal";
import { ThemedFormField } from "../../../../components/theme/ThemedFormField";
import { ThemedButton } from "../../../../components/theme/ThemedButton";

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
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

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
  const [isCalloutFee, setIsCalloutFee] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (item) {
      setDescription(item.description);
      setLabourRate((item.labour_rate_cents / 100).toString());
      setLabourHours(item.labour_hours.toString());
      setMaterialCost((item.material_cost_cents / 100).toString());
      setMarkupPercent(item.markup_percent.toString());
      setIsCalloutFee(item.is_callout_fee ?? false);
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
      is_callout_fee: isCalloutFee,
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
    if (!profile) return;
    try {
      const { error } = editingVariationId
        ? await supabase.from("price_book_item_variations").update(result.data).eq("id", editingVariationId)
        : await supabase
            .from("price_book_item_variations")
            .insert({ ...result.data, tenant_id: profile.tenant_id });
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

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Text style={styles.link}>‹ Back</Text>
      </Pressable>
      <Text style={styles.headerTitle}>Item</Text>
    </View>
  );

  if (!isOnline) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
          {header}
          <ThemedRequiresConnectionNotice label="Price book" />
        </SafeAreaView>
      </>
    );
  }

  if (!item) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
          {header}
          <View style={styles.container}>
            <Text style={styles.empty}>Loading...</Text>
          </View>
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        {header}
        <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
          <ThemedFormField
            label="Description"
            placeholder={"e.g. Tile Replacement\n\n- Remove the existing tile\n- Supply and fit new tiles\n- Dispose of trade waste"}
            value={description}
            onChangeText={setDescription}
            multiline
            style={styles.multilineInput}
          />

          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <ThemedFormField label="Labour rate ($/hr)" keyboardType="decimal-pad" value={labourRate} onChangeText={setLabourRate} />
            </View>
            <View style={styles.fieldCell}>
              <ThemedFormField label="Labour hours" keyboardType="decimal-pad" value={labourHours} onChangeText={setLabourHours} />
            </View>
          </View>

          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <ThemedFormField label="Material cost ($)" keyboardType="decimal-pad" value={materialCost} onChangeText={setMaterialCost} />
            </View>
            <View style={styles.fieldCell}>
              <ThemedFormField label="Markup (%)" keyboardType="decimal-pad" value={markupPercent} onChangeText={setMarkupPercent} />
            </View>
          </View>

          <View style={styles.switchRow}>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.switchLabel}>This is the call-out / service fee</Text>
              <Text style={styles.switchHint}>
                A membership plan that waives the call-out fee will waive this item automatically when it's added to a quote or invoice.
              </Text>
            </View>
            <Switch value={isCalloutFee} onValueChange={setIsCalloutFee} />
          </View>

          <View style={styles.previewBox}>
            <Text style={styles.previewLabel}>Computed Price</Text>
            <Text style={styles.previewValue}>{formatCentsAsAud(previewCents)}</Text>
          </View>

          {saveError ? <Text style={styles.error}>{saveError}</Text> : null}

          <View style={styles.saveButtonWrap}>
            <ThemedButton label={saving ? "Saving..." : "Save Changes"} onPress={handleSave} disabled={saving} />
          </View>

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
            <Text style={styles.deleteButtonText}>Delete Item</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>

      <ThemedModal visible={variationModalVisible} onClose={() => setVariationModalVisible(false)}>
        <Text style={styles.modalTitle}>{editingVariationId ? "Edit Variation" : "New Variation"}</Text>
        <ThemedFormField
          label="Name"
          placeholder="e.g. Standard, Premium"
          value={variationForm.name}
          onChangeText={(text) => setVariationForm((f) => ({ ...f, name: text }))}
        />
        <View style={styles.fieldGrid}>
          <View style={styles.fieldCell}>
            <ThemedFormField
              label="Labour rate ($/hr)"
              keyboardType="decimal-pad"
              value={variationForm.labourRate}
              onChangeText={(text) => setVariationForm((f) => ({ ...f, labourRate: text }))}
            />
          </View>
          <View style={styles.fieldCell}>
            <ThemedFormField
              label="Labour hours"
              keyboardType="decimal-pad"
              value={variationForm.labourHours}
              onChangeText={(text) => setVariationForm((f) => ({ ...f, labourHours: text }))}
            />
          </View>
        </View>
        <View style={styles.fieldGrid}>
          <View style={styles.fieldCell}>
            <ThemedFormField
              label="Material cost ($)"
              keyboardType="decimal-pad"
              value={variationForm.materialCost}
              onChangeText={(text) => setVariationForm((f) => ({ ...f, materialCost: text }))}
            />
          </View>
          <View style={styles.fieldCell}>
            <ThemedFormField
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
          <ThemedButton label="Save" onPress={handleSaveVariation} />
        </View>
      </ThemedModal>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    headerTitle: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    multilineInput: { minHeight: 90, textAlignVertical: "top" as const },
    fieldGrid: { flexDirection: "row" as const, gap: 12, marginTop: 16 },
    fieldCell: { flex: 1 },
    switchRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 12, marginTop: 20 },
    switchLabel: { fontSize: font.body - 1, fontWeight: "600" as const, color: tokens.textPrimary, ...mono },
    switchHint: { fontSize: font.label, color: tokens.textMuted, marginTop: 2, ...mono },
    previewBox: { marginTop: 20, borderWidth: 1, borderColor: tokens.accent, backgroundColor: tokens.accentGlow, borderRadius: 4, padding: 12 },
    previewLabel: { fontSize: font.label, fontWeight: "700" as const, color: tokens.accent, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    previewValue: { fontSize: 20, fontWeight: "800" as const, color: tokens.textPrimary, marginTop: 2, ...mono },
    error: { color: tokens.danger, marginTop: 12, ...mono },
    saveButtonWrap: { marginTop: 20 },
    sectionTitle: {
      fontSize: font.label,
      fontWeight: "700" as const,
      color: tokens.accent,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      marginTop: 28,
      marginBottom: 6,
      ...mono,
    },
    variationRow: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    variationName: { fontSize: font.body - 1, fontWeight: "600" as const, color: tokens.textPrimary, ...mono },
    variationPrice: { fontSize: font.body - 2, color: tokens.accent, fontWeight: "600" as const, ...mono },
    addVariationButton: { alignSelf: "flex-start" as const, paddingVertical: 10 },
    addVariationButtonText: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    deleteButton: { borderRadius: 3, padding: 14, alignItems: "center" as const, marginTop: 24, borderWidth: 1, borderColor: tokens.danger },
    deleteButtonText: { color: tokens.danger, fontWeight: "700" as const, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    deleteLink: { color: tokens.danger, fontWeight: "600" as const, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 12, ...mono },
    modalTitle: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      marginBottom: 4,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 20, marginTop: 8 },
  };
}

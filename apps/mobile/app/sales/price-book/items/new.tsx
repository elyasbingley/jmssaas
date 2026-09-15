import { useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  computeLineItemUnitPriceCents,
  createPriceBookItemSchema,
  formatCentsAsAud,
} from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { supabase } from "../../../../lib/supabase";
import { getErrorMessage } from "../../../../lib/errors";
import { useThemedStyles, type StyleTheme } from "../../../../lib/use-themed-styles";
import { ThemedFormField } from "../../../../components/theme/ThemedFormField";
import { ThemedButton } from "../../../../components/theme/ThemedButton";

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

export default function NewPriceBookItemScreen() {
  const { categoryId } = useLocalSearchParams<{ categoryId: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const styles = useThemedStyles(createStyles);

  const [description, setDescription] = useState("");
  const [labourRate, setLabourRate] = useState("0");
  const [labourHours, setLabourHours] = useState("0");
  const [materialCost, setMaterialCost] = useState("0");
  const [markupPercent, setMarkupPercent] = useState("0");
  const [isCalloutFee, setIsCalloutFee] = useState(false);
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
      is_callout_fee: isCalloutFee,
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
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>New Item</Text>
        </View>

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
              <ThemedFormField label="Labour rate ($/hr)" placeholder="0" keyboardType="decimal-pad" value={labourRate} onChangeText={setLabourRate} />
            </View>
            <View style={styles.fieldCell}>
              <ThemedFormField label="Labour hours" placeholder="0" keyboardType="decimal-pad" value={labourHours} onChangeText={setLabourHours} />
            </View>
          </View>

          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <ThemedFormField label="Material cost ($)" placeholder="0" keyboardType="decimal-pad" value={materialCost} onChangeText={setMaterialCost} />
            </View>
            <View style={styles.fieldCell}>
              <ThemedFormField label="Markup (%)" placeholder="0" keyboardType="decimal-pad" value={markupPercent} onChangeText={setMarkupPercent} />
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

          {formError ? <Text style={styles.error}>{formError}</Text> : null}

          <View style={styles.submitButtonWrap}>
            <ThemedButton label={submitting ? "Saving..." : "Create Item"} onPress={handleSubmit} disabled={submitting} />
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
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
    submitButtonWrap: { marginTop: 20 },
  };
}

import { useState } from "react";
import { Alert, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  computeItemizedLinePricing,
  computeLineItemUnitPriceCents,
  createPriceBookItemSchema,
  createPriceBookVariationSchema,
  formatCentsAsAud,
  type LineItemCrewInput,
  type LineItemMaterialInput,
  type PriceBookItem,
  type PriceBookItemCrew,
  type PriceBookItemMaterial,
  type PriceBookItemVariation,
  type PriceBookItemVariationCrew,
  type PriceBookItemVariationMaterial,
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
import { UnitPicker } from "../../../../components/UnitPicker";
import { PriceBookItemizedFields, type PriceBookPricingFields } from "../../../../components/PriceBookItemizedFields";

const emptyPricing: PriceBookPricingFields = {
  pricing_model: "legacy",
  quantity: 1,
  labour_rate_cents: 0,
  labour_hours: 0,
  labour_cost_rate_cents: undefined,
  labour_charge_out_rate_cents: undefined,
  crew: [],
  material_cost_cents: 0,
  materials: [],
  markup_percent: 0,
  material_margin_percent: undefined,
  waste_percent: undefined,
  contingency_percent: undefined,
  tip_fees_cents: undefined,
  equipment_hire_cents: undefined,
  travel_cost_cents: undefined,
  is_subcontracted: false,
  subcontractor_cost_cents: 0,
  subcontractor_margin_percent: undefined,
};

function pricingFromItem(
  item: PriceBookItem | PriceBookItemVariation,
  crew: LineItemCrewInput[],
  materials: LineItemMaterialInput[]
): PriceBookPricingFields {
  return {
    pricing_model: item.pricing_model === "itemized" ? "itemized" : "legacy",
    quantity: item.quantity ?? 1,
    labour_rate_cents: item.labour_rate_cents,
    labour_hours: item.labour_hours,
    labour_cost_rate_cents: item.labour_cost_rate_cents ?? undefined,
    labour_charge_out_rate_cents: item.labour_charge_out_rate_cents ?? undefined,
    crew,
    material_cost_cents: item.material_cost_cents,
    materials,
    markup_percent: item.markup_percent,
    material_margin_percent: item.material_margin_percent ?? undefined,
    waste_percent: item.waste_percent ?? undefined,
    contingency_percent: item.contingency_percent ?? undefined,
    tip_fees_cents: item.tip_fees_cents ?? undefined,
    equipment_hire_cents: item.equipment_hire_cents ?? undefined,
    travel_cost_cents: item.travel_cost_cents ?? undefined,
    is_subcontracted: item.is_subcontracted ?? false,
    subcontractor_cost_cents: item.subcontractor_cost_cents ?? 0,
    subcontractor_margin_percent: item.subcontractor_margin_percent ?? undefined,
  };
}

function previewPriceCents(pricing: PriceBookPricingFields): number {
  return pricing.pricing_model === "itemized" ? computeItemizedLinePricing(pricing).unitPriceCents : computeLineItemUnitPriceCents(pricing);
}

// See the desktop port of this file (PriceBookItem.tsx) for why this
// exists - crew/materials aren't real columns on price_book_items/
// price_book_item_variations, they're their own child tables.
function splitPricingResult<T extends { crew?: LineItemCrewInput[]; materials?: LineItemMaterialInput[] }>(
  data: T
): { scalar: Omit<T, "crew" | "materials">; crew: LineItemCrewInput[]; materials: LineItemMaterialInput[] } {
  const { crew, materials, ...scalar } = data;
  return { scalar, crew: crew ?? [], materials: materials ?? [] };
}

async function fetchItemCrew(itemId: string): Promise<PriceBookItemCrew[]> {
  const { data, error } = await supabase.from("price_book_item_crew").select("*").eq("price_book_item_id", itemId).order("sort_order");
  if (error) throw error;
  return data as PriceBookItemCrew[];
}
async function fetchItemMaterials(itemId: string): Promise<PriceBookItemMaterial[]> {
  const { data, error } = await supabase.from("price_book_item_materials").select("*").eq("price_book_item_id", itemId).order("sort_order");
  if (error) throw error;
  return data as PriceBookItemMaterial[];
}
async function fetchVariationCrew(variationId: string): Promise<PriceBookItemVariationCrew[]> {
  const { data, error } = await supabase
    .from("price_book_item_variation_crew")
    .select("*")
    .eq("price_book_item_variation_id", variationId)
    .order("sort_order");
  if (error) throw error;
  return data as PriceBookItemVariationCrew[];
}
async function fetchVariationMaterials(variationId: string): Promise<PriceBookItemVariationMaterial[]> {
  const { data, error } = await supabase
    .from("price_book_item_variation_materials")
    .select("*")
    .eq("price_book_item_variation_id", variationId)
    .order("sort_order");
  if (error) throw error;
  return data as PriceBookItemVariationMaterial[];
}

export default function PriceBookItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

  const { data: item, refetch: refetchItem } = useSupabaseFetch<PriceBookItem>(async () => {
    const { data, error } = await supabase.from("price_book_items").select("*").eq("id", id).single();
    if (error) throw error;
    return data as PriceBookItem;
  }, [id, isOnline]);

  const { data: itemCrew, refetch: refetchItemCrew } = useSupabaseFetch<PriceBookItemCrew[]>(async () => fetchItemCrew(id), [id, isOnline]);
  const { data: itemMaterials, refetch: refetchItemMaterials } = useSupabaseFetch<PriceBookItemMaterial[]>(
    async () => fetchItemMaterials(id),
    [id, isOnline]
  );

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

  // Gate on all three fetches, not just `item`: PriceBookItemForm below
  // seeds its local state (including every DecimalInput's own displayed
  // text, inside PriceBookItemizedFields) once from props on mount, with
  // no re-seeding effect watching for later prop changes. Mounting it
  // before itemCrew/itemMaterials have loaded - as a
  // `useEffect([item, itemCrew, itemMaterials])` reseed used to allow -
  // means it captures a zeroed/blank value and then never updates its
  // displayed text once the real data arrives a render later, which is
  // what made labour (and every other field) appear wiped after save-and-
  // return. `key={id}` on PriceBookItemForm forces a fresh mount (and
  // fresh seed) if this screen ever points at a different item without a
  // full unmount.
  if (!item || !itemCrew || !itemMaterials) {
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
    <PriceBookItemForm
      key={id}
      id={id}
      item={item}
      itemCrew={itemCrew}
      itemMaterials={itemMaterials}
      variations={variations ?? []}
      refetchItem={refetchItem}
      refetchItemCrew={refetchItemCrew}
      refetchItemMaterials={refetchItemMaterials}
      refetchVariations={refetchVariations}
    />
  );
}

function PriceBookItemForm({
  id,
  item,
  itemCrew,
  itemMaterials,
  variations,
  refetchItem,
  refetchItemCrew,
  refetchItemMaterials,
  refetchVariations,
}: {
  id: string;
  item: PriceBookItem;
  itemCrew: PriceBookItemCrew[];
  itemMaterials: PriceBookItemMaterial[];
  variations: PriceBookItemVariation[];
  refetchItem: () => Promise<void> | void;
  refetchItemCrew: () => Promise<void> | void;
  refetchItemMaterials: () => Promise<void> | void;
  refetchVariations: () => Promise<void> | void;
}) {
  const router = useRouter();
  const { profile } = useAuth();
  const styles = useThemedStyles(createStyles);

  const [description, setDescription] = useState(item.description);
  const [isCalloutFee, setIsCalloutFee] = useState(item.is_callout_fee ?? false);
  const [gstApplicable, setGstApplicable] = useState(item.gst_applicable ?? true);
  const [unit, setUnit] = useState<string | null>(item.unit ?? null);
  const [warrantyText, setWarrantyText] = useState(item.warranty_text ?? "");
  const [pricing, setPricing] = useState<PriceBookPricingFields>(() =>
    pricingFromItem(
      item,
      itemCrew.map((c) => ({ ...c })),
      itemMaterials.map((m) => ({ ...m }))
    )
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const previewCents = previewPriceCents(pricing);

  const handleSave = async () => {
    if (!profile) return;
    const result = createPriceBookItemSchema.safeParse({
      category_id: item.category_id,
      description,
      is_callout_fee: isCalloutFee,
      gst_applicable: gstApplicable,
      unit,
      warranty_text: warrantyText || null,
      ...pricing,
    });
    if (!result.success) {
      setSaveError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const { scalar, crew, materials } = splitPricingResult(result.data);
      const { error } = await supabase.from("price_book_items").update(scalar).eq("id", id);
      if (error) throw error;

      const { error: deleteCrewError } = await supabase.from("price_book_item_crew").delete().eq("price_book_item_id", id);
      if (deleteCrewError) throw deleteCrewError;
      if (crew.length > 0) {
        const { error: crewError } = await supabase
          .from("price_book_item_crew")
          .insert(crew.map((c, i) => ({ ...c, tenant_id: profile.tenant_id, price_book_item_id: id, sort_order: c.sort_order ?? i })));
        if (crewError) throw crewError;
      }

      const { error: deleteMaterialsError } = await supabase.from("price_book_item_materials").delete().eq("price_book_item_id", id);
      if (deleteMaterialsError) throw deleteMaterialsError;
      if (materials.length > 0) {
        const { error: materialsError } = await supabase
          .from("price_book_item_materials")
          .insert(materials.map((m, i) => ({ ...m, tenant_id: profile.tenant_id, price_book_item_id: id, sort_order: m.sort_order ?? i })));
        if (materialsError) throw materialsError;
      }

      refetchItem();
      refetchItemCrew();
      refetchItemMaterials();
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
  const [variationName, setVariationName] = useState("");
  const [variationUnit, setVariationUnit] = useState<string | null>(null);
  const [variationWarrantyText, setVariationWarrantyText] = useState("");
  const [variationPricing, setVariationPricing] = useState<PriceBookPricingFields>(emptyPricing);
  const [variationError, setVariationError] = useState<string | null>(null);
  // Bumped every time the modal is (re)opened, and used as PriceBookItemizedFields'
  // key below. RN's <Modal> never unmounts its children when hidden (only
  // the native presentation toggles), so without this every DecimalInput
  // inside it stays the exact same mounted instance across different
  // variations and keeps showing/editing whatever it last seeded, no
  // matter which variation is actually open. The key forces a fresh mount
  // - and a fresh seed - every time.
  const [variationSessionKey, setVariationSessionKey] = useState(0);

  const openNewVariation = () => {
    setEditingVariationId(null);
    setVariationName("");
    setVariationUnit(null);
    setVariationWarrantyText("");
    setVariationPricing(emptyPricing);
    setVariationError(null);
    setVariationSessionKey((k) => k + 1);
    setVariationModalVisible(true);
  };

  const openEditVariation = async (variation: PriceBookItemVariation) => {
    // Fetch crew/materials and set every field - including pricing - before
    // opening the modal, not after: opening it first (as this used to do)
    // mounts PriceBookItemizedFields - and every DecimalInput inside it,
    // which seeds its own displayed text once on mount with no resync -
    // while variationPricing still holds the previous variation's values
    // (or emptyPricing), and that stale seed never catches up once the
    // real fetch resolves a moment later. Same race as this screen's own
    // item-level reseed bug, just one level down in the variation modal.
    setVariationError(null);
    const [crew, materials] = await Promise.all([fetchVariationCrew(variation.id), fetchVariationMaterials(variation.id)]);
    setEditingVariationId(variation.id);
    setVariationName(variation.name);
    setVariationUnit(variation.unit ?? null);
    setVariationWarrantyText(variation.warranty_text ?? "");
    setVariationPricing(pricingFromItem(variation, crew, materials));
    setVariationSessionKey((k) => k + 1);
    setVariationModalVisible(true);
  };

  const handleSaveVariation = async () => {
    if (!profile) return;
    const result = createPriceBookVariationSchema.safeParse({
      price_book_item_id: id,
      name: variationName,
      unit: variationUnit,
      warranty_text: variationWarrantyText || null,
      ...variationPricing,
    });
    if (!result.success) {
      setVariationError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    try {
      const { scalar, crew, materials } = splitPricingResult(result.data);
      const { data: savedVariation, error } = editingVariationId
        ? await supabase.from("price_book_item_variations").update(scalar).eq("id", editingVariationId).select("id").single()
        : await supabase
            .from("price_book_item_variations")
            .insert({ ...scalar, tenant_id: profile.tenant_id })
            .select("id")
            .single();
      if (error) throw error;
      const variationId = savedVariation.id as string;

      const { error: deleteCrewError } = await supabase
        .from("price_book_item_variation_crew")
        .delete()
        .eq("price_book_item_variation_id", variationId);
      if (deleteCrewError) throw deleteCrewError;
      if (crew.length > 0) {
        const { error: crewError } = await supabase
          .from("price_book_item_variation_crew")
          .insert(crew.map((c, i) => ({ ...c, tenant_id: profile.tenant_id, price_book_item_variation_id: variationId, sort_order: c.sort_order ?? i })));
        if (crewError) throw crewError;
      }

      const { error: deleteMaterialsError } = await supabase
        .from("price_book_item_variation_materials")
        .delete()
        .eq("price_book_item_variation_id", variationId);
      if (deleteMaterialsError) throw deleteMaterialsError;
      if (materials.length > 0) {
        const { error: materialsError } = await supabase.from("price_book_item_variation_materials").insert(
          materials.map((m, i) => ({ ...m, tenant_id: profile.tenant_id, price_book_item_variation_id: variationId, sort_order: m.sort_order ?? i }))
        );
        if (materialsError) throw materialsError;
      }

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
              <Text style={styles.switchLabel}>Unit</Text>
              <UnitPicker value={unit} onChangeValue={setUnit} />
            </View>
            <View style={styles.fieldCell}>
              <ThemedFormField
                label="Warranty (shown to the client)"
                placeholder="e.g. 10 year workmanship warranty"
                value={warrantyText}
                onChangeText={setWarrantyText}
              />
            </View>
          </View>

          <View style={{ marginTop: 12 }}>
            <PriceBookItemizedFields value={pricing} onChange={(patch) => setPricing((prev) => ({ ...prev, ...patch }))} />
            {pricing.pricing_model === "itemized" ? (
              <View style={{ marginTop: 12 }}>
                <ThemedFormField
                  label="Benchmark quantity (what the itemized total above was priced for, e.g. 70 for a $/lm rate)"
                  keyboardType="decimal-pad"
                  value={String(pricing.quantity)}
                  onChangeText={(text) => setPricing((prev) => ({ ...prev, quantity: parseFloat(text) || 1 }))}
                />
              </View>
            ) : null}
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

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>GST applicable</Text>
            <Switch value={gstApplicable} onValueChange={setGstApplicable} />
          </View>

          <View style={styles.previewBox}>
            <Text style={styles.previewLabel}>Computed Price{pricing.pricing_model === "itemized" ? ` (per ${pricing.quantity} ${unit ?? "unit"})` : ""}</Text>
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
              <Text style={styles.variationPrice}>{formatCentsAsAud(previewPriceCents(pricingFromItem(variation, [], [])))}</Text>
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
        <ScrollView>
          <Text style={styles.modalTitle}>{editingVariationId ? "Edit Variation" : "New Variation"}</Text>
          <ThemedFormField label="Name" placeholder="e.g. Standard, Premium" value={variationName} onChangeText={setVariationName} />

          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <Text style={styles.switchLabel}>Unit</Text>
              <UnitPicker value={variationUnit} onChangeValue={setVariationUnit} />
            </View>
            <View style={styles.fieldCell}>
              <ThemedFormField
                label="Warranty (shown to the client)"
                placeholder="e.g. 10 year workmanship warranty"
                value={variationWarrantyText}
                onChangeText={setVariationWarrantyText}
              />
            </View>
          </View>

          <View style={{ marginTop: 12 }}>
            <PriceBookItemizedFields
              key={variationSessionKey}
              value={variationPricing}
              onChange={(patch) => setVariationPricing((prev) => ({ ...prev, ...patch }))}
            />
            {variationPricing.pricing_model === "itemized" ? (
              <View style={{ marginTop: 12 }}>
                <ThemedFormField
                  label="Benchmark quantity (what the itemized total above was priced for)"
                  keyboardType="decimal-pad"
                  value={String(variationPricing.quantity)}
                  onChangeText={(text) => setVariationPricing((prev) => ({ ...prev, quantity: parseFloat(text) || 1 }))}
                />
              </View>
            ) : null}
          </View>

          <View style={styles.previewBox}>
            <Text style={styles.previewLabel}>Computed Price</Text>
            <Text style={styles.previewValue}>{formatCentsAsAud(previewPriceCents(variationPricing))}</Text>
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
        </ScrollView>
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

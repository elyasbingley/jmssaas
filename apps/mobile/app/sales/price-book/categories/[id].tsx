import { useState } from "react";
import { ImageBackground, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { computeLineItemUnitPriceCents, formatCentsAsAud, type PriceBookCategory, type PriceBookItem } from "@jmssaas/shared";
import { useIsOnline } from "../../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../lib/supabase";
import { getErrorMessage } from "../../../../lib/errors";
import { useThemedStyles, type StyleTheme } from "../../../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedModal } from "../../../../components/theme/ThemedModal";
import { ThemedFormField } from "../../../../components/theme/ThemedFormField";
import { ThemedButton } from "../../../../components/theme/ThemedButton";

export default function PriceBookCategoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

  const { data: category } = useSupabaseFetch<PriceBookCategory>(async () => {
    const { data, error } = await supabase.from("price_book_categories").select("*").eq("id", id).single();
    if (error) throw error;
    return data as PriceBookCategory;
  }, [id, isOnline]);

  const { data: items, refetch } = useSupabaseFetch<PriceBookItem[]>(async () => {
    const { data, error } = await supabase
      .from("price_book_items")
      .select("*")
      .eq("category_id", id)
      .order("sort_order")
      .order("description");
    if (error) throw error;
    return (data ?? []) as PriceBookItem[];
  }, [id, isOnline]);
  useRefetchOnFocus(refetch);

  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editName, setEditName] = useState(category?.name ?? "");
  const [editError, setEditError] = useState<string | null>(null);

  const openEditModal = () => {
    if (!category) return;
    setEditName(category.name);
    setEditError(null);
    setEditModalVisible(true);
  };

  const handleRename = async () => {
    if (!editName.trim()) {
      setEditError("Name is required");
      return;
    }
    try {
      const { error } = await supabase.from("price_book_categories").update({ name: editName.trim() }).eq("id", id);
      if (error) throw error;
      setEditModalVisible(false);
    } catch (e) {
      setEditError(getErrorMessage(e, "Failed to rename category"));
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
          <Text style={styles.title} numberOfLines={1}>
            {category?.name ?? ""}
          </Text>
          <Pressable
            style={styles.addButton}
            onPress={() => router.push({ pathname: "/sales/price-book/items/new", params: { categoryId: id } })}
            hitSlop={8}
          >
            <Text style={styles.addButtonText}>+</Text>
          </Pressable>
        </View>
        <Pressable onPress={openEditModal} style={styles.renameRow}>
          <Text style={styles.linkSmall}>Rename category</Text>
        </Pressable>

        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Price book" />
        ) : (
          <ScrollView style={styles.container} contentContainerStyle={{ padding: 12, paddingBottom: 40 }}>
            <View style={styles.grid}>
              {(items ?? []).map((item) => (
                <Pressable key={item.id} style={styles.tile} onPress={() => router.push(`/sales/price-book/items/${item.id}`)}>
                  {item.image_url ? (
                    <ImageBackground source={{ uri: item.image_url }} style={styles.tileImageBg}>
                      <View style={styles.tileImageOverlay}>
                        <Text style={styles.tileImageLabel} numberOfLines={2}>
                          {item.description}
                        </Text>
                        <Text style={styles.tileImagePrice}>{formatCentsAsAud(computeLineItemUnitPriceCents(item))}</Text>
                      </View>
                    </ImageBackground>
                  ) : (
                    <View style={styles.tilePlain}>
                      <Text style={styles.tileLabel} numberOfLines={2}>
                        {item.description}
                      </Text>
                      <Text style={styles.tilePrice}>{formatCentsAsAud(computeLineItemUnitPriceCents(item))}</Text>
                    </View>
                  )}
                </Pressable>
              ))}
            </View>
            {(items ?? []).length === 0 ? <Text style={styles.empty}>No items yet in this category.</Text> : null}
          </ScrollView>
        )}
      </SafeAreaView>

      <ThemedModal visible={editModalVisible} onClose={() => setEditModalVisible(false)}>
        <Text style={styles.modalTitle}>Rename Category</Text>
        <ThemedFormField label="Name" value={editName} onChangeText={setEditName} />
        {editError ? <Text style={styles.error}>{editError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setEditModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label="Save" onPress={handleRename} />
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
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
      gap: 6,
    },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    linkSmall: { color: tokens.accent, fontWeight: "600" as const, fontSize: font.label, ...mono },
    renameRow: { paddingHorizontal: 16, paddingBottom: 8 },
    title: { fontSize: font.title + 2, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, flex: 1, textAlign: "center" as const, ...mono },
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
    grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 12 },
    tile: {
      width: "46%" as const,
      // See price-book/index.tsx's own comment - a wrapped 2-line description
      // plus the price line needs more vertical room than 1.3 left inside
      // this overflow-clipped tile, so text that didn't fit was silently cut
      // off rather than just looking cramped.
      aspectRatio: 1.05,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: tokens.border,
      overflow: "hidden" as const,
      boxShadow: `0 0 10px ${tokens.accentGlow}`,
    },
    tilePlain: {
      flex: 1,
      backgroundColor: tokens.surface,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 8,
      padding: 10,
    },
    tileImageBg: { flex: 1, justifyContent: "flex-end" as const },
    tileImageOverlay: { backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 6, gap: 2 },
    tileImageLabel: { fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary, textAlign: "center" as const, ...mono },
    tileImagePrice: { fontSize: font.label, color: tokens.textPrimary, fontWeight: "600" as const, textAlign: "center" as const, ...mono },
    tileLabel: { fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary, textAlign: "center" as const, ...mono },
    tilePrice: { fontSize: font.label, color: tokens.accent, fontWeight: "600" as const, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 24, ...mono },
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
    error: { color: tokens.danger, ...mono },
  };
}

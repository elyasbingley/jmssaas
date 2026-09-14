import { useState } from "react";
import { ImageBackground, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { createPriceBookCategorySchema, type PriceBookCategory } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { supabase } from "../../../lib/supabase";
import { getErrorMessage } from "../../../lib/errors";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedModal } from "../../../components/theme/ThemedModal";
import { ThemedFormField } from "../../../components/theme/ThemedFormField";
import { ThemedButton } from "../../../components/theme/ThemedButton";

// Price book data is admin-managed catalogue data, not something a
// technician needs offline in the field (they can't create quotes/invoices
// at all - see the Phase 1 role-gating fix), so like quotes/invoices this
// is a plain online Supabase fetch rather than a PowerSync-watched query.
export default function PriceBookScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

  const { data: categories, refetch } = useSupabaseFetch<PriceBookCategory[]>(async () => {
    const { data, error } = await supabase
      .from("price_book_categories")
      .select("*")
      .order("sort_order")
      .order("name");
    if (error) throw error;
    return (data ?? []) as PriceBookCategory[];
  }, [isOnline]);
  useRefetchOnFocus(refetch);

  const [modalVisible, setModalVisible] = useState(false);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const closeModal = () => {
    setModalVisible(false);
    setFormError(null);
  };

  const handleCreate = async () => {
    const result = createPriceBookCategorySchema.safeParse({ name, sort_order: categories?.length ?? 0 });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Invalid category");
      return;
    }
    if (!profile) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const { error } = await supabase
        .from("price_book_categories")
        .insert({ ...result.data, tenant_id: profile.tenant_id });
      if (error) throw error;
      setName("");
      setModalVisible(false);
      refetch();
    } catch (e) {
      console.error("[PriceBook] Failed to create category", e);
      setFormError(getErrorMessage(e, "Failed to create category (see console for details)"));
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
          <Text style={styles.title}>Price Book</Text>
          <Pressable style={styles.addButton} onPress={() => setModalVisible(true)} hitSlop={8}>
            <Text style={styles.addButtonText}>+</Text>
          </Pressable>
        </View>

        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Price book" />
        ) : (
          <ScrollView style={styles.container} contentContainerStyle={{ padding: 12, paddingBottom: 40 }}>
            <View style={styles.grid}>
              {(categories ?? []).map((category) => (
                <Pressable key={category.id} style={styles.tile} onPress={() => router.push(`/sales/price-book/categories/${category.id}`)}>
                  {category.image_url ? (
                    <ImageBackground source={{ uri: category.image_url }} style={styles.tileImageBg}>
                      <View style={styles.tileImageOverlay}>
                        <Text style={styles.tileImageLabel} numberOfLines={2}>
                          {category.name}
                        </Text>
                      </View>
                    </ImageBackground>
                  ) : (
                    <View style={styles.tilePlain}>
                      <Text style={styles.tileEmoji}>📋</Text>
                      <Text style={styles.tileLabel} numberOfLines={2}>
                        {category.name}
                      </Text>
                    </View>
                  )}
                </Pressable>
              ))}
            </View>
            {(categories ?? []).length === 0 ? <Text style={styles.empty}>No categories yet.</Text> : null}
          </ScrollView>
        )}
      </SafeAreaView>

      <ThemedModal visible={modalVisible} onClose={closeModal}>
        <Text style={styles.modalTitle}>New Category</Text>
        <ThemedFormField label="Name" placeholder="e.g. Gutters and Downpipes" value={name} onChangeText={setName} />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={closeModal}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label={submitting ? "Saving..." : "Save"} onPress={handleCreate} disabled={submitting} />
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
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, flex: 1, ...mono },
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
      // Shorter than 1.3 - a two-word category name wrapping to 2 lines plus
      // the emoji needs more vertical room than that left, and this tile
      // clips overflow (see tileImageBg's rounded corners) so text that
      // didn't fit was silently cut off rather than just looking cramped.
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
    },
    tileImageBg: { flex: 1, justifyContent: "flex-end" as const },
    tileImageOverlay: { backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 6 },
    tileImageLabel: { fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary, textAlign: "center" as const, ...mono },
    tileEmoji: { fontSize: 32 },
    tileLabel: {
      fontSize: font.body,
      fontWeight: "700" as const,
      color: tokens.textPrimary,
      textAlign: "center" as const,
      paddingHorizontal: 8,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      ...mono,
    },
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

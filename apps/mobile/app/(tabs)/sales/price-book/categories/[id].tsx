import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { computeLineItemUnitPriceCents, formatCentsAsAud, type PriceBookCategory, type PriceBookItem } from "@jmssaas/shared";
import { useIsOnline } from "../../../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../../lib/supabase";
import { getErrorMessage } from "../../../../../lib/errors";
import { RequiresConnectionNotice } from "../../../../../components/RequiresConnectionNotice";
import { CenteredModal } from "../../../../../components/CenteredModal";
import { FormField } from "../../../../../components/FormField";

export default function PriceBookCategoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isOnline = useIsOnline();

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

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Price book" />
      </View>
    );
  }

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={{ padding: 12, paddingBottom: 80 }}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>{category?.name ?? ""}</Text>
          <Pressable onPress={openEditModal}>
            <Text style={styles.link}>Rename</Text>
          </Pressable>
        </View>

        <View style={styles.grid}>
          {(items ?? []).map((item) => (
            <Pressable key={item.id} style={styles.tile} onPress={() => router.push(`/sales/price-book/items/${item.id}`)}>
              <Text style={styles.tileLabel} numberOfLines={1}>
                {item.description}
              </Text>
              <Text style={styles.tilePrice}>
                {formatCentsAsAud(computeLineItemUnitPriceCents(item))}
              </Text>
            </Pressable>
          ))}
        </View>
        {(items ?? []).length === 0 ? <Text style={styles.empty}>No items yet in this category.</Text> : null}
      </ScrollView>

      <Pressable style={styles.fab} onPress={() => router.push({ pathname: "/sales/price-book/items/new", params: { categoryId: id } })}>
        <Text style={styles.fabText}>+ New item</Text>
      </Pressable>

      <CenteredModal visible={editModalVisible} onClose={() => setEditModalVisible(false)}>
        <Text style={styles.modalTitle}>Rename category</Text>
        <FormField label="Name" value={editName} onChangeText={setEditName} />
        {editError ? <Text style={styles.error}>{editError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setEditModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleRename}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 4, paddingBottom: 12 },
  title: { fontSize: 18, fontWeight: "700" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  tile: {
    width: "46%",
    aspectRatio: 1.3,
    backgroundColor: "#f3f4f6",
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 10,
  },
  tileLabel: { fontSize: 15, fontWeight: "700", color: "#111827", textAlign: "center" },
  tilePrice: { fontSize: 13, color: "#1d4ed8", fontWeight: "600" },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
  fab: {
    position: "absolute",
    right: 16,
    bottom: 24,
    backgroundColor: "#1d4ed8",
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  fabText: { color: "#fff", fontWeight: "700" },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  link: { color: "#1d4ed8", fontWeight: "600" },
  error: { color: "#dc2626" },
});

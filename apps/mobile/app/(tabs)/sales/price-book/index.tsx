import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { createPriceBookCategorySchema, type PriceBookCategory } from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { useIsOnline } from "../../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../lib/supabase";
import { getErrorMessage } from "../../../../lib/errors";
import { RequiresConnectionNotice } from "../../../../components/RequiresConnectionNotice";
import { CenteredModal } from "../../../../components/CenteredModal";
import { FormField } from "../../../../components/FormField";

// Price book data is admin-managed catalogue data, not something a
// technician needs offline in the field (they can't create quotes/invoices
// at all - see the Phase 1 role-gating fix), so like quotes/invoices this
// is a plain online Supabase fetch rather than a PowerSync-watched query.
export default function PriceBookScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();

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
        <View style={styles.grid}>
          {(categories ?? []).map((category) => (
            <Pressable
              key={category.id}
              style={styles.tile}
              onPress={() => router.push(`/sales/price-book/categories/${category.id}`)}
            >
              <Text style={styles.tileEmoji}>📋</Text>
              <Text style={styles.tileLabel}>{category.name}</Text>
            </Pressable>
          ))}
        </View>
        {(categories ?? []).length === 0 ? <Text style={styles.empty}>No categories yet.</Text> : null}
      </ScrollView>

      <Pressable style={styles.fab} onPress={() => setModalVisible(true)}>
        <Text style={styles.fabText}>+ New category</Text>
      </Pressable>

      <CenteredModal
        visible={modalVisible}
        onClose={() => {
          setModalVisible(false);
          setFormError(null);
        }}
      >
        <Text style={styles.modalTitle}>New category</Text>
        <FormField label="Name" placeholder="e.g. Gutters and Downpipes" value={name} onChangeText={setName} />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable
            onPress={() => {
              setModalVisible(false);
              setFormError(null);
            }}
          >
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleCreate} disabled={submitting}>
            <Text style={styles.buttonText}>{submitting ? "Saving..." : "Save"}</Text>
          </Pressable>
        </View>
      </CenteredModal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  tile: {
    width: "46%",
    aspectRatio: 1.3,
    backgroundColor: "#f3f4f6",
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  tileEmoji: { fontSize: 32 },
  tileLabel: { fontSize: 16, fontWeight: "700", color: "#111827", textAlign: "center", paddingHorizontal: 8 },
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

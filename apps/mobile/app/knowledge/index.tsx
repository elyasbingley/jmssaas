import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { KnowledgeCategory } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useIsOnline } from "../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { RequiresConnectionNotice } from "../../components/RequiresConnectionNotice";

// Read-only on mobile - authoring (block editor, publish toggle) stays
// desktop-only, matching how Reports/Real Estate/Job Templates all work:
// the office builds it, the field reads it. Not a PowerSync table (see the
// knowledge_base migration), so this is Supabase-direct/connection-gated
// like every other admin-authored-office-content screen on this app.
async function fetchCategories(): Promise<KnowledgeCategory[]> {
  const { data, error } = await supabase.from("knowledge_categories").select("*").order("sort_order").order("name");
  if (error) throw error;
  return data as KnowledgeCategory[];
}
async function fetchUncategorisedCount(): Promise<number> {
  const { count, error } = await supabase.from("knowledge_articles").select("id", { count: "exact", head: true }).is("category_id", null);
  if (error) throw error;
  return count ?? 0;
}

export default function KnowledgeScreen() {
  const router = useRouter();
  const isOnline = useIsOnline();

  const { data: categories, loading, refetch } = useSupabaseFetch<KnowledgeCategory[]>(async () => {
    if (!isOnline) return [];
    return fetchCategories();
  }, [isOnline]);
  const { data: uncategorisedCount, refetch: refetchCount } = useSupabaseFetch<number>(async () => {
    if (!isOnline) return 0;
    return fetchUncategorisedCount();
  }, [isOnline]);
  useRefetchOnFocus(() => {
    refetch();
    refetchCount();
  });

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Knowledge" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["bottom"]}>
      <Text style={styles.subtitle}>SOPs, how-tos and training material for your team.</Text>
      <View style={styles.grid}>
        {(categories ?? []).map((category) => (
          <Pressable key={category.id} style={styles.tile} onPress={() => router.push(`/knowledge/categories/${category.id}`)}>
            <Text style={styles.tileEmoji}>📚</Text>
            <Text style={styles.tileLabel}>{category.name}</Text>
          </Pressable>
        ))}
        {!uncategorisedCount ? null : (
          <Pressable style={styles.tile} onPress={() => router.push("/knowledge/categories/uncategorised")}>
            <Text style={styles.tileEmoji}>📄</Text>
            <Text style={styles.tileLabel}>Uncategorised</Text>
          </Pressable>
        )}
      </View>
      {!loading && (categories ?? []).length === 0 && !uncategorisedCount ? (
        <Text style={styles.empty}>No articles yet.</Text>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  subtitle: { color: "#6b7280", padding: 16, paddingBottom: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap", padding: 12, gap: 12 },
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
  tileLabel: { fontSize: 16, fontWeight: "700", color: "#111827", textAlign: "center" },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
});

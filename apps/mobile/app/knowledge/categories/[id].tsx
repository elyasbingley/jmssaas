import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { KnowledgeArticle, KnowledgeCategory } from "@jmssaas/shared";
import { supabase } from "../../../lib/supabase";
import { useIsOnline } from "../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { RequiresConnectionNotice } from "../../../components/RequiresConnectionNotice";

const UNCATEGORISED = "uncategorised";

export default function KnowledgeCategoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isOnline = useIsOnline();
  const isUncategorised = id === UNCATEGORISED;

  const { data: category } = useSupabaseFetch<KnowledgeCategory | null>(async () => {
    if (!isOnline || isUncategorised) return null;
    const { data, error } = await supabase.from("knowledge_categories").select("*").eq("id", id).single();
    if (error) throw error;
    return data as KnowledgeCategory;
  }, [isOnline, id]);

  const { data: articles, loading, refetch } = useSupabaseFetch<KnowledgeArticle[]>(async () => {
    if (!isOnline) return [];
    const query = supabase.from("knowledge_articles").select("*").order("title");
    const { data, error } = await (isUncategorised ? query.is("category_id", null) : query.eq("category_id", id));
    if (error) throw error;
    return data as KnowledgeArticle[];
  }, [isOnline, id]);
  useRefetchOnFocus(refetch);

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Knowledge" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{isUncategorised ? "Uncategorised" : (category?.name ?? "")}</Text>
      {!loading && (!articles || articles.length === 0) ? (
        <Text style={styles.empty}>No articles yet in this category.</Text>
      ) : (
        (articles ?? []).map((article) => (
          <Pressable key={article.id} style={styles.row} onPress={() => router.push(`/knowledge/articles/${article.id}`)}>
            <Text style={styles.rowTitle}>{article.title}</Text>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  title: { fontSize: 20, fontWeight: "700", padding: 20, paddingBottom: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
  },
  rowTitle: { fontSize: 15, fontWeight: "600", color: "#111827", flex: 1, marginRight: 8 },
  chevron: { fontSize: 20, color: "#9ca3af" },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
});

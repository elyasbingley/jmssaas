import { Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { KnowledgeArticle, KnowledgeCategory } from "@jmssaas/shared";
import { supabase } from "../../../lib/supabase";
import { useIsOnline } from "../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../../components/theme/ThemedRequiresConnectionNotice";

const UNCATEGORISED = "uncategorised";

export default function KnowledgeCategoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isOnline = useIsOnline();
  const isUncategorised = id === UNCATEGORISED;
  const styles = useThemedStyles(createStyles);

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

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>{isUncategorised ? "Uncategorised" : (category?.name ?? "")}</Text>
        </View>

        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Knowledge" />
        ) : !loading && (!articles || articles.length === 0) ? (
          <Text style={styles.empty}>No articles yet in this category.</Text>
        ) : (
          (articles ?? []).map((article) => (
            <Pressable key={article.id} style={styles.row} onPress={() => router.push(`/knowledge/articles/${article.id}`)}>
              <Text style={styles.rowTitle}>{article.title}</Text>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))
        )}
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 6 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingVertical: 14,
      paddingHorizontal: 20,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    rowTitle: { fontSize: font.body - 1, fontWeight: "600" as const, color: tokens.textPrimary, flex: 1, marginRight: 8, ...mono },
    chevron: { fontSize: 20, color: tokens.accent },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 24, ...mono },
  };
}

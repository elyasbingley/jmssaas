import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { KnowledgeCategory } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useIsOnline } from "../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";

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
  const styles = useThemedStyles(createStyles);

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

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Knowledge Base</Text>
        </View>

        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Knowledge" />
        ) : (
          <>
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
          </>
        )}
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    subtitle: { color: tokens.textMuted, padding: 16, paddingBottom: 4, fontSize: font.body - 1, ...mono },
    grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, padding: 12, gap: 12 },
    tile: {
      width: "46%" as const,
      aspectRatio: 1.3,
      backgroundColor: tokens.surface,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 4,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 8,
      boxShadow: `0 0 10px ${tokens.accentGlow}`,
    },
    tileEmoji: { fontSize: 32 },
    tileLabel: {
      fontSize: font.body,
      fontWeight: "700" as const,
      color: tokens.textPrimary,
      textAlign: "center" as const,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      ...mono,
    },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 24, ...mono },
  };
}

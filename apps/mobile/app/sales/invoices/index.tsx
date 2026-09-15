import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Invoice, InvoiceStatus } from "@jmssaas/shared";
import { formatCentsAsAud } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { supabase } from "../../../lib/supabase";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../../components/theme/ThemedRequiresConnectionNotice";

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
};

type InvoiceRow = Invoice & { clients: { name: string } | null };

export default function InvoicesScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

  const { data: invoices, loading, refetch } = useSupabaseFetch<InvoiceRow[]>(async () => {
    const { data, error } = await supabase
      .from("invoices")
      .select("*, clients(name)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as InvoiceRow[];
  }, [isOnline]);
  useRefetchOnFocus(refetch);

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Invoices</Text>
          {profile?.role === "admin" ? (
            <Pressable style={styles.addButton} onPress={() => router.push("/sales/invoices/new")} hitSlop={8}>
              <Text style={styles.addButtonText}>+</Text>
            </Pressable>
          ) : (
            <View style={styles.addButtonSpacer} />
          )}
        </View>

        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Invoices" />
        ) : (
          <FlatList
            style={styles.list}
            data={invoices ?? []}
            keyExtractor={(item) => item.id}
            refreshControl={<RefreshControl refreshing={loading} onRefresh={refetch} tintColor={styles.refreshTint.color} />}
            renderItem={({ item }) => (
              <Pressable style={styles.row} onPress={() => router.push(`/sales/invoices/${item.id}`)}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>{item.invoice_number}</Text>
                  <Text style={styles.rowSubtitle}>{item.clients?.name ?? "Unknown client"}</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={styles.rowTotal}>{formatCentsAsAud(item.total_cents)}</Text>
                  <Text style={styles.statusBadge}>{STATUS_LABELS[item.status]}</Text>
                </View>
              </Pressable>
            )}
            ListEmptyComponent={!loading ? <Text style={styles.empty}>No invoices yet.</Text> : null}
            contentContainerStyle={(invoices ?? []).length === 0 ? styles.emptyContainer : styles.listContent}
          />
        )}
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
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
    addButtonSpacer: { width: 36, height: 36 },
    addButtonText: { color: tokens.accent, fontSize: 22, fontWeight: "700" as const, marginTop: -2, ...mono },
    list: { flex: 1, marginTop: 8 },
    listContent: { paddingBottom: 24 },
    refreshTint: { color: tokens.accent },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    rowTitle: { fontSize: font.body, fontWeight: "600" as const, color: tokens.textPrimary, ...mono },
    rowSubtitle: { color: tokens.textMuted, marginTop: 2, fontSize: font.label, ...mono },
    rowTotal: { fontWeight: "700" as const, color: tokens.textPrimary, fontSize: font.body, ...mono },
    statusBadge: { color: tokens.accent, fontWeight: "600" as const, fontSize: font.label, marginTop: 2, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, ...mono },
    emptyContainer: { flex: 1, justifyContent: "center" as const, padding: 24 },
  };
}

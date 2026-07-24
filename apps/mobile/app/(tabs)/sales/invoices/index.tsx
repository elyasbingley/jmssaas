import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { Invoice, InvoiceStatus } from "@jmssaas/shared";
import { formatCentsAsAud } from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { useIsOnline } from "../../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../lib/supabase";
import { RequiresConnectionNotice } from "../../../../components/RequiresConnectionNotice";

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

  const { data: invoices, loading, refetch } = useSupabaseFetch<InvoiceRow[]>(async () => {
    const { data, error } = await supabase
      .from("invoices")
      .select("*, clients(name)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as InvoiceRow[];
  }, [isOnline]);
  useRefetchOnFocus(refetch);

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Invoices" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={invoices ?? []}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refetch} />}
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
        contentContainerStyle={(invoices ?? []).length === 0 ? styles.emptyContainer : undefined}
      />
      {profile?.role === "admin" ? (
        <Pressable style={styles.fab} onPress={() => router.push("/sales/invoices/new")}>
          <Text style={styles.fabText}>+ New invoice</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f0f0f0",
  },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  rowSubtitle: { color: "#6b7280", marginTop: 2 },
  rowTotal: { fontWeight: "700" },
  statusBadge: { color: "#1d4ed8", fontWeight: "600", fontSize: 12, marginTop: 2 },
  empty: { textAlign: "center", color: "#6b7280" },
  emptyContainer: { flex: 1, justifyContent: "center", padding: 24 },
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
});

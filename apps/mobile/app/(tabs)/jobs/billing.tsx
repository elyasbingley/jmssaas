import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatCentsAsAud, type Invoice, type Quote } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { supabase } from "../../../lib/supabase";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { Panel } from "../../../components/theme/Panel";
import { ThemedButton } from "../../../components/theme/ThemedButton";

// Combined Billing entry point for a job - both quotes and invoices, each
// with its own total (never summed together). Tapping either navigates to
// the existing quote/invoice detail screen, same as everywhere else in the
// app, so editing/sending/creating works exactly as normal.
export default function JobBillingScreen() {
  const { jobCardId } = useLocalSearchParams<{ jobCardId: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

  const { data: quotes, refetch: refetchQuotes } = useSupabaseFetch<Quote[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("quotes").select("*").eq("job_card_id", jobCardId);
    if (error) throw error;
    return (data ?? []) as Quote[];
  }, [jobCardId, isOnline]);
  useRefetchOnFocus(refetchQuotes);

  const { data: invoices, refetch: refetchInvoices } = useSupabaseFetch<Invoice[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("invoices").select("*").eq("job_card_id", jobCardId);
    if (error) throw error;
    return (data ?? []) as Invoice[];
  }, [jobCardId, isOnline]);
  useRefetchOnFocus(refetchInvoices);

  const isAdmin = profile?.role === "admin";

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.backLink}>‹ BACK</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Billing</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Panel title="Quotes">
          {(quotes ?? []).map((q) => (
            <Pressable key={q.id} style={styles.row} onPress={() => router.push(`/sales/quotes/${q.id}`)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowText}>{q.quote_number}</Text>
                <Text style={styles.rowMeta}>{q.status.charAt(0).toUpperCase() + q.status.slice(1)}</Text>
              </View>
              <Text style={styles.rowTotal}>{formatCentsAsAud(q.total_cents)}</Text>
            </Pressable>
          ))}
          {isOnline && (quotes ?? []).length === 0 ? <Text style={styles.empty}>No quotes linked to this job.</Text> : null}
          {!isOnline ? (
            <Text style={styles.empty}>Connect to view or create quotes.</Text>
          ) : isAdmin ? (
            <ThemedButton
              variant="secondary"
              label="+ New Quote"
              onPress={() => router.push({ pathname: "/sales/quotes/new", params: { jobCardId } })}
            />
          ) : null}
        </Panel>

        <Panel title="Invoices">
          {(invoices ?? []).map((inv) => (
            <Pressable key={inv.id} style={styles.row} onPress={() => router.push(`/sales/invoices/${inv.id}`)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowText}>{inv.invoice_number}</Text>
                <Text style={styles.rowMeta}>{inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}</Text>
              </View>
              <Text style={styles.rowTotal}>{formatCentsAsAud(inv.total_cents)}</Text>
            </Pressable>
          ))}
          {isOnline && (invoices ?? []).length === 0 ? <Text style={styles.empty}>No invoices linked to this job.</Text> : null}
          {!isOnline ? (
            <Text style={styles.empty}>Connect to view or create invoices.</Text>
          ) : isAdmin ? (
            <ThemedButton
              variant="secondary"
              label="+ New Invoice"
              onPress={() => router.push({ pathname: "/sales/invoices/new", params: { jobCardId } })}
            />
          ) : null}
        </Panel>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    backLink: { color: tokens.accent, fontFamily: fontFamily.mobileFontFamily, fontSize: font.body, letterSpacing: 1 },
    headerTitle: {
      color: tokens.textPrimary,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.title,
      letterSpacing: 2,
      textTransform: "uppercase" as const,
    },
    row: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    rowText: { color: tokens.textPrimary, fontWeight: "600" as const, fontSize: font.body, fontFamily: fontFamily.mobileFontFamily },
    rowMeta: { color: tokens.textMuted, fontSize: font.label, marginTop: 2, fontFamily: fontFamily.mobileFontFamily },
    rowTotal: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.body, fontFamily: fontFamily.mobileFontFamily },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 12, fontFamily: fontFamily.mobileFontFamily },
  };
}

import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  DEFAULT_DASHBOARD_WIDGETS,
  invoiceDashboardBucket,
  quoteDashboardBucket,
  type DashboardWidgetPrefs,
  type InvoiceStatus,
  type QuoteStatus,
  type Tenant,
} from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";
import { useIsOnline } from "../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { supabase } from "../../lib/supabase";
import { addDays, isSameDay } from "../../lib/datetime";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

// Home tab of the new Home/Jobs/Notifications/More tab bar. Only Calendar
// and Tasks stay as tiles here - Sales (superseded by the Jobs tab) and
// Schedule (now reached from More) were dropped. Sign out moved to the
// bottom of the More screen; this header's icon button jumps straight to
// Channels instead, since that's the thing people needed fast, frequent
// access to from Home.
const TILES = [
  { href: "/tasks", label: "Tasks", emoji: "✅" },
  { href: "/calendar", label: "Calendar", emoji: "📅" },
] as const;

// The Dashboard widget cards below - jobs booked today/tomorrow, invoice
// and quote status breakdowns - mirror apps/desktop/src/pages/Dashboard.tsx,
// same bucketing logic (see @jmssaas/shared's dashboard.ts) so the two
// platforms can't drift apart on what "Unbilled"/"Overdue" mean. Quotes,
// invoices and calendar_events are all Supabase-direct/office-online data
// on this app (never synced to local SQLite - see docs/SETUP.md), so this
// section needs a connection the same way the Jobs tab's booked/unscheduled
// split does; the tile grid below it stays usable offline regardless, since
// it's just local navigation.
type BookedEvent = { job_card_id: string | null; start_at: string };
type QuoteRow = { id: string; status: QuoteStatus };
type InvoiceRow = { id: string; status: InvoiceStatus; quote_id: string | null };

export default function HomeScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  const { data: tenant } = useSupabaseFetch<Tenant>(async () => {
    if (!profile?.tenant_id) return null as unknown as Tenant;
    const { data, error } = await supabase.from("tenants").select("*").eq("id", profile.tenant_id).single();
    if (error) throw error;
    return data as Tenant;
  }, [profile?.tenant_id]);

  const { data: widgets } = useSupabaseFetch<DashboardWidgetPrefs>(async () => {
    if (!profile?.id) return DEFAULT_DASHBOARD_WIDGETS;
    const { data, error } = await supabase.from("profiles").select("dashboard_widgets").eq("id", profile.id).single();
    if (error) throw error;
    return (data?.dashboard_widgets as DashboardWidgetPrefs) ?? DEFAULT_DASHBOARD_WIDGETS;
  }, [profile?.id, isOnline]);

  const { data: events, refetch: refetchEvents } = useSupabaseFetch<BookedEvent[]>(async () => {
    const { data, error } = await supabase.from("calendar_events").select("job_card_id, start_at").not("job_card_id", "is", null);
    if (error) throw error;
    return (data ?? []) as BookedEvent[];
  }, [isOnline]);
  const { data: quotes, refetch: refetchQuotes } = useSupabaseFetch<QuoteRow[]>(async () => {
    const { data, error } = await supabase.from("quotes").select("id, status");
    if (error) throw error;
    return (data ?? []) as QuoteRow[];
  }, [isOnline]);
  const { data: invoices, refetch: refetchInvoices } = useSupabaseFetch<InvoiceRow[]>(async () => {
    const { data, error } = await supabase.from("invoices").select("id, status, quote_id");
    if (error) throw error;
    return (data ?? []) as InvoiceRow[];
  }, [isOnline]);
  useRefetchOnFocus(() => {
    refetchEvents();
    refetchQuotes();
    refetchInvoices();
  });

  const jobsToday = useMemo(() => {
    if (!events) return undefined;
    const today = new Date();
    return events.filter((e) => isSameDay(new Date(e.start_at), today)).length;
  }, [events]);

  const jobsTomorrow = useMemo(() => {
    if (!events) return undefined;
    const tomorrow = addDays(new Date(), 1);
    return events.filter((e) => isSameDay(new Date(e.start_at), tomorrow)).length;
  }, [events]);

  const invoiceCounts = useMemo(() => {
    if (!invoices) return undefined;
    const counts = { draft: 0, unpaid: 0, overdue: 0 };
    for (const invoice of invoices) {
      const bucket = invoiceDashboardBucket(invoice.status);
      if (bucket) counts[bucket]++;
    }
    return counts;
  }, [invoices]);

  const quoteCounts = useMemo(() => {
    if (!quotes || !invoices) return undefined;
    const billedQuoteIds = new Set(invoices.filter((i) => i.quote_id).map((i) => i.quote_id));
    const counts = { draft: 0, unbilled: 0, billed: 0 };
    for (const quote of quotes) {
      counts[quoteDashboardBucket(quote.status, billedQuoteIds.has(quote.id))]++;
    }
    return counts;
  }, [quotes, invoices]);

  const widgetPrefs = widgets ?? DEFAULT_DASHBOARD_WIDGETS;
  const anyWidgetOn = widgetPrefs.jobs_today || widgetPrefs.jobs_tomorrow || widgetPrefs.invoices || widgetPrefs.quotes;

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top"]}>
        <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
          <View style={styles.header}>
            <View>
              {tenant ? (
                isAdmin ? (
                  <Pressable onPress={() => router.push("/company-settings")}>
                    <Text style={styles.greeting}>{tenant.name}</Text>
                  </Pressable>
                ) : (
                  <Text style={styles.greeting}>{tenant.name}</Text>
                )
              ) : null}
              {profile ? <Text style={styles.subtitle}>{profile.full_name}</Text> : null}
            </View>
            <Pressable style={styles.channelsButton} onPress={() => router.push("/channels")} hitSlop={8}>
              <Text style={styles.channelsButtonText}>💬</Text>
            </Pressable>
          </View>

          {anyWidgetOn ? (
            !isOnline ? (
              <Text style={styles.offlineNotice}>Dashboard needs a connection to load - reconnect to see today's numbers.</Text>
            ) : (
              <View style={styles.widgetGrid}>
                {widgetPrefs.jobs_today ? (
                  <StatWidget styles={styles} label="Jobs booked today" value={jobsToday} onPress={() => router.push("/calendar")} />
                ) : null}
                {widgetPrefs.jobs_tomorrow ? (
                  <StatWidget
                    styles={styles}
                    label="Jobs booked tomorrow"
                    value={jobsTomorrow}
                    onPress={() => router.push("/calendar")}
                  />
                ) : null}
                {widgetPrefs.invoices ? (
                  <BreakdownWidget
                    styles={styles}
                    title="Invoices"
                    rows={[
                      { label: "Draft", value: invoiceCounts?.draft },
                      { label: "Unpaid", value: invoiceCounts?.unpaid },
                      { label: "Overdue", value: invoiceCounts?.overdue },
                    ]}
                    onPress={() => router.push("/sales/invoices")}
                  />
                ) : null}
                {widgetPrefs.quotes ? (
                  <BreakdownWidget
                    styles={styles}
                    title="Quotes"
                    rows={[
                      { label: "Draft", value: quoteCounts?.draft },
                      { label: "Unbilled", value: quoteCounts?.unbilled },
                      { label: "Billed", value: quoteCounts?.billed },
                    ]}
                    onPress={() => router.push("/sales/quotes")}
                  />
                ) : null}
              </View>
            )
          ) : null}

          <View style={styles.grid}>
            {TILES.map((tile) => (
              <Pressable key={tile.href} style={styles.tile} onPress={() => router.push(tile.href)}>
                <Text style={styles.tileEmoji}>{tile.emoji}</Text>
                <Text style={styles.tileLabel}>{tile.label}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

type HomeStyles = ReturnType<typeof createStyles>;

function StatWidget({
  styles,
  label,
  value,
  onPress,
}: {
  styles: HomeStyles;
  label: string;
  value: number | undefined;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.statCard} onPress={onPress}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value ?? "-"}</Text>
    </Pressable>
  );
}

function BreakdownWidget({
  styles,
  title,
  rows,
  onPress,
}: {
  styles: HomeStyles;
  title: string;
  rows: { label: string; value: number | undefined }[];
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.breakdownCard} onPress={onPress}>
      <Text style={styles.statLabel}>{title}</Text>
      {rows.map((row) => (
        <View key={row.label} style={styles.breakdownRow}>
          <Text style={styles.breakdownRowLabel}>{row.label}</Text>
          <Text style={styles.breakdownRowValue}>{row.value ?? "-"}</Text>
        </View>
      ))}
    </Pressable>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "flex-start" as const,
      padding: 20,
      paddingTop: 24,
    },
    greeting: { fontSize: font.title + 2, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    subtitle: { color: tokens.textMuted, marginTop: 2, fontSize: font.body - 1, ...mono },
    channelsButton: {
      width: 40,
      height: 40,
      borderRadius: 3,
      borderWidth: 1,
      borderColor: tokens.accent,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: tokens.accentGlow,
    },
    channelsButtonText: { fontSize: 18 },
    offlineNotice: { marginHorizontal: 20, marginBottom: 8, color: tokens.textMuted, fontSize: font.label, ...mono },
    widgetGrid: { flexDirection: "row" as const, flexWrap: "wrap" as const, paddingHorizontal: 12, gap: 12 },
    statCard: {
      width: "46%" as const,
      backgroundColor: tokens.surface,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 4,
      padding: 16,
      gap: 6,
      boxShadow: `0 0 10px ${tokens.accentGlow}`,
    },
    statLabel: {
      fontSize: font.label,
      fontWeight: "700" as const,
      color: tokens.textMuted,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      ...mono,
    },
    statValue: { fontSize: 32, fontWeight: "800" as const, color: tokens.accent, ...mono },
    breakdownCard: {
      width: "46%" as const,
      backgroundColor: tokens.surface,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 4,
      padding: 16,
      gap: 8,
      boxShadow: `0 0 10px ${tokens.accentGlow}`,
    },
    breakdownRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const },
    breakdownRowLabel: { fontSize: font.label, color: tokens.textPrimary, ...mono },
    breakdownRowValue: { fontSize: font.body + 1, fontWeight: "700" as const, color: tokens.accent, ...mono },
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
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      ...mono,
    },
  };
}

import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
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

// Mirrors the tab bar (Sales, Tasks, Calendar - Home itself isn't a tile of
// its own). Individual Jobs/Quotes/Invoices/Clients/Price Book tiles used
// to live here directly; Phase 4 of this pass combined those five into the
// Sales tab's own tile grid (see sales/index.tsx), so Home just points at
// the three tabs now instead of duplicating their sub-sections.
const TILES = [
  { href: "/sales", label: "Sales", emoji: "💼" },
  { href: "/tasks", label: "Tasks", emoji: "✅" },
  { href: "/calendar", label: "Calendar", emoji: "📅" },
] as const;

// Schedule/dispatch is the one deliberate exception to "Home only mirrors
// the tab bar" above - it's a standalone admin screen (not a tab, see
// app/schedule.tsx), previously reached via a small text link on the
// Calendar tab. Moved here as a proper tile, admin-only since dispatching
// technicians is an admin action like every other assignment/creation flow
// in this app - the link on Calendar was removed once this landed so
// there's exactly one way in, not two.
const SCHEDULE_TILE = { href: "/schedule", label: "Schedule", emoji: "🚚" } as const;

// The Dashboard widget cards below - jobs booked today/tomorrow, invoice
// and quote status breakdowns - mirror apps/desktop/src/pages/Dashboard.tsx,
// same bucketing logic (see @jmssaas/shared's dashboard.ts) so the two
// platforms can't drift apart on what "Unbilled"/"Overdue" mean. Quotes,
// invoices and calendar_events are all Supabase-direct/office-online data
// on this app (never synced to local SQLite - see docs/SETUP.md), so this
// section needs a connection the same way the Sales tab's Quotes/Invoices
// screens do; the tile grid below it stays usable offline regardless, since
// it's just local navigation.
type BookedEvent = { job_card_id: string | null; start_at: string };
type QuoteRow = { id: string; status: QuoteStatus };
type InvoiceRow = { id: string; status: InvoiceStatus; quote_id: string | null };

function StatWidget({ label, value, onPress }: { label: string; value: number | undefined; onPress: () => void }) {
  return (
    <Pressable style={styles.statCard} onPress={onPress}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value ?? "-"}</Text>
    </Pressable>
  );
}

function BreakdownWidget({
  title,
  rows,
  onPress,
}: {
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

export default function HomeScreen() {
  const router = useRouter();
  const { profile, signOut } = useAuth();
  const isOnline = useIsOnline();
  const tiles = profile?.role === "admin" ? [...TILES, SCHEDULE_TILE] : TILES;
  const isAdmin = profile?.role === "admin";

  // Company Settings/Team/Job Setup links used to live in this header - all
  // three moved to the new Settings tab (see (tabs)/settings/index.tsx), so
  // this header is back to just identifying the business + sign out.
  //
  // The header title used to be a hardcoded app name ("Bingley Job
  // Management"). It's now the tenant's own name, sourced from Company
  // Details > Company Name (tenants.name) - same Supabase-direct fetch
  // company-settings.tsx already uses, since `tenants` isn't a PowerSync
  // table. Tapping it jumps straight to Company Details for admins, who are
  // the only ones who can change it. Once this app has its own product
  // name, that name is meant to sit on the right side of this header,
  // opposite the company name - not built yet, there's just nothing there
  // to put it next to until then.
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
    <SafeAreaView style={styles.container} edges={["top"]}>
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
        <View style={styles.headerLinks}>
          <Pressable onPress={signOut}>
            <Text style={styles.link}>Sign out</Text>
          </Pressable>
        </View>
      </View>

      {anyWidgetOn ? (
        !isOnline ? (
          <Text style={styles.offlineNotice}>Dashboard needs a connection to load - reconnect to see today's numbers.</Text>
        ) : (
          <View style={styles.widgetGrid}>
            {widgetPrefs.jobs_today ? (
              <StatWidget label="Jobs booked today" value={jobsToday} onPress={() => router.push("/calendar")} />
            ) : null}
            {widgetPrefs.jobs_tomorrow ? (
              <StatWidget label="Jobs booked tomorrow" value={jobsTomorrow} onPress={() => router.push("/calendar")} />
            ) : null}
            {widgetPrefs.invoices ? (
              <BreakdownWidget
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
        {tiles.map((tile) => (
          <Pressable key={tile.href} style={styles.tile} onPress={() => router.push(tile.href)}>
            <Text style={styles.tileEmoji}>{tile.emoji}</Text>
            <Text style={styles.tileLabel}>{tile.label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: 20,
    paddingTop: 24,
  },
  greeting: { fontSize: 20, fontWeight: "700" },
  subtitle: { color: "#6b7280", marginTop: 2 },
  headerLinks: { alignItems: "flex-end", gap: 8 },
  link: { color: "#1d4ed8", fontWeight: "600" },
  offlineNotice: { marginHorizontal: 20, marginBottom: 8, color: "#6b7280", fontSize: 13 },
  widgetGrid: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 12, gap: 12 },
  statCard: {
    width: "46%",
    backgroundColor: "#eff6ff",
    borderRadius: 16,
    padding: 16,
    gap: 6,
  },
  statLabel: { fontSize: 13, fontWeight: "600", color: "#6b7280" },
  statValue: { fontSize: 32, fontWeight: "800", color: "#111827" },
  breakdownCard: {
    width: "46%",
    backgroundColor: "#eff6ff",
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  breakdownRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  breakdownRowLabel: { fontSize: 13, color: "#374151" },
  breakdownRowValue: { fontSize: 16, fontWeight: "700", color: "#111827" },
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
  tileLabel: { fontSize: 16, fontWeight: "700", color: "#111827" },
});

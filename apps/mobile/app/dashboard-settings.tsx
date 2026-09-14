import { StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  DASHBOARD_WIDGET_LABELS,
  DEFAULT_DASHBOARD_WIDGETS,
  updateDashboardWidgetsSchema,
  type DashboardWidgetPrefs,
} from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { useIsOnline } from "../lib/connectivity";
import { useSupabaseFetch } from "../lib/use-supabase-fetch";
import { supabase } from "../lib/supabase";
import { RequiresConnectionNotice } from "../components/RequiresConnectionNotice";

const WIDGET_KEYS = Object.keys(DASHBOARD_WIDGET_LABELS) as (keyof DashboardWidgetPrefs)[];

// Lets this user pick which of the Dashboard's four widgets show for them -
// per-user (profiles.dashboard_widgets), not tenant-wide. Fetched/written
// directly via Supabase like Company Details, not through PowerSync's local
// schema - see the dashboard_widget_prefs migration's own comment.
export default function DashboardSettingsScreen() {
  const { profile } = useAuth();
  const isOnline = useIsOnline();

  const { data, refetch } = useSupabaseFetch<DashboardWidgetPrefs>(async () => {
    const { data, error } = await supabase.from("profiles").select("dashboard_widgets").eq("id", profile?.id).single();
    if (error) throw error;
    return (data?.dashboard_widgets as DashboardWidgetPrefs) ?? DEFAULT_DASHBOARD_WIDGETS;
  }, [profile?.id, isOnline]);

  const widgets = data ?? DEFAULT_DASHBOARD_WIDGETS;

  const toggle = async (key: keyof DashboardWidgetPrefs) => {
    if (!profile) return;
    const next = updateDashboardWidgetsSchema.parse({ ...widgets, [key]: !widgets[key] });
    const { error } = await supabase.from("profiles").update({ dashboard_widgets: next }).eq("id", profile.id);
    if (error) {
      console.error("[DashboardSettings] Failed to save", error);
      return;
    }
    refetch();
  };

  if (!isOnline) {
    return (
      <SafeAreaView style={styles.container} edges={["bottom"]}>
        <RequiresConnectionNotice label="Dashboard settings" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["bottom"]}>
      <Text style={styles.subtitle}>Choose what shows on your Dashboard home screen.</Text>
      <View style={styles.list}>
        {WIDGET_KEYS.map((key) => (
          <View key={key} style={styles.row}>
            <Text style={styles.rowLabel}>{DASHBOARD_WIDGET_LABELS[key]}</Text>
            <Switch value={widgets[key]} onValueChange={() => toggle(key)} />
          </View>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  subtitle: { color: "#6b7280", padding: 16, paddingBottom: 4 },
  list: { paddingHorizontal: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f0f0f0",
  },
  rowLabel: { fontSize: 16, fontWeight: "600", color: "#111827" },
});

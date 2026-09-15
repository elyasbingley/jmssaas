import { Pressable, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
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
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../components/theme/ThemedRequiresConnectionNotice";

const WIDGET_KEYS = Object.keys(DASHBOARD_WIDGET_LABELS) as (keyof DashboardWidgetPrefs)[];

// Lets this user pick which of the Dashboard's four widgets show for them -
// per-user (profiles.dashboard_widgets), not tenant-wide. Fetched/written
// directly via Supabase like Company Details, not through PowerSync's local
// schema - see the dashboard_widget_prefs migration's own comment.
export default function DashboardSettingsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

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

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Dashboard</Text>
        </View>

        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Dashboard settings" />
        ) : (
          <>
            <Text style={styles.subtitle}>Choose what shows on your Dashboard home screen.</Text>
            <View style={styles.list}>
              {WIDGET_KEYS.map((key) => (
                <View key={key} style={styles.row}>
                  <Text style={styles.rowLabel}>{DASHBOARD_WIDGET_LABELS[key]}</Text>
                  <Switch value={widgets[key]} onValueChange={() => toggle(key)} />
                </View>
              ))}
            </View>
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
    list: { paddingHorizontal: 16 },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    rowLabel: { fontSize: font.body, fontWeight: "600" as const, color: tokens.textPrimary, ...mono },
  };
}

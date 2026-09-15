import { ScrollView, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { Panel } from "../../../components/theme/Panel";

// Placeholder for the Notifications tab (see the Home/Jobs/Notifications/
// More tab bar restructure) - the feature itself isn't built yet. Once it
// is, this screen becomes the inbox for: new Channels messages/emails,
// quote acceptances, task reminders, job booking reminders, and jobs that
// haven't been updated in a while. Listed here now so it's clear what's
// coming rather than shipping a screen with no explanation.
const UPCOMING = [
  { label: "Channels messages", detail: "New messages and emails in a Channel you're part of" },
  { label: "Quote acceptances", detail: "A client accepts (or declines) a quote you sent" },
  { label: "Task reminders", detail: "A task assigned to you is due or overdue" },
  { label: "Job booking reminders", detail: "An upcoming booking on your schedule" },
  { label: "Stale jobs", detail: "A job that hasn't been updated in a while" },
];

export default function NotificationsScreen() {
  const styles = useThemedStyles(createStyles);
  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Notifications</Text>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
          <Panel title="Status" status="Not built yet">
            <Text style={styles.body}>
              This tab is reserved for notifications - nothing is wired up here yet. When it's built, you'll see:
            </Text>
          </Panel>
          <Panel title="Coming Soon">
            {UPCOMING.map((item) => (
              <View key={item.label} style={styles.row}>
                <View style={styles.dot} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowLabel}>{item.label}</Text>
                  <Text style={styles.rowDetail}>{item.detail}</Text>
                </View>
              </View>
            ))}
          </Panel>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
    headerTitle: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    body: { fontSize: font.body - 1, color: tokens.textPrimary, lineHeight: 20, ...mono },
    row: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 10 },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: tokens.accent, marginTop: 6, boxShadow: `0 0 6px ${tokens.accentGlow}` },
    rowLabel: { fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    rowDetail: { fontSize: font.label, color: tokens.textMuted, marginTop: 2, ...mono },
  };
}

import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Notification } from "@jmssaas/shared";
import { useNotifications } from "../../../lib/use-notifications";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { Panel } from "../../../components/theme/Panel";

// Replaces the placeholder this screen used to be (see its old comment,
// still true of what's NOT built yet: quote acceptances, task reminders,
// job booking reminders, stale jobs - only "channel_message" exists so
// far). Tapping a row marks it read and routes based on `type` - the push
// notification itself always lands here first (per the user's explicit
// ask), this is what routes on from here to the actual thing.
function routeForNotification(n: Notification): string | null {
  if (n.type === "channel_message") return `/channels/${n.data.conversation_id}`;
  return null;
}

export default function NotificationsScreen() {
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const { notifications, loading, error, markRead } = useNotifications();

  const handlePress = async (n: Notification) => {
    if (!n.read_at) await markRead(n.id);
    const route = routeForNotification(n);
    if (route) router.push(route as Href);
  };

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Notifications</Text>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Panel title="Inbox" status={loading ? "Loading..." : `${notifications.length}`}>
            {!loading && notifications.length === 0 ? (
              <Text style={styles.empty}>Nothing yet - new Channels messages will show up here.</Text>
            ) : (
              notifications.map((n) => (
                <Pressable key={n.id} style={styles.row} onPress={() => handlePress(n)}>
                  {!n.read_at ? <View style={styles.unreadDot} /> : <View style={styles.unreadDotSpacer} />}
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowTitle, !n.read_at && styles.rowTitleUnread]}>{n.title}</Text>
                    <Text style={styles.rowBody} numberOfLines={2}>
                      {n.body}
                    </Text>
                    <Text style={styles.rowTime}>{new Date(n.created_at).toLocaleString("en-AU")}</Text>
                  </View>
                </Pressable>
              ))
            )}
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
    error: { color: tokens.danger, paddingHorizontal: 16, ...mono },
    empty: { fontSize: font.body - 1, color: tokens.textMuted, ...mono },
    row: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: tokens.border },
    unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.accent, marginTop: 6, boxShadow: `0 0 6px ${tokens.accentGlow}` },
    unreadDotSpacer: { width: 8, height: 8, marginTop: 6 },
    rowTitle: { fontSize: font.body, fontWeight: "600" as const, color: tokens.textMuted, ...mono },
    rowTitleUnread: { fontWeight: "700" as const, color: tokens.textPrimary },
    rowBody: { fontSize: font.label, color: tokens.textMuted, marginTop: 2, ...mono },
    rowTime: { fontSize: font.label - 1, color: tokens.textMuted, marginTop: 4, ...mono },
  };
}

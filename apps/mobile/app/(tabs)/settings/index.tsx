import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../lib/auth-context";

// The first three of these used to be small text links in Home's header
// (Company Settings/Team/Job Setup) - moved here into their own tab so
// Home goes back to being just the tile grid. Labels are renamed for this
// screen (Company Details/Team-Staff/Job Card Setup) but the routes
// they point at are unchanged (company-settings, team, job-setup - see
// app/_layout.tsx), so nothing about how those screens work changed,
// only how you get to them. Inventory Setup is new - manages the
// Material/Tools/... category hierarchy used by the Inventory tile in
// Sales (see app/inventory-setup.tsx). Automation & Messaging is also new -
// see app/automation-settings.tsx.
const SETTINGS_ITEMS = [
  { href: "/company-settings", label: "Company Details", emoji: "🏢" },
  { href: "/team", label: "Team/Staff", emoji: "👥" },
  { href: "/job-setup", label: "Job Card Setup", emoji: "🛠️" },
  { href: "/inventory-setup", label: "Inventory Setup", emoji: "📦" },
  { href: "/automation-settings", label: "Automation & Messaging", emoji: "💬" },
] as const;

export default function SettingsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Text style={styles.title}>Settings</Text>

      {isAdmin ? (
        <View style={styles.list}>
          {SETTINGS_ITEMS.map((item) => (
            <Pressable key={item.href} style={styles.row} onPress={() => router.push(item.href)}>
              <Text style={styles.rowEmoji}>{item.emoji}</Text>
              <Text style={styles.rowLabel}>{item.label}</Text>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Text style={styles.empty}>Nothing to configure here yet - check with an admin.</Text>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  title: { fontSize: 20, fontWeight: "700", padding: 20, paddingBottom: 8 },
  list: { paddingHorizontal: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f0f0f0",
    gap: 12,
  },
  rowEmoji: { fontSize: 20 },
  rowLabel: { flex: 1, fontSize: 16, fontWeight: "600", color: "#111827" },
  chevron: { fontSize: 20, color: "#9ca3af" },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
});

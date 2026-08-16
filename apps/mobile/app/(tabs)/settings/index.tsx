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
  { href: "/real-estate", label: "Real Estate & Strata", emoji: "🏘️" },
  { href: "/reports", label: "Reports & Safety", emoji: "📋" },
  { href: "/subcontractors", label: "Subcontractors", emoji: "🧰" },
  { href: "/b2b-referrals", label: "B2B & Referrals", emoji: "🤝" },
] as const;

// Every profile (technician or admin) connects their own Google Calendar,
// unlike everything in SETTINGS_ITEMS above which is admin-only - so this
// row is shown regardless of role, same reasoning as company-settings.tsx
// vs. this always-visible item.
const PERSONAL_SETTINGS_ITEMS = [{ href: "/google-calendar-settings", label: "Google Calendar", emoji: "📅" }] as const;

export default function SettingsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.list}>
        {PERSONAL_SETTINGS_ITEMS.map((item) => (
          <Pressable key={item.href} style={styles.row} onPress={() => router.push(item.href)}>
            <Text style={styles.rowEmoji}>{item.emoji}</Text>
            <Text style={styles.rowLabel}>{item.label}</Text>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
      </View>

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
      ) : null}
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
    borderBottomColor: "#d1d5db",
    gap: 12,
  },
  rowEmoji: { fontSize: 20 },
  rowLabel: { flex: 1, fontSize: 16, fontWeight: "600", color: "#111827" },
  chevron: { fontSize: 20, color: "#9ca3af" },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
});

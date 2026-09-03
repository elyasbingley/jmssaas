import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../lib/auth-context";

// Restyled from a plain row list to the same tile-grid pattern as Sales/
// Home (see (tabs)/sales/index.tsx) - the "master settings page" the
// desktop app got its own SettingsHub.tsx tile grid for. Same items, same
// routes as before (company-settings, team, job-setup, ... - see
// app/_layout.tsx), only how they're presented changed. Real Estate &
// Strata/Reports & Safety/Subcontractors/B2B & Referrals aren't really
// "settings" but have no other home on mobile (unlike desktop, which has
// its own top-level Sales section for them) - left in place rather than
// relocated, since only the visual style was asked to change here.
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
// tile is shown regardless of role, same reasoning as company-settings.tsx
// vs. this always-visible item.
const PERSONAL_SETTINGS_ITEMS = [{ href: "/google-calendar-settings", label: "Google Calendar", emoji: "📅" }] as const;

export default function SettingsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.grid}>
        {PERSONAL_SETTINGS_ITEMS.map((item) => (
          <Pressable key={item.href} style={styles.tile} onPress={() => router.push(item.href)}>
            <Text style={styles.tileEmoji}>{item.emoji}</Text>
            <Text style={styles.tileLabel}>{item.label}</Text>
          </Pressable>
        ))}
        {isAdmin
          ? SETTINGS_ITEMS.map((item) => (
              <Pressable key={item.href} style={styles.tile} onPress={() => router.push(item.href)}>
                <Text style={styles.tileEmoji}>{item.emoji}</Text>
                <Text style={styles.tileLabel}>{item.label}</Text>
              </Pressable>
            ))
          : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  title: { fontSize: 20, fontWeight: "700", padding: 20, paddingBottom: 8 },
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
  tileLabel: { fontSize: 16, fontWeight: "700", color: "#111827", textAlign: "center" },
});

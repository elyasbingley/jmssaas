import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../lib/auth-context";

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

export default function HomeScreen() {
  const router = useRouter();
  const { profile, signOut } = useAuth();

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Bingley Job Management</Text>
          {profile ? <Text style={styles.subtitle}>{profile.full_name}</Text> : null}
        </View>
        <View style={styles.headerLinks}>
          {profile?.role === "admin" ? (
            <Pressable onPress={() => router.push("/company-settings")}>
              <Text style={styles.link}>Company Settings</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={signOut}>
            <Text style={styles.link}>Sign out</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.grid}>
        {TILES.map((tile) => (
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

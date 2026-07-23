import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../lib/auth-context";

const TILES = [
  { href: "/jobs", label: "Jobs", emoji: "🛠️" },
  { href: "/quotes", label: "Quotes", emoji: "📄" },
  { href: "/invoices", label: "Invoices", emoji: "🧾" },
  { href: "/tasks", label: "Tasks", emoji: "✅" },
  { href: "/clients", label: "Clients", emoji: "👥" },
  { href: "/calendar", label: "Calendar", emoji: "📅" },
] as const;

// Landing screen (was the client list before this pass) - a home base with
// one tile per section, in the order requested: Jobs, Quotes, Invoices,
// Tasks, Clients, Calendar. Tapping a tile switches to that section's tab
// (same route as the bottom tab bar - tabs and tiles both just push to
// /jobs, /quotes, etc).
export default function HomeScreen() {
  const router = useRouter();
  const { profile, signOut } = useAuth();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Bingley Job Management</Text>
          {profile ? <Text style={styles.subtitle}>{profile.full_name}</Text> : null}
        </View>
        <Pressable onPress={signOut}>
          <Text style={styles.link}>Sign out</Text>
        </Pressable>
      </View>

      <View style={styles.grid}>
        {TILES.map((tile) => (
          <Pressable key={tile.href} style={styles.tile} onPress={() => router.push(tile.href)}>
            <Text style={styles.tileEmoji}>{tile.emoji}</Text>
            <Text style={styles.tileLabel}>{tile.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
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

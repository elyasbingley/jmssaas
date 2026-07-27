import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../lib/auth-context";

const TILES = [
  { href: "/sales/jobs", label: "Job Cards", emoji: "🛠️" },
  { href: "/sales/quotes", label: "Quotes", emoji: "📄" },
  { href: "/sales/invoices", label: "Invoices", emoji: "🧾" },
  { href: "/sales/clients", label: "Clients", emoji: "👥" },
  // Unlike Price Book below, Inventory is everyone's tile - the whole point
  // is a technician adjusting truck stock from the field, not an
  // admin-only catalogue (see the inventory_stock_control migration's RLS).
  { href: "/sales/inventory", label: "Inventory", emoji: "📦" },
] as const;

// Price Book is admin-only (only admins can create quotes/invoices, the
// only place it's used from - see the Phase 1 role-gating fix and the
// Phase 3 price book pass).
const PRICE_BOOK_TILE = { href: "/sales/price-book", label: "Price Book", emoji: "📋" } as const;

// Combines what used to be five separate top-level tabs (Jobs, Quotes,
// Invoices, Clients, plus the Price Book reachable from Home) into one
// Sales tab with its own tile-grid landing screen, matching the Home
// screen's tile pattern. Calendar and Tasks stay as their own top-level
// tabs (see (tabs)/_layout.tsx) - only these five sales-related sections
// moved.
export default function SalesScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Text style={styles.title}>Sales</Text>
      <View style={styles.grid}>
        {TILES.map((tile) => (
          <Pressable key={tile.href} style={styles.tile} onPress={() => router.push(tile.href)}>
            <Text style={styles.tileEmoji}>{tile.emoji}</Text>
            <Text style={styles.tileLabel}>{tile.label}</Text>
          </Pressable>
        ))}
        {profile?.role === "admin" ? (
          <Pressable style={styles.tile} onPress={() => router.push(PRICE_BOOK_TILE.href)}>
            <Text style={styles.tileEmoji}>{PRICE_BOOK_TILE.emoji}</Text>
            <Text style={styles.tileLabel}>{PRICE_BOOK_TILE.label}</Text>
          </Pressable>
        ) : null}
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
  tileLabel: { fontSize: 16, fontWeight: "700", color: "#111827" },
});

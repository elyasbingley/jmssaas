import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { useRouter, usePathname } from "expo-router";

const LINKS = [
  { href: "/clients", label: "Clients" },
  { href: "/tasks", label: "Tasks" },
  { href: "/quotes", label: "Quotes" },
  { href: "/invoices", label: "Invoices" },
  { href: "/calendar", label: "Calendar" },
] as const;

// Only global nav in the app - a light horizontal strip used on each
// section's list screen. Not a tab bar because job/quote/invoice/task
// detail screens push onto the same Stack from any of these sections.
export function AppNavBar() {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bar} contentContainerStyle={styles.content}>
      {LINKS.map((link) => {
        const active = pathname.startsWith(link.href);
        return (
          <Pressable
            key={link.href}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => router.push(link.href)}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{link.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#e5e7eb", flexGrow: 0 },
  content: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: "#f3f4f6" },
  chipActive: { backgroundColor: "#1d4ed8" },
  chipText: { color: "#374151", fontWeight: "600" },
  chipTextActive: { color: "#fff" },
});

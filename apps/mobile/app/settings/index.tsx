import { Pressable, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../lib/auth-context";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

// Narrowed down to just the small config/preference screens (see the More
// screen restructure) - Team/Staff, Automation & Messaging, Real Estate &
// Strata, Forms & Certificates, Subcontractors, B2B & Referrals and Inbox
// all moved out to be direct buttons on the More screen instead, one tap
// closer than nesting them under Settings.
interface SettingsTile {
  href: Href;
  label: string;
  emoji: string;
  adminOnly?: boolean;
}

const ITEMS: SettingsTile[] = [
  { href: "/dashboard-settings", label: "Dashboard", emoji: "📊" },
  { href: "/google-calendar-settings", label: "Google Calendar", emoji: "📅" },
  { href: "/company-settings", label: "Company Details", emoji: "🏢", adminOnly: true },
  { href: "/job-setup", label: "Job Card Setup", emoji: "🛠️", adminOnly: true },
  { href: "/inventory-setup", label: "Inventory Setup", emoji: "📦", adminOnly: true },
];

export default function SettingsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  const visibleItems = ITEMS.filter((item) => !item.adminOnly || isAdmin);

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Settings</Text>
        </View>

        <View style={styles.grid}>
          {visibleItems.map((item) => (
            <Pressable key={item.label} style={styles.tile} onPress={() => router.push(item.href)}>
              <Text style={styles.tileEmoji}>{item.emoji}</Text>
              <Text style={styles.tileLabel}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
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
    grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, padding: 12, gap: 12 },
    tile: {
      width: "46%" as const,
      aspectRatio: 1.3,
      backgroundColor: tokens.surface,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 4,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 8,
      boxShadow: `0 0 10px ${tokens.accentGlow}`,
    },
    tileEmoji: { fontSize: 32 },
    tileLabel: {
      fontSize: font.body,
      fontWeight: "700" as const,
      color: tokens.textPrimary,
      textAlign: "center" as const,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      ...mono,
    },
  };
}

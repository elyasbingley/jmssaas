import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../lib/auth-context";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { Panel } from "../../../components/theme/Panel";

// The More tab - everything that isn't Home/Jobs/Notifications lives here
// now (see the tab bar restructure). "Settings" holds only the small,
// personal/company config screens (Dashboard, Google Calendar, Company
// Details, Job Card Setup, Inventory Setup - see settings/index.tsx);
// everything else that used to be admin-only Settings tiles is a direct
// button here instead, one tap closer than before.
interface MenuItem {
  href: Href;
  label: string;
  adminOnly?: boolean;
}

const MODULES: MenuItem[] = [
  { href: "/b2b-referrals", label: "B2B & Referrals", adminOnly: true },
  { href: "/subcontractors", label: "Subcontractors", adminOnly: true },
  { href: "/real-estate", label: "Real Estate & Strata", adminOnly: true },
  { href: "/automation-settings", label: "Automation & Messaging", adminOnly: true },
  { href: "/reports", label: "Forms & Certificates", adminOnly: true },
  { href: "/team", label: "Team/Staff", adminOnly: true },
  { href: "/sales/inventory", label: "Inventory" },
  { href: "/sales/price-book", label: "Price Book" },
  { href: "/sales/clients", label: "Clients" },
  { href: "/more/quotes-invoices", label: "Quotes & Invoices" },
  { href: "/channels", label: "Channels" },
];

// Not explicitly called out in the latest tab bar spec, but nothing built
// this session should quietly lose its only way in - kept here rather than
// deleted. Flag with the user if any of these should actually move or go.
const OTHER: MenuItem[] = [
  { href: "/schedule", label: "Schedule / Dispatch", adminOnly: true },
  { href: "/inbox", label: "Inbox", adminOnly: true },
  { href: "/knowledge", label: "Knowledge Base" },
  { href: "/ui-settings", label: "UI Settings" },
];

function MenuRow({ item, styles, onPress }: { item: MenuItem; styles: ReturnType<typeof createStyles>; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Text style={styles.rowLabel}>{item.label}</Text>
      <Text style={styles.rowChevron}>›</Text>
    </Pressable>
  );
}

export default function MoreScreen() {
  const router = useRouter();
  const { profile, signOut } = useAuth();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  const visibleModules = MODULES.filter((item) => !item.adminOnly || isAdmin);
  const visibleOther = OTHER.filter((item) => !item.adminOnly || isAdmin);

  const confirmSignOut = () => {
    Alert.alert("Sign out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => signOut() },
    ]);
  };

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>More</Text>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
          <Panel title="Settings">
            <MenuRow item={{ href: "/settings", label: "Settings" }} styles={styles} onPress={() => router.push("/settings")} />
          </Panel>

          <Panel title="Modules">
            {visibleModules.map((item, i) => (
              <View key={item.label}>
                <MenuRow item={item} styles={styles} onPress={() => router.push(item.href)} />
                {i < visibleModules.length - 1 ? <View style={styles.divider} /> : null}
              </View>
            ))}
          </Panel>

          {visibleOther.length ? (
            <Panel title="Other">
              {visibleOther.map((item, i) => (
                <View key={item.label}>
                  <MenuRow item={item} styles={styles} onPress={() => router.push(item.href)} />
                  {i < visibleOther.length - 1 ? <View style={styles.divider} /> : null}
                </View>
              ))}
            </Panel>
          ) : null}

          <Pressable style={styles.signOutButton} onPress={confirmSignOut}>
            <Text style={styles.signOutText}>Sign Out</Text>
          </Pressable>
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
    row: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, paddingVertical: 12 },
    rowLabel: { fontSize: font.body, color: tokens.textPrimary, ...mono },
    rowChevron: { fontSize: font.body + 2, color: tokens.accent },
    divider: { height: 1, backgroundColor: tokens.border },
    signOutButton: {
      marginHorizontal: 12,
      marginTop: 20,
      borderWidth: 1,
      borderColor: tokens.danger,
      borderRadius: 3,
      paddingVertical: 12,
      alignItems: "center" as const,
    },
    signOutText: { color: tokens.danger, fontWeight: "700" as const, letterSpacing: 1.5, textTransform: "uppercase" as const, ...mono },
  };
}

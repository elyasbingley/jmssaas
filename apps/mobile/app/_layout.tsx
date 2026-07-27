import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { PowerSyncContext } from "@powersync/react";
import { powersync } from "../lib/powersync";
import { AuthProvider, useAuth } from "../lib/auth-context";

export default function RootLayout() {
  return (
    <PowerSyncContext.Provider value={powersync}>
      <AuthProvider>
        <SafeAreaProvider>
          <StatusBar style="dark" />
          <RootNavigator />
        </SafeAreaProvider>
      </AuthProvider>
    </PowerSyncContext.Provider>
  );
}

function RootNavigator() {
  const { session, isLoading, isWaitingForFirstSync } = useAuth();
  const segments = useSegments() as string[];
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    const inAuthGroup = segments[0] === "login";
    if (!session && !inAuthGroup) {
      router.replace("/login");
    } else if (session && (inAuthGroup || segments.length === 0)) {
      router.replace("/");
    }
  }, [session, isLoading, segments, router]);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  // Signed in, but this device hasn't finished its one-time initial sync
  // yet and has no local profile row - render a clear waiting state rather
  // than a Stack that looks ready but silently no-ops every write.
  if (session && isWaitingForFirstSync) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={styles.title}>Setting up your account</Text>
        <Text style={styles.body}>
          This device needs a connection the first time you sign in, to download your client and job data. Once
          that finishes, everything works offline.
        </Text>
      </View>
    );
  }

  // Outside the tab bar entirely: the (tabs) group (its own Tabs
  // navigator, each tab wrapping its own native Stack - see
  // app/(tabs)/_layout.tsx), login, and a couple of standalone admin
  // screens (company-settings, schedule, team, job-setup) - see
  // docs/SETUP.md for why Schedule/dispatch was placed this way instead of
  // a new tab. company-settings/team/job-setup are now reached from the
  // Settings tab's list (see (tabs)/settings/index.tsx) rather than a
  // header link on Home - the route names/files are unchanged, only the
  // header titles below were renamed to match that list's labels (Company
  // Details/Team-Staff/Job Card Setup).
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="company-settings" options={{ headerShown: true, title: "Company Details" }} />
      <Stack.Screen name="schedule" options={{ headerShown: true, title: "Schedule" }} />
      <Stack.Screen name="team" options={{ headerShown: true, title: "Team/Staff" }} />
      <Stack.Screen name="job-setup" options={{ headerShown: true, title: "Job Card Setup" }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 10 },
  title: { fontSize: 17, fontWeight: "700", marginTop: 4 },
  body: { textAlign: "center", color: "#6b7280" },
});

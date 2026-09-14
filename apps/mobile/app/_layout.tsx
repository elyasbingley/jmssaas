import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { PowerSyncContext } from "@powersync/react";
import { powersync } from "../lib/powersync";
import { AuthProvider, useAuth } from "../lib/auth-context";
import { ThemeProvider } from "../lib/theme-context";

export default function RootLayout() {
  return (
    <PowerSyncContext.Provider value={powersync}>
      <AuthProvider>
        <ThemeProvider>
          <SafeAreaProvider>
            <StatusBar style="dark" />
            <RootNavigator />
          </SafeAreaProvider>
        </ThemeProvider>
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
  // navigator - just Home/Jobs/Notifications/More now, see
  // app/(tabs)/_layout.tsx), login, and every other section - each with
  // its own nested Stack/header, reached via a Home icon, a More button,
  // or drilling into a job/client/etc, not its own tab.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="company-settings" options={{ headerShown: false }} />
      <Stack.Screen name="dashboard-settings" options={{ headerShown: false }} />
      <Stack.Screen name="schedule" options={{ headerShown: false }} />
      <Stack.Screen name="team" options={{ headerShown: false }} />
      <Stack.Screen name="job-setup" options={{ headerShown: false }} />
      <Stack.Screen name="inventory-setup" options={{ headerShown: false }} />
      <Stack.Screen name="automation-settings" options={{ headerShown: false }} />
      <Stack.Screen name="ui-settings" options={{ headerShown: false }} />
      <Stack.Screen name="google-calendar-settings" options={{ headerShown: false }} />
      <Stack.Screen name="real-estate" />
      <Stack.Screen name="reports" />
      <Stack.Screen name="subcontractors" />
      <Stack.Screen name="b2b-referrals" />
      <Stack.Screen name="knowledge" />
      <Stack.Screen name="inbox" />
      <Stack.Screen name="channels" />
      <Stack.Screen name="tasks" />
      <Stack.Screen name="calendar" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="sales" />
    </Stack>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 10 },
  title: { fontSize: 17, fontWeight: "700", marginTop: 4 },
  body: { textAlign: "center", color: "#6b7280" },
});

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
      router.replace("/clients");
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

  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="clients/index" options={{ title: "Clients" }} />
      <Stack.Screen name="clients/[id]" options={{ title: "Client" }} />
      <Stack.Screen name="jobs/[id]" options={{ title: "Job card" }} />
      <Stack.Screen name="tasks/index" options={{ title: "Tasks" }} />
      <Stack.Screen name="tasks/[id]" options={{ title: "Task" }} />
      <Stack.Screen name="quotes/index" options={{ title: "Quotes" }} />
      <Stack.Screen name="quotes/new" options={{ title: "New quote" }} />
      <Stack.Screen name="quotes/[id]" options={{ title: "Quote" }} />
      <Stack.Screen name="invoices/index" options={{ title: "Invoices" }} />
      <Stack.Screen name="invoices/new" options={{ title: "New invoice" }} />
      <Stack.Screen name="invoices/[id]" options={{ title: "Invoice" }} />
      <Stack.Screen name="calendar/index" options={{ title: "Calendar" }} />
      <Stack.Screen name="calendar/new" options={{ title: "New event" }} />
      <Stack.Screen name="calendar/[id]" options={{ title: "Event" }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 10 },
  title: { fontSize: 17, fontWeight: "700", marginTop: 4 },
  body: { textAlign: "center", color: "#6b7280" },
});

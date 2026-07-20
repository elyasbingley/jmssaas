import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
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
  const { session, isLoading } = useAuth();
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
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="clients/index" options={{ title: "Clients" }} />
      <Stack.Screen name="clients/[id]" options={{ title: "Client" }} />
      <Stack.Screen name="jobs/[id]" options={{ title: "Job card" }} />
    </Stack>
  );
}

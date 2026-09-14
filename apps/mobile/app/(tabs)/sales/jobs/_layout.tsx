import { Stack } from "expo-router";

export default function JobsLayout() {
  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="index" options={{ title: "Jobs" }} />
      <Stack.Screen name="[id]" options={{ headerShown: false }} />
      <Stack.Screen name="diary" options={{ headerShown: false }} />
      <Stack.Screen name="billing" options={{ headerShown: false }} />
    </Stack>
  );
}

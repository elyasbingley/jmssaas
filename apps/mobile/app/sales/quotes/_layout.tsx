import { Stack } from "expo-router";

export default function QuotesLayout() {
  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="index" options={{ title: "Quotes" }} />
      <Stack.Screen name="new" options={{ title: "New quote" }} />
      <Stack.Screen name="[id]" options={{ title: "Quote" }} />
    </Stack>
  );
}

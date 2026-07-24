import { Stack } from "expo-router";

export default function InvoicesLayout() {
  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="index" options={{ title: "Invoices" }} />
      <Stack.Screen name="new" options={{ title: "New invoice" }} />
      <Stack.Screen name="[id]" options={{ title: "Invoice" }} />
    </Stack>
  );
}

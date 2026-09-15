import { Stack } from "expo-router";

// No longer a tab or its own landing screen (see the Home/Jobs/
// Notifications/More tab bar restructure) - Quotes, Invoices, Clients,
// Price Book and Inventory are each reached directly from the More screen
// now (a "Quotes & Invoices" entry there picks between the first two).
// Job Cards moved out entirely to their own top-level (tabs)/jobs stack.
// This Stack just hosts what's left, unchanged internally.
export default function SalesLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="quotes" />
      <Stack.Screen name="invoices" />
      <Stack.Screen name="clients" />
      <Stack.Screen name="price-book" />
      <Stack.Screen name="inventory" />
    </Stack>
  );
}

import { Stack } from "expo-router";

// Sales combines Quotes, Invoices, Price Book, Clients, and Job Cards into
// one tab (Calendar and Tasks stay as their own separate top-level tabs -
// see (tabs)/_layout.tsx). This Stack hosts the Sales tile grid (index) plus
// each sub-section's own nested Stack (quotes/_layout.tsx etc, unchanged
// internally - only their location moved from directly under (tabs)/ to
// under (tabs)/sales/).
export default function SalesLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="quotes" />
      <Stack.Screen name="invoices" />
      <Stack.Screen name="clients" />
      <Stack.Screen name="jobs" />
      <Stack.Screen name="price-book" />
      <Stack.Screen name="inventory" />
    </Stack>
  );
}

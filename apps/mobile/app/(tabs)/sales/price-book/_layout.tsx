import { Stack } from "expo-router";

// Nested under (tabs)/sales/ - one of the five sub-sections in the Sales
// tab's tile grid (see sales/index.tsx), alongside Quotes/Invoices/Clients/
// Job Cards. Originally built as its own top-level Stack outside the tabs
// group before this restructure; moving the folder here was a pure location
// change; this Stack's own screens/behavior are unchanged.
export default function PriceBookLayout() {
  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="index" options={{ title: "Price Book" }} />
      <Stack.Screen name="categories/[id]" options={{ title: "Category" }} />
      <Stack.Screen name="items/new" options={{ title: "New item" }} />
      <Stack.Screen name="items/[id]" options={{ title: "Item" }} />
    </Stack>
  );
}

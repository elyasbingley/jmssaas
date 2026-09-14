import { Stack } from "expo-router";

// Nested under (tabs)/sales/ - a sixth tile in the Sales tile grid (see
// sales/index.tsx), alongside Quotes/Invoices/Clients/Job Cards/Price Book.
// Single-screen section (no drill-in routes) - location/category
// switching and the Low-Stock queue are all tabs/filters within index.tsx
// rather than separate screens, matching the Job Costing tab pattern on
// the job detail screen.
export default function InventoryLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}

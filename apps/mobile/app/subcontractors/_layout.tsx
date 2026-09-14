import { Stack } from "expo-router";

export default function SubcontractorsLayout() {
  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="index" options={{ title: "Subcontractors" }} />
      <Stack.Screen name="[id]" options={{ title: "Subcontractor" }} />
      <Stack.Screen name="purchase-order/new" options={{ title: "New Order" }} />
      <Stack.Screen name="purchase-order/[id]" options={{ title: "Purchase Order" }} />
    </Stack>
  );
}

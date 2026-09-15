import { Stack } from "expo-router";

export default function SubcontractorsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[id]" />
      <Stack.Screen name="purchase-order/new" />
      <Stack.Screen name="purchase-order/[id]" />
    </Stack>
  );
}

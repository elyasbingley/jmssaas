import { Stack } from "expo-router";

export default function ReportsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="template/[id]" />
      <Stack.Screen name="instance/[id]" />
    </Stack>
  );
}

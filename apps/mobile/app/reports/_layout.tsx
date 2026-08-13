import { Stack } from "expo-router";

export default function ReportsLayout() {
  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="index" options={{ title: "Reports" }} />
      <Stack.Screen name="template/[id]" options={{ title: "Report Template" }} />
      <Stack.Screen name="instance/[id]" options={{ title: "Report" }} />
    </Stack>
  );
}

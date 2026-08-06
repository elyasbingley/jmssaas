import { Stack } from "expo-router";

export default function JobsLayout() {
  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="index" options={{ title: "Jobs" }} />
      <Stack.Screen name="[id]" options={{ title: "Job" }} />
      <Stack.Screen name="measure" options={{ title: "Measure Roof" }} />
    </Stack>
  );
}

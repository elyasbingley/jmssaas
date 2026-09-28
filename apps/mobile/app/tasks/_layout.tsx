import { Stack } from "expo-router";

export default function TasksLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="index" options={{ title: "Tasks" }} />
      <Stack.Screen name="[id]" options={{ title: "Task" }} />
      <Stack.Screen name="matrix" options={{ title: "Matrix" }} />
      <Stack.Screen name="matrix-quadrant" options={{ title: "Quadrant" }} />
      <Stack.Screen name="triage" options={{ title: "Quick Triage" }} />
    </Stack>
  );
}

import { Stack } from "expo-router";

export default function CalendarLayout() {
  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="index" options={{ title: "Calendar" }} />
      <Stack.Screen name="new" options={{ title: "New event" }} />
      <Stack.Screen name="[id]" options={{ title: "Event" }} />
    </Stack>
  );
}

import { Stack } from "expo-router";

export default function InboxLayout() {
  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="index" options={{ title: "Inbox" }} />
      <Stack.Screen name="[id]" options={{ title: "Message" }} />
    </Stack>
  );
}

import { Stack } from "expo-router";

export default function NotesLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="notebooks/[id]" />
      <Stack.Screen name="tags" />
      <Stack.Screen name="[id]" />
    </Stack>
  );
}

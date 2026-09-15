import { Stack } from "expo-router";

export default function KnowledgeLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="categories/[id]" />
      <Stack.Screen name="articles/[id]" />
    </Stack>
  );
}

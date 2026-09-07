import { Stack } from "expo-router";

export default function KnowledgeLayout() {
  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="index" options={{ title: "Knowledge" }} />
      <Stack.Screen name="categories/[id]" options={{ title: "Knowledge" }} />
      <Stack.Screen name="articles/[id]" options={{ title: "Article" }} />
    </Stack>
  );
}

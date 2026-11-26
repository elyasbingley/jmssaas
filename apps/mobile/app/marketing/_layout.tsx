import { Stack } from "expo-router";

export default function MarketingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="google-posts" />
      <Stack.Screen name="blog-posts" />
    </Stack>
  );
}

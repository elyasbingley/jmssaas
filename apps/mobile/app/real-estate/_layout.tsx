import { Stack } from "expo-router";

export default function RealEstateLayout() {
  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="index" options={{ title: "Real Estate & Strata" }} />
      <Stack.Screen name="[id]" options={{ title: "Property" }} />
    </Stack>
  );
}

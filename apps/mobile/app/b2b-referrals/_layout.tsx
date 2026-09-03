import { Stack } from "expo-router";

export default function B2BReferralsLayout() {
  return (
    <Stack screenOptions={{ headerTitleStyle: { fontWeight: "600" } }}>
      <Stack.Screen name="index" options={{ title: "B2B & Referrals" }} />
    </Stack>
  );
}

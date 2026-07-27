import { Stack } from "expo-router";

// New Settings tab (see (tabs)/_layout.tsx) - hosts the list screen only.
// The actual settings screens it links to (company-settings, team,
// job-setup) live outside the tabs group as their own standalone Stack
// screens (see app/_layout.tsx) and were already built that way before
// this tab existed - this list is just a new, discoverable entry point to
// them, not a relocation of the screens themselves.
export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}

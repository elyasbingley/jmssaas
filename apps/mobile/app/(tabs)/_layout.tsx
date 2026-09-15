import { Tabs } from "expo-router";
import { Text, type ColorValue } from "react-native";
import { useTheme } from "../../lib/theme-context";

// Bottom tab bar - just Home, Jobs, Notifications, More now. Every other
// section (Channels, Tasks, Calendar, Settings, Sales' old children) moved
// to top-level (non-tab) routes - see app/_layout.tsx - reached from a
// Home icon, a tile, or the More screen instead of its own tab. Each tab
// still wraps its own native Stack (see the _layout.tsx inside jobs/,
// notifications/, more/) for native stack transitions when drilling in.
function TabIcon({ emoji, color }: { emoji: string; color: ColorValue }) {
  return <Text style={{ fontSize: 20, color }}>{emoji}</Text>;
}

export default function TabsLayout() {
  const { tokens } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: tokens.accent,
        tabBarInactiveTintColor: tokens.textMuted,
        tabBarStyle: { backgroundColor: tokens.surface, borderTopColor: tokens.border },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Home", tabBarIcon: ({ color }) => <TabIcon emoji="🏠" color={color} /> }}
      />
      <Tabs.Screen
        name="jobs"
        options={{ title: "Jobs", tabBarIcon: ({ color }) => <TabIcon emoji="🛠️" color={color} /> }}
      />
      <Tabs.Screen
        name="notifications"
        options={{ title: "Notifications", tabBarIcon: ({ color }) => <TabIcon emoji="🔔" color={color} /> }}
      />
      <Tabs.Screen
        name="more"
        options={{ title: "More", tabBarIcon: ({ color }) => <TabIcon emoji="☰" color={color} /> }}
      />
    </Tabs>
  );
}

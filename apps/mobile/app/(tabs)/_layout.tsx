import { Tabs } from "expo-router";
import { Text, type ColorValue } from "react-native";
import { useTheme } from "../../lib/theme-context";
import { useUnreadNotificationCount } from "../../lib/use-notifications";

// Bottom tab bar - just Home, Jobs, Notifications, More now. Every other
// section (Channels, Tasks, Calendar, Settings, Sales' old children) moved
// to top-level (non-tab) routes - see app/_layout.tsx - reached from a
// Home icon, a tile, or the More screen instead of its own tab. Each tab
// still wraps its own native Stack (see the _layout.tsx inside jobs/,
// notifications/, more/) for native stack transitions when drilling in.
// The bits of the tab navigator's state the Jobs tab listener reads.
type TabRoute = { key: string; name: string; params?: object; state?: { routes: { name: string }[] } };

function TabIcon({ emoji, color }: { emoji: string; color: ColorValue }) {
  return <Text style={{ fontSize: 20, color }}>{emoji}</Text>;
}

export default function TabsLayout() {
  const { tokens } = useTheme();
  const unreadCount = useUnreadNotificationCount();
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
        listeners={({ navigation }) => ({
          // Tapping Jobs always shows the job list, even when the tab was
          // last left on a job card (or a job was opened from Home, so the
          // tab holds a card with no list underneath). Resetting the tab's
          // route without its nested state starts it fresh on the list.
          tabPress: (e) => {
            const state = navigation.getState() as { routes: TabRoute[] };
            const jobs = state.routes.find((r) => r.name === "jobs");
            const nested = jobs?.state;
            const onList = !nested || (nested.routes.length === 1 && nested.routes[0]?.name === "index");
            if (!jobs || onList) return;
            e.preventDefault();
            navigation.reset({
              index: state.routes.indexOf(jobs),
              routes: state.routes.map((r) => (r === jobs ? { key: r.key, name: r.name, params: r.params } : r)),
            });
          },
        })}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: "Notifications",
          tabBarIcon: ({ color }) => <TabIcon emoji="🔔" color={color} />,
          tabBarBadge: unreadCount > 0 ? unreadCount : undefined,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{ title: "More", tabBarIcon: ({ color }) => <TabIcon emoji="☰" color={color} /> }}
      />
    </Tabs>
  );
}

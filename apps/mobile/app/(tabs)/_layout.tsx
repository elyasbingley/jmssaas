import { Tabs } from "expo-router";
import { Text } from "react-native";

// Bottom tab bar for the app's top-level sections: Home, Sales, Tasks,
// Calendar. Previously Jobs/Quotes/Invoices/Clients were each their own
// tab; this pass combines those four plus Price Book into a single Sales
// tab with its own tile-grid landing screen (see sales/index.tsx) - Tasks
// and Calendar weren't part of that combination and stay as separate tabs.
// A fifth tab slot is deliberately left available in the bar for a future
// Settings tab (not built yet - see docs/SETUP.md known-gaps).
// Each tab wraps its own native Stack (see the _layout.tsx inside each
// folder) so drilling into a section uses a real native stack transition
// instead of the app's original flat Stack, which felt like a web page
// navigation (slow, with a generic back arrow) rather than a native app
// switching screens within a section.
function TabIcon({ emoji }: { emoji: string }) {
  return <Text style={{ fontSize: 20 }}>{emoji}</Text>;
}

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: "#1d4ed8" }}>
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: () => <TabIcon emoji="🏠" /> }} />
      <Tabs.Screen name="sales" options={{ title: "Sales", tabBarIcon: () => <TabIcon emoji="💼" /> }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks", tabBarIcon: () => <TabIcon emoji="✅" /> }} />
      <Tabs.Screen name="calendar" options={{ title: "Calendar", tabBarIcon: () => <TabIcon emoji="📅" /> }} />
    </Tabs>
  );
}

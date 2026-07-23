import { Tabs } from "expo-router";
import { Text } from "react-native";

// Bottom tab bar for the app's 7 top-level sections, in the order requested:
// Home, Jobs, Quotes, Invoices, Tasks, Clients, Calendar. Each tab (other
// than Home) wraps its own native Stack (see the _layout.tsx inside each
// folder) so drilling into a job/quote/invoice/task/event uses a real native
// stack transition instead of the app's previous flat Stack, which felt like
// a web page navigation (slow, with a generic back arrow) rather than a
// native app switching screens within a section.
function TabIcon({ emoji }: { emoji: string }) {
  return <Text style={{ fontSize: 20 }}>{emoji}</Text>;
}

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: "#1d4ed8" }}>
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: () => <TabIcon emoji="🏠" /> }} />
      <Tabs.Screen name="jobs" options={{ title: "Jobs", tabBarIcon: () => <TabIcon emoji="🛠️" /> }} />
      <Tabs.Screen name="quotes" options={{ title: "Quotes", tabBarIcon: () => <TabIcon emoji="📄" /> }} />
      <Tabs.Screen name="invoices" options={{ title: "Invoices", tabBarIcon: () => <TabIcon emoji="🧾" /> }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks", tabBarIcon: () => <TabIcon emoji="✅" /> }} />
      <Tabs.Screen name="clients" options={{ title: "Clients", tabBarIcon: () => <TabIcon emoji="👥" /> }} />
      <Tabs.Screen name="calendar" options={{ title: "Calendar", tabBarIcon: () => <TabIcon emoji="📅" /> }} />
    </Tabs>
  );
}

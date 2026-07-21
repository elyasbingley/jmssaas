import { StyleSheet, Text, View } from "react-native";

export function RequiresConnectionNotice({ label }: { label: string }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>No connection</Text>
      <Text style={styles.body}>
        {`This device is offline. ${label} are an office/PC workflow that needs a connection - reconnect to view or edit them.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  title: { fontSize: 17, fontWeight: "700" },
  body: { textAlign: "center", color: "#6b7280" },
});

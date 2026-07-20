import { ActivityIndicator, View } from "react-native";

// Immediately redirected by the auth guard in app/_layout.tsx once the
// session is known - this just covers the brief moment before that.
export default function Index() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator />
    </View>
  );
}

import { Linking } from "react-native";

// Opens a calendar event's location in Google Maps (or the device's default
// maps app via the same universal URL) - a plain web deep link rather than
// a native maps SDK, so it needs no extra native dependency or permission.
export function openInMaps(address: string): void {
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  Linking.openURL(url).catch(() => {});
}

import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { supabase } from "./supabase";
import { useAuth } from "./auth-context";

// Push notifications - registers this device's Expo push token against
// the signed-in profile (push_tokens, read by send-notification) and
// routes a tap on any notification to the Notifications tab (per the
// user's explicit ask - not a deep link into whatever the notification is
// about, just "take me to Notifications"; the Notifications screen itself
// is what routes on from there once you tap the specific row).
//
// Call this once near the app root, after a profile is known - see
// app/_layout.tsx. Expo Go can't receive push notifications at all on
// this SDK (needs a real EAS dev/preview build) and a simulator/emulator
// has no push capability either - both are silent no-ops here, not
// errors, so development on those isn't blocked.

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function registerPushToken(tenantId: string, profileId: string): Promise<void> {
  if (!Device.isDevice) return;

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") return;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  // Same place channels/new.tsx/app.config.js already read this from -
  // required by getExpoPushTokenAsync, and only present once the app's
  // been through `eas build`/`eas init` (see app.config.js's own comment).
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) {
    console.error("[use-push-notifications] No EAS projectId configured - can't request a push token");
    return;
  }

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  const platform = Platform.OS === "ios" ? "ios" : "android";

  const { error } = await supabase
    .from("push_tokens")
    .upsert({ tenant_id: tenantId, profile_id: profileId, token, platform }, { onConflict: "token" });
  if (error) console.error("[use-push-notifications] Failed to save push token", error);
}

export function usePushNotifications() {
  const { profile } = useAuth();
  const router = useRouter();
  const registeredForProfileId = useRef<string | null>(null);

  useEffect(() => {
    if (!profile || registeredForProfileId.current === profile.id) return;
    registeredForProfileId.current = profile.id;
    registerPushToken(profile.tenant_id, profile.id).catch((e) => console.error("[use-push-notifications] Registration failed", e));
  }, [profile]);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(() => {
      router.push("/notifications");
    });
    return () => subscription.remove();
  }, [router]);
}

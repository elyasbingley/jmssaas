import { useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { GoogleCalendarConnectionListItem, GoogleCalendarConnectionStatus } from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { useIsOnline } from "../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../lib/use-supabase-fetch";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { RequiresConnectionNotice } from "../components/RequiresConnectionNotice";

// Every profile connects their own Google account here (technician or
// admin) - not admin-gated, unlike the rest of (tabs)/settings/index.tsx's
// list. Same "open the OAuth flow in the device browser, refetch on focus
// to pick up the result" shape as company-settings.tsx's Xero connect -
// see that screen's own comment for why (the callback redirects to the
// desktop app's Settings page, not back into this native screen).
export default function GoogleCalendarSettingsScreen() {
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";

  const { data: status, refetch: refetchStatus } = useSupabaseFetch<GoogleCalendarConnectionStatus>(async () => {
    const { data, error } = await supabase.rpc("get_google_calendar_connection_status");
    if (error) throw error;
    return data as GoogleCalendarConnectionStatus;
  }, [profile?.tenant_id, isOnline]);
  useRefetchOnFocus(refetchStatus);

  const { data: connections, refetch: refetchConnections } = useSupabaseFetch<GoogleCalendarConnectionListItem[]>(async () => {
    if (!isAdmin) return [];
    const { data, error } = await supabase.rpc("list_google_calendar_connections");
    if (error) throw error;
    return (data as GoogleCalendarConnectionListItem[]) ?? [];
  }, [profile?.tenant_id, isOnline, isAdmin]);
  useRefetchOnFocus(refetchConnections);

  const [connecting, setConnecting] = useState(false);
  const [disconnectingProfileId, setDisconnectingProfileId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const connect = async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!supabaseUrl || !token) throw new Error("Not signed in");
      const res = await fetch(`${supabaseUrl}/functions/v1/google-oauth-start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const resBody = await res.json();
      if (!res.ok || resBody.error || !resBody.url) throw new Error(resBody.error || "Failed to start Google Calendar connection");
      await Linking.openURL(resBody.url as string);
    } catch (e) {
      setConnectError(getErrorMessage(e, "Failed to start Google Calendar connection"));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async (targetProfileId?: string) => {
    setDisconnectingProfileId(targetProfileId ?? profile?.id ?? "self");
    setConnectError(null);
    try {
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!supabaseUrl || !token) throw new Error("Not signed in");
      const res = await fetch(`${supabaseUrl}/functions/v1/google-calendar-disconnect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(targetProfileId ? { profileId: targetProfileId } : {}),
      });
      const resBody = await res.json();
      if (!res.ok || resBody.error) throw new Error(resBody.error || "Failed to disconnect Google Calendar");
      refetchStatus();
      refetchConnections();
    } catch (e) {
      setConnectError(getErrorMessage(e, "Failed to disconnect Google Calendar"));
    } finally {
      setDisconnectingProfileId(null);
    }
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Google Calendar settings" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <View style={styles.card}>
        {status?.connected ? (
          <>
            <View style={styles.rowBetween}>
              <Text style={styles.connectedText}>Connected as {status.email || "your Google account"}</Text>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>Connected</Text>
              </View>
            </View>
            {status.connected_at ? (
              <Text style={styles.meta}>Since {new Date(status.connected_at).toLocaleDateString("en-AU")}</Text>
            ) : null}
            <Pressable onPress={() => disconnect(undefined)} disabled={disconnectingProfileId !== null} style={{ marginTop: 10 }}>
              <Text style={styles.disconnectLink}>
                {disconnectingProfileId === (profile?.id ?? "self") ? "Disconnecting..." : "Disconnect Google Calendar"}
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.meta}>
              Connect your Google Calendar to sync jobs both ways - scheduled jobs show up on your phone, and any change you make
              there (or in the app) updates the other side automatically. Your own personal Google events show up here as "Busy"
              blocks so scheduling avoids clashes; only you can see their real details.
            </Text>
            <Pressable style={styles.connectButton} onPress={connect} disabled={connecting}>
              <Text style={styles.connectButtonText}>{connecting ? "Opening Google..." : "Connect Google Calendar"}</Text>
            </Pressable>
          </>
        )}
        {connectError ? <Text style={styles.error}>{connectError}</Text> : null}
      </View>

      {isAdmin && connections && connections.length > 0 ? (
        <View style={[styles.card, { marginTop: 12 }]}>
          <Text style={styles.sectionTitle}>Team Google Calendar connections</Text>
          {connections.map((c, i) => (
            <View key={c.profile_id} style={[styles.teamRow, i === 0 ? { borderTopWidth: 0 } : null]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.teamName}>{c.full_name || c.email}</Text>
                {c.google_account_email ? (
                  <Text style={styles.meta}>
                    Connected as {c.google_account_email}
                    {c.connected_at ? ` · since ${new Date(c.connected_at).toLocaleDateString("en-AU")}` : ""}
                  </Text>
                ) : (
                  <Text style={styles.metaMuted}>Not connected</Text>
                )}
              </View>
              {c.google_account_email ? (
                disconnectingProfileId === c.profile_id ? (
                  <ActivityIndicator />
                ) : (
                  <Pressable onPress={() => disconnect(c.profile_id)} disabled={disconnectingProfileId !== null}>
                    <Text style={styles.disconnectLink}>Disconnect</Text>
                  </Pressable>
                )
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  card: { backgroundColor: "#f9fafb", borderRadius: 8, padding: 14 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  connectedText: { fontSize: 14, fontWeight: "700", color: "#111827", flexShrink: 1 },
  badge: { backgroundColor: "#dcfce7", borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { color: "#15803d", fontSize: 11, fontWeight: "700" },
  meta: { fontSize: 13, color: "#6b7280", marginTop: 4 },
  metaMuted: { fontSize: 13, color: "#9ca3af", marginTop: 2 },
  error: { color: "#dc2626", marginTop: 12 },
  connectButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10, alignSelf: "flex-start", marginTop: 10 },
  connectButtonText: { color: "#fff", fontWeight: "700" },
  disconnectLink: { color: "#dc2626", fontWeight: "600" },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: "#6b7280", textTransform: "uppercase", marginBottom: 8 },
  teamRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#d1d5db",
  },
  teamName: { fontSize: 14, fontWeight: "600", color: "#111827" },
});

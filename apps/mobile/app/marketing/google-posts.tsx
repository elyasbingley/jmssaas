import { useEffect, useState } from "react";
import { Alert, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { GbpPost } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { useIsOnline } from "../../lib/connectivity";
import { getErrorMessage } from "../../lib/errors";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedButton } from "../../components/theme/ThemedButton";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";

// Marketing > Google Posts on the phone - where the "New Google post ready
// to review" notification lands. Approve (with any edits) or skip each
// draft, and see the last few posts. Settings stay on the desktop
// (Marketing > Google Posts > Settings). Admins only, online only (like
// the Inbox): posts aren't PowerSync tables.

const MAX_CAPTION = 1500;

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const body = await ctx.clone().json();
      if (body && typeof body.error === "string") return body.error;
    } catch {
      /* not JSON */
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function fmtWhen(iso: string | null) {
  return iso ? new Date(iso).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
}

export default function GooglePostsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

  const { data: posts, loading, error, refetch } = useSupabaseFetch<GbpPost[]>(async () => {
    if (!isOnline || !isAdmin) return [];
    const { data, error: e } = await supabase.from("gbp_posts").select("*").order("created_at", { ascending: false }).limit(30);
    if (e) throw e;
    return data as GbpPost[];
  }, [isOnline, isAdmin]);
  useRefetchOnFocus(refetch);

  const drafts = (posts ?? []).filter((p) => p.status === "draft");
  const history = (posts ?? []).filter((p) => p.status !== "draft").slice(0, 10);

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Google Posts</Text>
        </View>
        {!isAdmin ? (
          <Text style={styles.subtitle}>Only an admin can review Google posts.</Text>
        ) : !isOnline ? (
          <ThemedRequiresConnectionNotice label="Google Posts" />
        ) : (
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              <Text style={styles.subtitle}>
                Drafts written from job photos marked OK for marketing. Approve one (with any changes) and it goes to your Google profile.
              </Text>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Text style={styles.section}>Drafts{drafts.length ? ` (${drafts.length})` : ""}</Text>
              {!loading && drafts.length === 0 ? <Text style={styles.muted}>No drafts waiting.</Text> : null}
              {drafts.map((p) => (
                <DraftCard key={p.id} post={p} onDone={refetch} />
              ))}

              <Text style={[styles.section, { marginTop: 20 }]}>Recent</Text>
              {!loading && history.length === 0 ? <Text style={styles.muted}>Nothing posted yet.</Text> : null}
              {history.map((p) => (
                <HistoryRow key={p.id} post={p} onDone={refetch} />
              ))}
            </ScrollView>
          </KeyboardAvoidingView>
        )}
      </SafeAreaView>
    </>
  );
}

function DraftCard({ post, onDone }: { post: GbpPost; onDone: () => void }) {
  const styles = useThemedStyles(createStyles);
  const [summary, setSummary] = useState(post.summary);
  useEffect(() => setSummary(post.summary), [post.summary]);
  const [busy, setBusy] = useState(false);
  const tooLong = summary.length > MAX_CAPTION;

  const approve = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.functions.invoke("gbp-publish", {
        body: { post_id: post.id, summary: summary.trim() !== post.summary ? summary : undefined },
      });
      if (error) throw new Error(await functionErrorMessage(error, "Couldn't send the post"));
      Alert.alert("Sent to Google", "Zapier has the post. It shows on your profile in a few minutes.");
    } catch (e) {
      Alert.alert("Couldn't post it", getErrorMessage(e, "Something went wrong."));
    } finally {
      setBusy(false);
      onDone();
    }
  };
  const skip = () =>
    Alert.alert("Skip this post?", "The photo won't be suggested again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Skip",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          const { error } = await supabase.from("gbp_posts").update({ status: "skipped" }).eq("id", post.id);
          setBusy(false);
          if (error) Alert.alert("Couldn't skip it", error.message);
          onDone();
        },
      },
    ]);

  return (
    <View style={styles.card}>
      <Image source={{ uri: post.photo_url }} style={styles.photo} resizeMode="cover" />
      <Text style={styles.muted}>
        Drafted {fmtWhen(post.created_at)}
        {post.job_type ? ` · ${post.job_type}` : ""}
      </Text>
      {post.concerns.map((c, i) => (
        <Text key={i} style={styles.concern}>
          ⚠ {c}
        </Text>
      ))}
      <TextInput value={summary} onChangeText={setSummary} multiline style={styles.input} textAlignVertical="top" accessibilityLabel="Caption" />
      <Text style={[styles.muted, { textAlign: "right" }, tooLong && styles.errorText]}>
        {summary.length} / {MAX_CAPTION}
      </Text>
      <Text style={styles.muted}>
        Button: {post.cta_type === "CALL" ? "Call now" : "Learn more"}
        {post.cta_type === "LEARN_MORE" && post.cta_url ? ` → ${post.cta_url}` : ""}
      </Text>
      <View style={styles.actions}>
        <View style={{ flex: 1 }}>
          <ThemedButton label={busy ? "Working..." : post.concerns.length ? "Approve anyway" : "Approve and post"} onPress={approve} disabled={busy || tooLong || !summary.trim()} />
        </View>
        <View style={{ flex: 1 }}>
          <ThemedButton label="Skip" variant="secondary" onPress={skip} disabled={busy} />
        </View>
      </View>
    </View>
  );
}

function HistoryRow({ post, onDone }: { post: GbpPost; onDone: () => void }) {
  const styles = useThemedStyles(createStyles);
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.functions.invoke("gbp-publish", { body: { post_id: post.id } });
      if (error) throw new Error(await functionErrorMessage(error, "Couldn't send the post"));
    } catch (e) {
      Alert.alert("Couldn't post it", getErrorMessage(e, "Something went wrong."));
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <View style={styles.historyRow}>
      <Image source={{ uri: post.photo_url }} style={styles.thumb} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.status, post.status === "failed" && styles.errorText]}>
          {post.status.toUpperCase()} · {fmtWhen(post.published_at ?? post.created_at)}
        </Text>
        <Text style={styles.body} numberOfLines={2}>
          {post.summary}
        </Text>
        {post.status === "failed" && post.error ? <Text style={[styles.muted, styles.errorText]}>{post.error}</Text> : null}
        {post.status === "failed" || post.status === "approved" ? (
          <Pressable onPress={retry} disabled={busy} hitSlop={8}>
            <Text style={styles.link}>{busy ? "Sending..." : "Try again"}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    subtitle: { color: tokens.textMuted, paddingBottom: 8, fontSize: font.label, ...mono },
    content: { padding: 16, paddingBottom: 48 },
    section: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.label, letterSpacing: 1.5, textTransform: "uppercase" as const, marginBottom: 8, ...mono },
    muted: { color: tokens.textMuted, fontSize: font.label, ...mono },
    body: { color: tokens.textPrimary, fontSize: font.body, ...mono },
    error: { color: tokens.danger, fontSize: font.body, marginBottom: 8, ...mono },
    errorText: { color: tokens.danger },
    card: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, gap: 8, marginBottom: 16, backgroundColor: tokens.surface },
    photo: { width: "100%" as const, aspectRatio: 4 / 3, borderRadius: 3, backgroundColor: tokens.background },
    concern: { color: tokens.warning, fontSize: font.label, fontWeight: "700" as const, ...mono },
    input: {
      minHeight: 150,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 3,
      padding: 10,
      color: tokens.textPrimary,
      backgroundColor: tokens.background,
      fontSize: font.body,
      ...mono,
    },
    actions: { flexDirection: "row" as const, gap: 10 },
    historyRow: { flexDirection: "row" as const, gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: tokens.border },
    thumb: { width: 64, height: 64, borderRadius: 3, backgroundColor: tokens.surface },
    status: { color: tokens.accent, fontSize: font.label, fontWeight: "700" as const, ...mono },
  };
}

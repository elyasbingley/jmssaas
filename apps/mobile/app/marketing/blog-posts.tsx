import { useEffect, useState } from "react";
import { Alert, Image, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { BlogPost } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { useIsOnline } from "../../lib/connectivity";
import { getErrorMessage } from "../../lib/errors";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedButton } from "../../components/theme/ThemedButton";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";

// Marketing > Blog Posts on the phone - where the "New blog post ready to
// review" notification lands. Edit and approve (it's committed to the
// website and Vercel publishes it) or skip each draft, and see recent
// posts. Settings and "Write one now" stay on the desktop. Admins only,
// online only: posts aren't PowerSync tables.

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

export default function BlogPostsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

  const { data: posts, loading, error, refetch } = useSupabaseFetch<BlogPost[]>(async () => {
    if (!isOnline || !isAdmin) return [];
    const { data, error: e } = await supabase.from("blog_posts").select("*").order("created_at", { ascending: false }).limit(30);
    if (e) throw e;
    return data as BlogPost[];
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
          <Text style={styles.title}>Blog Posts</Text>
        </View>
        {!isAdmin ? (
          <Text style={styles.subtitle}>Only an admin can review blog posts.</Text>
        ) : !isOnline ? (
          <ThemedRequiresConnectionNotice label="Blog Posts" />
        ) : (
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              <Text style={styles.subtitle}>
                Website case studies written from finished jobs with marketing photos. Approve one and it's live on the website about a minute later.
              </Text>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Text style={styles.section}>Drafts{drafts.length ? ` (${drafts.length})` : ""}</Text>
              {!loading && drafts.length === 0 ? <Text style={styles.muted}>No drafts waiting.</Text> : null}
              {drafts.map((p) => (
                <DraftCard key={p.id} post={p} onDone={refetch} />
              ))}

              <Text style={[styles.section, { marginTop: 20 }]}>Recent</Text>
              {!loading && history.length === 0 ? <Text style={styles.muted}>Nothing published yet.</Text> : null}
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

function DraftCard({ post, onDone }: { post: BlogPost; onDone: () => void }) {
  const styles = useThemedStyles(createStyles);
  const [title, setTitle] = useState(post.title);
  const [description, setDescription] = useState(post.description);
  const [text, setText] = useState(post.body);
  useEffect(() => {
    setTitle(post.title);
    setDescription(post.description);
    setText(post.body);
  }, [post.title, post.description, post.body]);
  const [busy, setBusy] = useState(false);
  const invalid = !title.trim() || !description.trim() || !text.trim() || title.length > 140 || description.length > 320;

  const approve = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.functions.invoke("blog-publish", {
        body: {
          post_id: post.id,
          title: title !== post.title ? title : undefined,
          description: description !== post.description ? description : undefined,
          body: text !== post.body ? text : undefined,
        },
      });
      if (error) throw new Error(await functionErrorMessage(error, "Couldn't publish the post"));
      Alert.alert("Published", "The post is on its way to the website. It's live in about a minute.");
    } catch (e) {
      Alert.alert("Couldn't publish it", getErrorMessage(e, "Something went wrong."));
    } finally {
      setBusy(false);
      onDone();
    }
  };
  const skip = () =>
    Alert.alert("Skip this post?", "This job won't be suggested again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Skip",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          const { error } = await supabase.from("blog_posts").update({ status: "skipped" }).eq("id", post.id);
          setBusy(false);
          if (error) Alert.alert("Couldn't skip it", error.message);
          onDone();
        },
      },
    ]);

  return (
    <View style={styles.card}>
      {post.photos[0] ? <Image source={{ uri: post.photos[0].url }} style={styles.photo} resizeMode="cover" /> : null}
      {post.photos.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {post.photos.slice(1).map((p, i) => (
            <Image key={i} source={{ uri: p.url }} style={styles.thumb} />
          ))}
        </ScrollView>
      ) : null}
      <Text style={styles.muted}>
        Drafted {fmtWhen(post.created_at)}
        {post.job_type ? ` · ${post.job_type}` : ""}
        {post.suburb ? ` · ${post.suburb}` : ""}
      </Text>
      {post.concerns.map((c, i) => (
        <Text key={i} style={styles.concern}>
          ⚠ {c}
        </Text>
      ))}
      <Text style={styles.label}>Title</Text>
      <TextInput value={title} onChangeText={setTitle} style={[styles.input, { minHeight: 0, fontWeight: "700" }]} accessibilityLabel="Title" />
      <Text style={styles.label}>Google snippet · {description.length} / 155</Text>
      <TextInput value={description} onChangeText={setDescription} multiline style={[styles.input, { minHeight: 70 }]} textAlignVertical="top" accessibilityLabel="Google snippet" />
      <Text style={styles.label}>Post</Text>
      <TextInput value={text} onChangeText={setText} multiline style={[styles.input, { minHeight: 280 }]} textAlignVertical="top" accessibilityLabel="Post" />
      <Text style={styles.muted}>## heading · - list item · **bold** · [[photo:2]] places photo 2</Text>
      <View style={styles.actions}>
        <View style={{ flex: 1 }}>
          <ThemedButton label={busy ? "Working..." : post.concerns.length ? "Approve anyway" : "Approve and publish"} onPress={approve} disabled={busy || invalid} />
        </View>
        <View style={{ flex: 1 }}>
          <ThemedButton label="Skip" variant="secondary" onPress={skip} disabled={busy} />
        </View>
      </View>
    </View>
  );
}

function HistoryRow({ post, onDone }: { post: BlogPost; onDone: () => void }) {
  const styles = useThemedStyles(createStyles);
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.functions.invoke("blog-publish", { body: { post_id: post.id } });
      if (error) throw new Error(await functionErrorMessage(error, "Couldn't publish the post"));
    } catch (e) {
      Alert.alert("Couldn't publish it", getErrorMessage(e, "Something went wrong."));
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <View style={styles.historyRow}>
      {post.photos[0] ? <Image source={{ uri: post.photos[0].url }} style={styles.thumb} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={[styles.status, post.status === "failed" && styles.errorText]}>
          {post.status.toUpperCase()} · {fmtWhen(post.published_at ?? post.created_at)}
        </Text>
        <Text style={styles.body} numberOfLines={2}>
          {post.title}
        </Text>
        {post.status === "failed" && post.error ? <Text style={[styles.muted, styles.errorText]}>{post.error}</Text> : null}
        {post.status === "published" && post.published_url ? (
          <Pressable onPress={() => void Linking.openURL(post.published_url!)} hitSlop={8}>
            <Text style={styles.link}>View on the website ↗</Text>
          </Pressable>
        ) : null}
        {post.status === "failed" || post.status === "approved" ? (
          <Pressable onPress={() => void retry()} disabled={busy} hitSlop={8}>
            <Text style={styles.link}>{busy ? "Publishing..." : "Try again"}</Text>
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
    label: { color: tokens.textMuted, fontSize: font.label, textTransform: "uppercase" as const, letterSpacing: 1, marginTop: 4, ...mono },
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

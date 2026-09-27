import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNotesByTag } from "../../lib/use-notes";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { Panel } from "../../components/theme/Panel";

// A plain screen (not a `[name]` dynamic segment) because Obsidian-style
// tag names can contain `/` (see the notes_module migration's TAG_REGEX,
// e.g. "project/roofing"), which a literal path segment can't hold without
// a catch-all route - a query param sidesteps that entirely.
export default function NotesByTagScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const notes = useNotesByTag(name);

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>{"‹"} Back</Text>
          </Pressable>
          <Text style={styles.title}>#{name}</Text>
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          <Panel title="Tagged Notes" status={`${notes.length}`}>
            {notes.length === 0 ? (
              <Text style={styles.empty}>No notes with this tag yet.</Text>
            ) : (
              notes.map((note) => (
                <Pressable key={note.id} style={styles.row} onPress={() => router.push(`/notes/${note.id}`)}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {note.title}
                  </Text>
                  <Text style={styles.chevron}>{"›"}</Text>
                </Pressable>
              ))
            )}
          </Panel>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    empty: { color: tokens.textMuted, fontSize: font.body - 1, padding: 4, ...mono },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
      gap: 8,
    },
    rowTitle: { color: tokens.textPrimary, fontWeight: "600" as const, fontSize: font.body - 1, flex: 1, ...mono },
    chevron: { color: tokens.accent, fontSize: font.body + 2 },
  };
}

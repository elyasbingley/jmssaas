import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNotebook, useNotebooks, useNoteActions, useNotesInNotebook } from "../../../lib/use-notes";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { CreateNoteModal } from "../../../components/notes/CreateNoteModal";
import { ThemedModal } from "../../../components/theme/ThemedModal";
import { ThemedFormField } from "../../../components/theme/ThemedFormField";
import { ThemedButton } from "../../../components/theme/ThemedButton";
import { Panel } from "../../../components/theme/Panel";

// Notes-inside-a-notebook screen - same "header + Panel list" shape as
// apps/mobile/app/knowledge/categories/[id].tsx, adapted for offline
// PowerSync reads instead of a Supabase-direct fetch (Notes is
// offline-capable on mobile; Knowledge deliberately isn't - see that
// module's own screens for the online-only version of this pattern).
export default function NotebookScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const notebook = useNotebook(id);
  const notebooks = useNotebooks();
  const notes = useNotesInNotebook(id ?? null);
  const { createNotebook } = useNoteActions();

  const subNotebooks = notebooks.filter((n) => n.parent_id === id);

  const [createNoteVisible, setCreateNoteVisible] = useState(false);
  const [createSubVisible, setCreateSubVisible] = useState(false);
  const [subName, setSubName] = useState("");

  const handleCreateSub = async () => {
    if (!subName.trim() || !id) return;
    await createNotebook({ name: subName.trim(), parentId: id });
    setSubName("");
    setCreateSubVisible(false);
  };

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>{"‹"} Back</Text>
          </Pressable>
          <View style={styles.headerRow}>
            <Text style={styles.title} numberOfLines={1}>
              {notebook?.name ?? "Notebook"}
            </Text>
            <Pressable style={styles.newButton} onPress={() => setCreateNoteVisible(true)}>
              <Text style={styles.newButtonText}>+ New Note</Text>
            </Pressable>
          </View>
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          {subNotebooks.length > 0 ? (
            <Panel title="Sub-notebooks">
              {subNotebooks.map((sub) => (
                <Pressable key={sub.id} style={styles.row} onPress={() => router.push(`/notes/notebooks/${sub.id}`)}>
                  <Text style={styles.rowTitle}>{"\u{1F4D3} " + sub.name}</Text>
                  <Text style={styles.chevron}>{"›"}</Text>
                </Pressable>
              ))}
            </Panel>
          ) : null}

          <Panel
            title={`Notes (${notes.length})`}
            right={
              <Pressable onPress={() => setCreateSubVisible(true)}>
                <Text style={styles.addLink}>+ Sub-notebook</Text>
              </Pressable>
            }
          >
            {notes.length === 0 ? (
              <Text style={styles.empty}>No notes in this notebook yet.</Text>
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

      <CreateNoteModal
        visible={createNoteVisible}
        onClose={() => setCreateNoteVisible(false)}
        onCreated={(noteId) => router.push(`/notes/${noteId}`)}
        defaultNotebookId={id ?? null}
      />

      <ThemedModal visible={createSubVisible} onClose={() => setCreateSubVisible(false)}>
        <Text style={styles.modalTitle}>New Sub-notebook</Text>
        <ThemedFormField label="Name" value={subName} onChangeText={setSubName} placeholder="e.g. 2026 Jobs" autoFocus />
        <View style={styles.modalActions}>
          <ThemedButton label="Cancel" variant="secondary" onPress={() => setCreateSubVisible(false)} />
          <ThemedButton label="Create" onPress={handleCreateSub} disabled={!subName.trim()} />
        </View>
      </ThemedModal>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    headerRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 8 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, flex: 1, ...mono },
    newButton: { borderWidth: 1, borderColor: tokens.accent, borderRadius: 3, paddingVertical: 6, paddingHorizontal: 10 },
    newButtonText: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.label, textTransform: "uppercase" as const, ...mono },
    addLink: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.label, ...mono },
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
    modalTitle: { color: tokens.accent, fontSize: font.title, fontWeight: "700" as const, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    modalActions: { flexDirection: "row" as const, gap: 10, marginTop: 4 },
  };
}

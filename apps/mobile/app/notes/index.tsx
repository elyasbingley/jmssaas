import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  buildNotebookTree,
  useAllNotes,
  useAllTags,
  useNoteActions,
  useNoteCountsByNotebook,
  useNotebooks,
} from "../../lib/use-notes";
import { getErrorMessage } from "../../lib/errors";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { CreateNoteModal } from "../../components/notes/CreateNoteModal";
import { ThemedModal } from "../../components/theme/ThemedModal";
import { ThemedFormField } from "../../components/theme/ThemedFormField";
import { ThemedButton } from "../../components/theme/ThemedButton";
import { Panel } from "../../components/theme/Panel";

const SEARCH_RESULTS_LIMIT = 40;

export default function NotesHubScreen() {
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const notebooks = useNotebooks();
  const allNotes = useAllNotes();
  const tags = useAllTags();
  const noteCounts = useNoteCountsByNotebook();
  const { createNotebook, findOrCreateDailyNote } = useNoteActions();

  const [search, setSearch] = useState("");
  const [createNoteVisible, setCreateNoteVisible] = useState(false);
  const [createNotebookVisible, setCreateNotebookVisible] = useState(false);
  const [newNotebookName, setNewNotebookName] = useState("");
  const [dailyNoteBusy, setDailyNoteBusy] = useState(false);

  const notebookTree = useMemo(() => buildNotebookTree(notebooks), [notebooks]);

  const filteredNotes = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return allNotes.slice(0, SEARCH_RESULTS_LIMIT);
    return allNotes
      .filter((note) => note.title.toLowerCase().includes(query) || note.body.toLowerCase().includes(query))
      .slice(0, SEARCH_RESULTS_LIMIT);
  }, [allNotes, search]);

  const handleOpenToday = async () => {
    setDailyNoteBusy(true);
    try {
      const id = await findOrCreateDailyNote();
      router.push(`/notes/${id}`);
    } catch (e) {
      Alert.alert("Couldn't open today's note", getErrorMessage(e, "Please try again."));
    } finally {
      setDailyNoteBusy(false);
    }
  };

  const handleCreateNotebook = async () => {
    if (!newNotebookName.trim()) return;
    await createNotebook({ name: newNotebookName.trim() });
    setNewNotebookName("");
    setCreateNotebookVisible(false);
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
            <Text style={styles.title}>Notes</Text>
            <Pressable style={styles.newButton} onPress={() => setCreateNoteVisible(true)}>
              <Text style={styles.newButtonText}>+ New Note</Text>
            </Pressable>
          </View>
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <View style={styles.searchWrap}>
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
              placeholder="Search notes (title & body)..."
              placeholderTextColor={styles.placeholder.color}
            />
          </View>

          <Pressable style={styles.dailyButton} onPress={handleOpenToday} disabled={dailyNoteBusy}>
            <Text style={styles.dailyButtonText}>{dailyNoteBusy ? "Opening..." : "\u{1F4C5} Today's Note"}</Text>
          </Pressable>

          {tags.length > 0 ? (
            <View style={styles.tagRow}>
              {tags.slice(0, 12).map((tag) => (
                <Pressable
                  key={tag.id}
                  style={styles.tagChip}
                  onPress={() => router.push({ pathname: "/notes/tags", params: { name: tag.name } })}
                >
                  <Text style={styles.tagChipText}>#{tag.name} ({tag.note_count})</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          <Panel
            title="Notebooks"
            right={
              <Pressable onPress={() => setCreateNotebookVisible(true)}>
                <Text style={styles.addLink}>+ New</Text>
              </Pressable>
            }
          >
            {notebookTree.length === 0 ? (
              <Text style={styles.empty}>No notebooks yet - notes can also live outside any notebook.</Text>
            ) : (
              notebookTree.map(({ notebook, depth }) => (
                <Pressable
                  key={notebook.id}
                  style={[styles.row, { paddingLeft: depth * 16 }]}
                  onPress={() => router.push(`/notes/notebooks/${notebook.id}`)}
                >
                  <Text style={styles.rowTitle}>{"\u{1F4D3} " + notebook.name}</Text>
                  <Text style={styles.rowCount}>{noteCounts[notebook.id] ?? 0}</Text>
                </Pressable>
              ))
            )}
          </Panel>

          <Panel title={search.trim() ? "Search Results" : "All Notes"} status={`${filteredNotes.length}`}>
            {filteredNotes.length === 0 ? (
              <Text style={styles.empty}>{search.trim() ? "No notes match your search." : "No notes yet - create your first one."}</Text>
            ) : (
              filteredNotes.map((note) => (
                <Pressable key={note.id} style={styles.row} onPress={() => router.push(`/notes/${note.id}`)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {note.title}
                    </Text>
                    <Text style={styles.rowPreview} numberOfLines={1}>
                      {note.body.replace(/\s+/g, " ").trim() || "No content yet"}
                    </Text>
                  </View>
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
        onCreated={(id) => router.push(`/notes/${id}`)}
      />

      <ThemedModal visible={createNotebookVisible} onClose={() => setCreateNotebookVisible(false)}>
        <Text style={styles.modalTitle}>New Notebook</Text>
        <ThemedFormField label="Name" value={newNotebookName} onChangeText={setNewNotebookName} placeholder="e.g. Site Visits" autoFocus />
        <View style={styles.modalActions}>
          <ThemedButton label="Cancel" variant="secondary" onPress={() => setCreateNotebookVisible(false)} />
          <ThemedButton label="Create" onPress={handleCreateNotebook} disabled={!newNotebookName.trim()} />
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
    headerRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    newButton: { borderWidth: 1, borderColor: tokens.accent, borderRadius: 3, paddingVertical: 6, paddingHorizontal: 10 },
    newButtonText: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.label, textTransform: "uppercase" as const, ...mono },
    searchWrap: { paddingHorizontal: 12, marginTop: 8 },
    searchInput: {
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 4,
      padding: 12,
      fontSize: font.body,
      color: tokens.textPrimary,
      backgroundColor: tokens.surface,
      ...mono,
    },
    placeholder: { color: tokens.textMuted },
    dailyButton: {
      marginHorizontal: 12,
      marginTop: 10,
      borderWidth: 1,
      borderColor: tokens.accent,
      borderRadius: 4,
      paddingVertical: 12,
      alignItems: "center" as const,
      backgroundColor: tokens.surface,
      boxShadow: `0 0 10px ${tokens.accentGlow}`,
    },
    dailyButtonText: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.body, letterSpacing: 1, ...mono },
    tagRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, paddingHorizontal: 12, marginTop: 12 },
    tagChip: { borderWidth: 1, borderColor: tokens.border, borderRadius: 12, paddingVertical: 5, paddingHorizontal: 10, backgroundColor: tokens.surface },
    tagChipText: { color: tokens.textPrimary, fontSize: font.label - 1, ...mono },
    addLink: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.label, ...mono },
    empty: { color: tokens.textMuted, fontSize: font.body - 1, padding: 4, ...mono },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
      gap: 8,
    },
    rowTitle: { color: tokens.textPrimary, fontWeight: "700" as const, fontSize: font.body - 1, flex: 1, ...mono },
    rowPreview: { color: tokens.textMuted, fontSize: font.label - 1, ...mono },
    rowCount: { color: tokens.textMuted, fontSize: font.label - 1, ...mono },
    chevron: { color: tokens.accent, fontSize: font.body + 2 },
    modalTitle: { color: tokens.accent, fontSize: font.title, fontWeight: "700" as const, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    modalActions: { flexDirection: "row" as const, gap: 10, marginTop: 4 },
  };
}

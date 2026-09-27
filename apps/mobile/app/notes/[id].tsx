import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { extractTags } from "@jmssaas/shared";
import { useAllNotes, useNote, useNoteActions, useNotebooks } from "../../lib/use-notes";
import { getErrorMessage } from "../../lib/errors";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { WikilinkMarkdown } from "../../components/notes/WikilinkMarkdown";
import { NoteBacklinksPanel } from "../../components/notes/NoteBacklinksPanel";
import { NotePropertiesPanel } from "../../components/notes/NotePropertiesPanel";
import { NoteConflictBanner } from "../../components/notes/NoteConflictBanner";
import { ThemedButton } from "../../components/theme/ThemedButton";
import { ThemedModal } from "../../components/theme/ThemedModal";
import { ThemedFormField } from "../../components/theme/ThemedFormField";
import { ThemedPickerModal } from "../../components/theme/ThemedPickerModal";

const WIKILINK_SUGGESTION_LIMIT = 6;

// Looks backwards from the cursor for an unclosed "[[" on the current line
// - the trigger for the wikilink autocomplete panel below the editor.
// Deliberately simple (no full markdown/cursor-layout math): good enough
// for "start typing [[, see matching titles, tap one" on a plain
// multi-line TextInput, which has no native concept of an in-place
// floating suggestion popover anyway.
function activeWikilinkQuery(text: string, cursor: number): string | null {
  const upToCursor = text.slice(0, Math.max(0, cursor));
  const lastOpen = upToCursor.lastIndexOf("[[");
  if (lastOpen === -1) return null;
  const between = upToCursor.slice(lastOpen + 2);
  if (between.includes("]]") || between.includes("\n") || between.includes("[[")) return null;
  return between;
}

export default function NoteEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const note = useNote(id);
  const allNotes = useAllNotes();
  const notebooks = useNotebooks();
  const { updateNote, softDeleteNote, createTemplate, resolveOrCreateByTitle } = useNoteActions();

  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectionStart, setSelectionStart] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notebookPickerVisible, setNotebookPickerVisible] = useState(false);
  const [templateModalVisible, setTemplateModalVisible] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the local edit buffer once per note id, not on every reactive
  // PowerSync update - otherwise a background sync (or this screen's own
  // save) would silently overwrite in-progress, unsaved keystrokes. See
  // lib/use-notes.ts's header comment on why `note.revision` itself is
  // read fresh at save time instead.
  const loadedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (note && loadedIdRef.current !== note.id) {
      setTitle(note.title);
      setBody(note.body);
      loadedIdRef.current = note.id;
    }
  }, [note]);

  const isDirty = note != null && (title !== note.title || body !== note.body);
  const tags = useMemo(() => extractTags(body), [body]);
  const notebook = notebooks.find((n) => n.id === note?.notebook_id) ?? null;

  const wikilinkQuery = mode === "edit" ? activeWikilinkQuery(body, selectionStart) : null;
  const wikilinkSuggestions = useMemo(() => {
    if (wikilinkQuery == null) return [];
    const query = wikilinkQuery.trim().toLowerCase();
    const pool = query ? allNotes.filter((n) => n.title.toLowerCase().includes(query)) : allNotes;
    return pool.filter((n) => n.id !== note?.id).slice(0, WIKILINK_SUGGESTION_LIMIT);
  }, [wikilinkQuery, allNotes, note?.id]);

  const insertWikilink = (targetTitle: string) => {
    const upToCursor = body.slice(0, selectionStart);
    const lastOpen = upToCursor.lastIndexOf("[[");
    if (lastOpen === -1) return;
    const before = body.slice(0, lastOpen);
    const after = body.slice(selectionStart);
    const inserted = `[[${targetTitle}]]`;
    setBody(`${before}${inserted}${after}`);
    setSelectionStart(before.length + inserted.length);
  };

  const handleSave = async () => {
    if (!note || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateNote(note, { title, body });
    } catch (e) {
      setError(getErrorMessage(e, "Failed to save note (see console for details)"));
    } finally {
      setSaving(false);
    }
  };

  const handleMoveNotebook = async (notebookId: string | null) => {
    if (!note) return;
    try {
      await updateNote(note, { notebookId });
    } catch (e) {
      Alert.alert("Couldn't move note", getErrorMessage(e, "Please try again."));
    }
  };

  const handleDelete = () => {
    if (!note) return;
    Alert.alert("Delete note", `Move "${note.title}" to trash?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await softDeleteNote(note);
          router.back();
        },
      },
    ]);
  };

  const handleOpenWikilink = async (targetTitle: string) => {
    try {
      const targetId = await resolveOrCreateByTitle(targetTitle);
      router.push(`/notes/${targetId}`);
    } catch (e) {
      Alert.alert("Couldn't open link", getErrorMessage(e, "Please try again."));
    }
  };

  const handleSaveAsTemplate = async () => {
    if (!templateName.trim() || savingTemplate) return;
    setSavingTemplate(true);
    try {
      await createTemplate({ name: templateName.trim(), body });
      setTemplateModalVisible(false);
      setTemplateName("");
    } finally {
      setSavingTemplate(false);
    }
  };

  if (!note) {
    return (
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>{"‹"} Back</Text>
          </Pressable>
        </View>
        <Text style={styles.empty}>This note isn't available on this device yet.</Text>
      </SafeAreaView>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <View style={styles.headerTopRow}>
            <Pressable onPress={() => router.back()} hitSlop={8}>
              <Text style={styles.link}>{"‹"} Back</Text>
            </Pressable>
            <View style={styles.headerActions}>
              <Pressable onPress={() => setMode(mode === "edit" ? "preview" : "edit")} style={styles.modeButton}>
                <Text style={styles.modeButtonText}>{mode === "edit" ? "Preview" : "Edit"}</Text>
              </Pressable>
              <ThemedButton label={saving ? "Saving..." : "Save"} onPress={handleSave} disabled={!isDirty || saving} />
            </View>
          </View>
          <TextInput
            style={styles.titleInput}
            value={title}
            onChangeText={setTitle}
            placeholder="Untitled"
            placeholderTextColor={styles.placeholder.color}
          />
          <View style={styles.metaRow}>
            <Pressable onPress={() => setNotebookPickerVisible(true)}>
              <Text style={styles.metaLink}>{"\u{1F4D3} " + (notebook?.name ?? "No notebook")}</Text>
            </Pressable>
            <Pressable onPress={() => setTemplateModalVisible(true)}>
              <Text style={styles.metaLink}>Save as Template</Text>
            </Pressable>
            <Pressable onPress={handleDelete}>
              <Text style={styles.metaLinkDanger}>Delete</Text>
            </Pressable>
          </View>
          {tags.length > 0 ? (
            <View style={styles.tagRow}>
              {tags.map((tag) => (
                <Pressable key={tag} style={styles.tagChip} onPress={() => router.push({ pathname: "/notes/tags", params: { name: tag } })}>
                  <Text style={styles.tagChipText}>#{tag}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>

        <NoteConflictBanner noteId={note.id} />
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <View style={styles.editorWrap}>
            {mode === "edit" ? (
              <>
                <TextInput
                  style={styles.bodyInput}
                  value={body}
                  onChangeText={setBody}
                  onSelectionChange={(e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) =>
                    setSelectionStart(e.nativeEvent.selection.start)
                  }
                  multiline
                  placeholder="Start writing... use [[ to link another note, #tag for tags."
                  placeholderTextColor={styles.placeholder.color}
                  textAlignVertical="top"
                />
                {wikilinkQuery != null ? (
                  <View style={styles.suggestionPanel}>
                    {wikilinkSuggestions.length === 0 ? (
                      <Text style={styles.suggestionEmpty}>No matching notes yet - finish typing the title and link it anyway.</Text>
                    ) : (
                      wikilinkSuggestions.map((suggestion) => (
                        <Pressable key={suggestion.id} style={styles.suggestionRow} onPress={() => insertWikilink(suggestion.title)}>
                          <Text style={styles.suggestionText}>{suggestion.title}</Text>
                        </Pressable>
                      ))
                    )}
                  </View>
                ) : null}
              </>
            ) : (
              <WikilinkMarkdown body={body} onOpenWikilink={handleOpenWikilink} />
            )}
          </View>

          <NoteBacklinksPanel noteId={note.id} onOpenNote={(noteId) => router.push(`/notes/${noteId}`)} />
          <NotePropertiesPanel noteId={note.id} />
        </ScrollView>
      </SafeAreaView>

      <ThemedPickerModal
        visible={notebookPickerVisible}
        title="Move to Notebook"
        items={[{ id: "", name: "No notebook" }, ...notebooks]}
        getKey={(item) => item.id || "none"}
        getLabel={(item) => item.name}
        onSelect={(item) => handleMoveNotebook(item.id || null)}
        onClose={() => setNotebookPickerVisible(false)}
      />

      <ThemedModal visible={templateModalVisible} onClose={() => setTemplateModalVisible(false)}>
        <Text style={styles.modalTitle}>Save as Template</Text>
        <ThemedFormField label="Template name" value={templateName} onChangeText={setTemplateName} placeholder="e.g. Job Site Visit" autoFocus />
        <View style={styles.modalActions}>
          <ThemedButton label="Cancel" variant="secondary" onPress={() => setTemplateModalVisible(false)} />
          <ThemedButton
            label={savingTemplate ? "Saving..." : "Save"}
            onPress={handleSaveAsTemplate}
            disabled={!templateName.trim() || savingTemplate}
          />
        </View>
      </ThemedModal>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: tokens.border },
    headerTopRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const },
    headerActions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    modeButton: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, paddingVertical: 6, paddingHorizontal: 10 },
    modeButtonText: { color: tokens.textPrimary, fontSize: font.label, textTransform: "uppercase" as const, letterSpacing: 1, ...mono },
    titleInput: { fontSize: font.title + 2, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 0.5, ...mono },
    placeholder: { color: tokens.textMuted },
    metaRow: { flexDirection: "row" as const, gap: 16, flexWrap: "wrap" as const },
    metaLink: { color: tokens.accent, fontSize: font.label, ...mono },
    metaLinkDanger: { color: tokens.danger, fontSize: font.label, ...mono },
    tagRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    tagChip: { borderWidth: 1, borderColor: tokens.border, borderRadius: 10, paddingVertical: 3, paddingHorizontal: 8 },
    tagChipText: { color: tokens.textMuted, fontSize: font.label - 1, ...mono },
    error: { color: tokens.danger, marginHorizontal: 16, marginTop: 8, fontSize: font.body - 1, ...mono },
    editorWrap: { marginHorizontal: 12, marginTop: 12 },
    bodyInput: {
      minHeight: 220,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 4,
      backgroundColor: tokens.surface,
      padding: 12,
      fontSize: font.body,
      color: tokens.textPrimary,
      ...mono,
    },
    suggestionPanel: {
      marginTop: 6,
      borderWidth: 1,
      borderColor: tokens.accent,
      borderRadius: 4,
      backgroundColor: tokens.surface,
      maxHeight: 220,
    },
    suggestionEmpty: { color: tokens.textMuted, fontSize: font.body - 2, padding: 10, ...mono },
    suggestionRow: { paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: tokens.border },
    suggestionText: { color: tokens.textPrimary, fontSize: font.body - 1, ...mono },
    empty: { color: tokens.textMuted, fontSize: font.body - 1, padding: 24, textAlign: "center" as const, ...mono },
    modalTitle: { color: tokens.accent, fontSize: font.title, fontWeight: "700" as const, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    modalActions: { flexDirection: "row" as const, gap: 10, marginTop: 4 },
  };
}

import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { buildDailyNoteTemplateTokens, renderNoteTemplate, type NoteNotebook, type NoteTemplate } from "@jmssaas/shared";
import { useNoteActions, useNoteTemplates, useNotebooks } from "../../lib/use-notes";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedButton } from "../theme/ThemedButton";
import { ThemedFormField } from "../theme/ThemedFormField";
import { ThemedModal } from "../theme/ThemedModal";
import { ThemedPickerModal } from "../theme/ThemedPickerModal";

const BLANK_TEMPLATE_OPTION: NoteTemplate = {
  id: "",
  tenant_id: "",
  name: "Blank note",
  body: "",
  created_by: null,
  created_at: "",
  updated_at: "",
};

const NO_NOTEBOOK_OPTION: NoteNotebook = {
  id: "",
  tenant_id: "",
  parent_id: null,
  name: "No notebook",
  sort_order: -1,
  visibility: "tenant",
  edit_access: "tenant",
  created_by: null,
  created_at: "",
  updated_at: "",
};

interface CreateNoteModalProps {
  visible: boolean;
  onClose: () => void;
  onCreated: (noteId: string) => void;
  /** Preselected notebook, e.g. when creating from inside a notebook screen. */
  defaultNotebookId?: string | null;
}

// Shared "new note" flow for both the Notes hub and a notebook's own
// screen - lets a technician optionally start from a note_templates row
// (rendered via renderNoteTemplate(), same {token} substitution the daily
// note flow uses) instead of always starting blank.
export function CreateNoteModal({ visible, onClose, onCreated, defaultNotebookId = null }: CreateNoteModalProps) {
  const { createNote } = useNoteActions();
  const notebooks = useNotebooks();
  const templates = useNoteTemplates();
  const styles = useThemedStyles(createStyles);

  const [title, setTitle] = useState("");
  const [notebookId, setNotebookId] = useState<string | null>(defaultNotebookId);
  const [template, setTemplate] = useState<NoteTemplate>(BLANK_TEMPLATE_OPTION);
  const [notebookPickerVisible, setNotebookPickerVisible] = useState(false);
  const [templatePickerVisible, setTemplatePickerVisible] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setTitle("");
      setNotebookId(defaultNotebookId);
      setTemplate(BLANK_TEMPLATE_OPTION);
    }
  }, [visible, defaultNotebookId]);

  const notebookOptions = [NO_NOTEBOOK_OPTION, ...notebooks];
  const templateOptions = [BLANK_TEMPLATE_OPTION, ...templates];
  const selectedNotebook = notebookOptions.find((n) => n.id === notebookId) ?? NO_NOTEBOOK_OPTION;

  const handleCreate = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const body = template.body ? renderNoteTemplate(template.body, buildDailyNoteTemplateTokens()) : "";
      const id = await createNote({ title: title.trim(), body, notebookId: notebookId || null });
      onCreated(id);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <ThemedModal visible={visible} onClose={onClose}>
        <Text style={styles.title}>New Note</Text>
        <ThemedFormField label="Title" value={title} onChangeText={setTitle} placeholder="Untitled" autoFocus />

        <Pressable style={styles.pickerField} onPress={() => setNotebookPickerVisible(true)}>
          <Text style={styles.pickerLabel}>Notebook</Text>
          <Text style={styles.pickerValue}>{selectedNotebook.name}</Text>
        </Pressable>

        <Pressable style={styles.pickerField} onPress={() => setTemplatePickerVisible(true)}>
          <Text style={styles.pickerLabel}>Template</Text>
          <Text style={styles.pickerValue}>{template.name}</Text>
        </Pressable>

        <View style={styles.actions}>
          <ThemedButton label="Cancel" variant="secondary" onPress={onClose} />
          <ThemedButton label={saving ? "Creating..." : "Create"} onPress={handleCreate} disabled={!title.trim() || saving} />
        </View>
      </ThemedModal>

      <ThemedPickerModal
        visible={notebookPickerVisible}
        title="Choose Notebook"
        items={notebookOptions}
        getKey={(item) => item.id || "none"}
        getLabel={(item) => item.name}
        onSelect={(item) => setNotebookId(item.id || null)}
        onClose={() => setNotebookPickerVisible(false)}
      />
      <ThemedPickerModal
        visible={templatePickerVisible}
        title="Choose Template"
        items={templateOptions}
        getKey={(item) => item.id || "blank"}
        getLabel={(item) => item.name}
        onSelect={setTemplate}
        onClose={() => setTemplatePickerVisible(false)}
      />
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    title: { color: tokens.accent, fontSize: font.title, fontWeight: "700" as const, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    pickerField: { gap: 6 },
    pickerLabel: { color: tokens.textMuted, fontSize: font.label, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    pickerValue: {
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 3,
      padding: 12,
      fontSize: font.body,
      color: tokens.textPrimary,
      backgroundColor: tokens.background,
      ...mono,
    },
    actions: { flexDirection: "row" as const, gap: 10, marginTop: 4 },
  };
}

import { useState } from "react";
import { Alert, Pressable, Switch, Text, View } from "react-native";
import type { NotePropertyValueType } from "@jmssaas/shared";
import { useNoteProperties, useNoteActions, type NotePropertyRow } from "../../lib/use-notes";
import { useTheme } from "../../lib/theme-context";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { Panel } from "../theme/Panel";
import { ThemedButton } from "../theme/ThemedButton";
import { ThemedFormField } from "../theme/ThemedFormField";
import { ThemedModal } from "../theme/ThemedModal";
import { ThemedPickerModal } from "../theme/ThemedPickerModal";

const VALUE_TYPES: NotePropertyValueType[] = ["text", "number", "checkbox", "date", "list"];

function formatValue(row: NotePropertyRow): string {
  switch (row.value_type) {
    case "text":
      return row.value_text ?? "";
    case "number":
      return row.value_number != null ? String(row.value_number) : "";
    case "checkbox":
      return row.value_checkbox ? "Yes" : "No";
    case "date":
      return row.value_date ?? "";
    case "list": {
      if (!row.value_list) return "";
      try {
        const parsed: unknown = JSON.parse(row.value_list);
        return Array.isArray(parsed) ? parsed.join(", ") : "";
      } catch {
        return "";
      }
    }
    default:
      return "";
  }
}

interface EditorState {
  id?: string;
  key: string;
  valueType: NotePropertyValueType;
  text: string;
  number: string;
  checkbox: boolean;
  date: string;
  list: string;
}

const BLANK_EDITOR: EditorState = { key: "", valueType: "text", text: "", number: "", checkbox: false, date: "", list: "" };

export function NotePropertiesPanel({ noteId }: { noteId: string }) {
  const properties = useNoteProperties(noteId);
  const { upsertProperty, deleteProperty } = useNoteActions();
  const { tokens } = useTheme();
  const styles = useThemedStyles(createStyles);

  const [editorVisible, setEditorVisible] = useState(false);
  const [editor, setEditor] = useState<EditorState>(BLANK_EDITOR);
  const [typePickerVisible, setTypePickerVisible] = useState(false);

  const openCreate = () => {
    setEditor(BLANK_EDITOR);
    setEditorVisible(true);
  };

  const openEdit = (row: NotePropertyRow) => {
    let listText = "";
    if (row.value_list) {
      try {
        const parsed: unknown = JSON.parse(row.value_list);
        if (Array.isArray(parsed)) listText = parsed.join(", ");
      } catch {
        listText = "";
      }
    }
    setEditor({
      id: row.id,
      key: row.key,
      valueType: row.value_type,
      text: row.value_text ?? "",
      number: row.value_number != null ? String(row.value_number) : "",
      checkbox: !!row.value_checkbox,
      date: row.value_date ?? "",
      list: listText,
    });
    setEditorVisible(true);
  };

  const handleDelete = (row: NotePropertyRow) => {
    Alert.alert("Delete property", `Remove "${row.key}"?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => deleteProperty(row.id) },
    ]);
  };

  const handleSave = async () => {
    const key = editor.key.trim();
    if (!key) return;
    await upsertProperty({
      id: editor.id,
      noteId,
      key,
      valueType: editor.valueType,
      valueText: editor.valueType === "text" ? editor.text : null,
      valueNumber: editor.valueType === "number" ? (editor.number.trim() === "" ? null : Number(editor.number)) : null,
      valueCheckbox: editor.valueType === "checkbox" ? editor.checkbox : null,
      valueDate: editor.valueType === "date" ? editor.date.trim() || null : null,
      valueList:
        editor.valueType === "list"
          ? editor.list
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : null,
    });
    setEditorVisible(false);
  };

  return (
    <Panel title="Properties" right={<Pressable onPress={openCreate}><Text style={styles.addLink}>+ Add</Text></Pressable>}>
      {properties.length === 0 ? (
        <Text style={styles.empty}>No properties yet - add typed metadata like status, due date or priority.</Text>
      ) : (
        properties.map((row) => (
          <Pressable key={row.id} style={styles.row} onPress={() => openEdit(row)} onLongPress={() => handleDelete(row)}>
            <View style={styles.rowLeft}>
              <Text style={styles.rowKey}>{row.key}</Text>
              <Text style={styles.rowType}>{row.value_type}</Text>
            </View>
            <Text style={styles.rowValue} numberOfLines={1}>
              {formatValue(row) || "—"}
            </Text>
          </Pressable>
        ))
      )}

      <ThemedModal visible={editorVisible} onClose={() => setEditorVisible(false)}>
        <Text style={styles.modalTitle}>{editor.id ? "Edit Property" : "New Property"}</Text>
        <ThemedFormField label="Name" value={editor.key} onChangeText={(key) => setEditor((e) => ({ ...e, key }))} placeholder="e.g. Status" />
        <Pressable style={styles.typeField} onPress={() => setTypePickerVisible(true)}>
          <Text style={styles.typeLabel}>Type</Text>
          <Text style={styles.typeValue}>{editor.valueType}</Text>
        </Pressable>

        {editor.valueType === "text" ? (
          <ThemedFormField label="Value" value={editor.text} onChangeText={(text) => setEditor((e) => ({ ...e, text }))} placeholder="Value" />
        ) : null}
        {editor.valueType === "number" ? (
          <ThemedFormField
            label="Value"
            value={editor.number}
            onChangeText={(number) => setEditor((e) => ({ ...e, number }))}
            placeholder="0"
            keyboardType="numeric"
          />
        ) : null}
        {editor.valueType === "date" ? (
          <ThemedFormField
            label="Value (YYYY-MM-DD)"
            value={editor.date}
            onChangeText={(date) => setEditor((e) => ({ ...e, date }))}
            placeholder="2026-09-27"
          />
        ) : null}
        {editor.valueType === "list" ? (
          <ThemedFormField
            label="Value (comma-separated)"
            value={editor.list}
            onChangeText={(list) => setEditor((e) => ({ ...e, list }))}
            placeholder="one, two, three"
          />
        ) : null}
        {editor.valueType === "checkbox" ? (
          <View style={styles.switchRow}>
            <Text style={styles.typeLabel}>Value</Text>
            <Switch
              value={editor.checkbox}
              onValueChange={(checkbox) => setEditor((e) => ({ ...e, checkbox }))}
              trackColor={{ true: tokens.accent, false: tokens.border }}
              thumbColor={tokens.surface}
            />
          </View>
        ) : null}

        <View style={styles.modalActions}>
          <ThemedButton label="Cancel" variant="secondary" onPress={() => setEditorVisible(false)} />
          <ThemedButton label="Save" onPress={handleSave} disabled={!editor.key.trim()} />
        </View>
      </ThemedModal>

      <ThemedPickerModal
        visible={typePickerVisible}
        title="Property Type"
        items={VALUE_TYPES}
        getKey={(item) => item}
        getLabel={(item) => item}
        onSelect={(valueType) => setEditor((e) => ({ ...e, valueType }))}
        onClose={() => setTypePickerVisible(false)}
      />
    </Panel>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    empty: { color: tokens.textMuted, fontSize: font.body - 1, ...mono },
    addLink: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.label, ...mono },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
      gap: 8,
    },
    rowLeft: { flexShrink: 0 },
    rowKey: { color: tokens.textPrimary, fontWeight: "700" as const, fontSize: font.body - 1, ...mono },
    rowType: { color: tokens.textMuted, fontSize: font.label - 1, textTransform: "uppercase" as const, ...mono },
    rowValue: { color: tokens.accent, fontSize: font.body - 1, flex: 1, textAlign: "right" as const, ...mono },
    modalTitle: { color: tokens.accent, fontSize: font.title, fontWeight: "700" as const, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    typeField: { gap: 6 },
    typeLabel: { color: tokens.textMuted, fontSize: font.label, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    typeValue: {
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 3,
      padding: 12,
      fontSize: font.body,
      color: tokens.textPrimary,
      backgroundColor: tokens.background,
      textTransform: "capitalize" as const,
      ...mono,
    },
    switchRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const },
    modalActions: { flexDirection: "row" as const, gap: 10, marginTop: 4 },
  };
}

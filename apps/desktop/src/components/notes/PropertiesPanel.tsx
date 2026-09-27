import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createNotePropertySchema, type NoteProperty, type NotePropertyValueType } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { ThemedModal } from "../theme/ThemedModal";
import { ThemedButton } from "../theme/ThemedButton";
import { ThemedFormField, ThemedSelectField } from "../theme/ThemedFormField";
import { fetchNotePropertiesForNote } from "./notesData";
import { formatPropertyValue } from "./notePropertyHelpers";

const VALUE_TYPE_OPTIONS: { value: NotePropertyValueType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "checkbox", label: "Checkbox" },
  { value: "date", label: "Date" },
  { value: "list", label: "List" },
];

export function PropertiesPanel({ noteId, canEdit }: { noteId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const key = ["note-properties", noteId];
  const { data: properties, isLoading } = useQuery({ queryKey: key, queryFn: () => fetchNotePropertiesForNote(noteId) });

  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [pKey, setPKey] = useState("");
  const [pType, setPType] = useState<NotePropertyValueType>("text");
  const [pText, setPText] = useState("");
  const [pNumber, setPNumber] = useState("");
  const [pCheckbox, setPCheckbox] = useState(false);
  const [pDate, setPDate] = useState("");
  const [pList, setPList] = useState("");
  const [error, setError] = useState<string | null>(null);

  const openNew = () => {
    setEditId(null);
    setPKey("");
    setPType("text");
    setPText("");
    setPNumber("");
    setPCheckbox(false);
    setPDate("");
    setPList("");
    setError(null);
    setModalOpen(true);
  };

  const openEdit = (p: NoteProperty) => {
    setEditId(p.id);
    setPKey(p.key);
    setPType(p.value_type);
    setPText(p.value_text ?? "");
    setPNumber(p.value_number != null ? String(p.value_number) : "");
    setPCheckbox(p.value_checkbox ?? false);
    setPDate(p.value_date ?? "");
    setPList((p.value_list ?? []).join(", "));
    setError(null);
    setModalOpen(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const result = createNotePropertySchema.safeParse({
        note_id: noteId,
        key: pKey,
        value_type: pType,
        value_text: pType === "text" ? pText : undefined,
        value_number: pType === "number" && pNumber !== "" ? Number(pNumber) : undefined,
        value_checkbox: pType === "checkbox" ? pCheckbox : undefined,
        value_date: pType === "date" && pDate ? pDate : undefined,
        value_list: pType === "list" ? pList.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        sort_order: (properties ?? []).length,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid property");

      const values = {
        tenant_id: profile.tenant_id,
        note_id: result.data.note_id,
        key: result.data.key,
        value_type: result.data.value_type,
        value_text: result.data.value_text ?? null,
        value_number: result.data.value_number ?? null,
        value_checkbox: result.data.value_checkbox ?? null,
        value_date: result.data.value_date ?? null,
        value_list: result.data.value_list ?? null,
        sort_order: result.data.sort_order ?? 0,
      };

      const { error: dbError } = editId
        ? await supabase
            .from("note_properties")
            .update({
              key: values.key,
              value_type: values.value_type,
              value_text: values.value_text,
              value_number: values.value_number,
              value_checkbox: values.value_checkbox,
              value_date: values.value_date,
              value_list: values.value_list,
            })
            .eq("id", editId)
        : await supabase.from("note_properties").insert(values);
      if (dbError) throw dbError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ["note-properties-all"] });
      setModalOpen(false);
    },
    onError: (e) => setError(getErrorMessage(e, "Failed to save property")),
  });

  const remove = useMutation({
    mutationFn: async (propertyId: string) => {
      const { error: dbError } = await supabase.from("note_properties").delete().eq("id", propertyId);
      if (dbError) throw dbError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ["note-properties-all"] });
    },
  });

  return (
    <div>
      {isLoading ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
      ) : (properties ?? []).length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No properties yet.</p>
      ) : (
        <div className="space-y-1">
          {(properties ?? []).map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 rounded px-2 py-1" style={{ border: "1px solid var(--jms-border)" }}>
              <div className="min-w-0 flex-1">
                <span className="mr-2 font-semibold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  {p.key}
                </span>
                <span style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>{formatPropertyValue(p) || "-"}</span>
              </div>
              {canEdit ? (
                <div className="flex flex-shrink-0 gap-2">
                  <button onClick={() => openEdit(p)} style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                    Edit
                  </button>
                  <button onClick={() => remove.mutate(p.id)} style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                    Delete
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {canEdit ? (
        <button onClick={openNew} className="mt-2 font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          + Add property
        </button>
      ) : null}

      <ThemedModal open={modalOpen} onClose={() => setModalOpen(false)} title={editId ? "Edit property" : "New property"}>
        <ThemedFormField label="Name" value={pKey} onChange={(e) => setPKey(e.target.value)} placeholder="e.g. status" />
        <ThemedSelectField label="Type" value={pType} onChange={(v) => setPType((v || "text") as NotePropertyValueType)} options={VALUE_TYPE_OPTIONS} />
        {pType === "text" ? <ThemedFormField label="Value" value={pText} onChange={(e) => setPText(e.target.value)} /> : null}
        {pType === "number" ? <ThemedFormField label="Value" type="number" value={pNumber} onChange={(e) => setPNumber(e.target.value)} /> : null}
        {pType === "date" ? <ThemedFormField label="Value" type="date" value={pDate} onChange={(e) => setPDate(e.target.value)} /> : null}
        {pType === "list" ? <ThemedFormField label="Values (comma separated)" value={pList} onChange={(e) => setPList(e.target.value)} placeholder="a, b, c" /> : null}
        {pType === "checkbox" ? (
          <label className="mb-4 flex items-center gap-2" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            <input type="checkbox" checked={pCheckbox} onChange={(e) => setPCheckbox(e.target.checked)} />
            Checked
          </label>
        ) : null}
        {error ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => save.mutate()} disabled={save.isPending || !pKey.trim()}>
            {save.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}

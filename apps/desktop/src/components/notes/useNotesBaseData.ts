import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ALL_NOTE_PROPERTIES_KEY,
  NOTEBOOKS_KEY,
  NOTES_INDEX_KEY,
  NOTE_TAGS_KEY,
  NOTE_TAG_ASSIGNMENTS_KEY,
  fetchAllNoteProperties,
  fetchNoteTagAssignments,
  fetchNoteTags,
  fetchNotebooks,
  fetchNotesIndex,
} from "./notesData";
import { distinctPropertyKeys, groupPropertiesByNote } from "./notePropertyHelpers";

// Shared data-loading for the Table and Card ("Bases-style") views - both
// need the same notes+notebooks+properties+tags join, just render it
// differently.
export function useNotesBaseData() {
  const { data: notesIndex, isLoading: notesLoading } = useQuery({ queryKey: NOTES_INDEX_KEY, queryFn: fetchNotesIndex });
  const { data: notebooks } = useQuery({ queryKey: NOTEBOOKS_KEY, queryFn: fetchNotebooks });
  const { data: properties, isLoading: propertiesLoading } = useQuery({ queryKey: ALL_NOTE_PROPERTIES_KEY, queryFn: fetchAllNoteProperties });
  const { data: tags } = useQuery({ queryKey: NOTE_TAGS_KEY, queryFn: fetchNoteTags });
  const { data: assignments } = useQuery({ queryKey: NOTE_TAG_ASSIGNMENTS_KEY, queryFn: fetchNoteTagAssignments });

  const notebooksById = useMemo(() => new Map((notebooks ?? []).map((n) => [n.id, n])), [notebooks]);
  const propertiesByNote = useMemo(() => groupPropertiesByNote(properties ?? []), [properties]);
  const propertyKeys = useMemo(() => distinctPropertyKeys(properties ?? []), [properties]);
  const tagNamesById = useMemo(() => new Map((tags ?? []).map((t) => [t.id, t.name])), [tags]);
  const tagsByNote = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const a of assignments ?? []) {
      const name = tagNamesById.get(a.tag_id);
      if (!name) continue;
      const list = map.get(a.note_id) ?? [];
      list.push(name);
      map.set(a.note_id, list);
    }
    return map;
  }, [assignments, tagNamesById]);

  return {
    notes: notesIndex ?? [],
    notebooks: notebooks ?? [],
    notebooksById,
    propertiesByNote,
    propertyKeys,
    tagsByNote,
    isLoading: notesLoading || propertiesLoading,
  };
}

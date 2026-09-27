import { v4 as uuidv4 } from "uuid";
import { usePowerSync, useQuery } from "@powersync/react";
import {
  buildDailyNoteTemplateTokens,
  dailyNoteDateKey,
  renderNoteTemplate,
  type Note,
  type NoteAccessLevel,
  type NoteNotebook,
  type NotePropertyValueType,
  type NoteTemplate,
} from "@jmssaas/shared";
import { useAuth } from "./auth-context";

// Notes module - local-first read hooks + write actions, all against the
// PowerSync-synced local SQLite tables (see packages/shared/src/powersync/
// schema.ts). Mirrors the useJobNotes/MeasureRoofTool pattern used
// elsewhere in this app: useQuery() for live reads, powersync.execute()
// for writes, ids generated client-side with uuidv4() since there's no
// server round-trip to hand one back while offline.
//
// Every write below that touches notes.title/notes.body carries the row's
// currently-known `revision` back unchanged - see the notes_module
// migration's notes_handle_revision() trigger. That trigger (Postgres-side
// only) is what actually advances the counter and detects a stale/
// conflicting write once the queued change syncs up; this file's job is
// only to make sure that value is never silently omitted.

export function useNotebooks() {
  const { data } = useQuery<NoteNotebook>("SELECT * FROM note_notebooks ORDER BY sort_order, name");
  return data;
}

export function useNotebook(id: string | null | undefined) {
  const { data } = useQuery<NoteNotebook>("SELECT * FROM note_notebooks WHERE id = ?", [id ?? ""]);
  return data[0] ?? null;
}

export interface NotebookTreeRow {
  notebook: NoteNotebook;
  depth: number;
}

// Simple parent_id walk (dataset per tenant is small - notebooks, not
// notes) rather than a full recursive-CTE query, since PowerSync's local
// SQLite is queried the same synchronous way either way and this is far
// easier to read. Used for the "Notebooks" list/tree on the Notes hub.
export function buildNotebookTree(notebooks: NoteNotebook[]): NotebookTreeRow[] {
  const byParent = new Map<string | null, NoteNotebook[]>();
  for (const notebook of notebooks) {
    const key = notebook.parent_id;
    const list = byParent.get(key) ?? [];
    list.push(notebook);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  }
  const result: NotebookTreeRow[] = [];
  function walk(parentId: string | null, depth: number) {
    for (const notebook of byParent.get(parentId) ?? []) {
      result.push({ notebook, depth });
      walk(notebook.id, depth + 1);
    }
  }
  walk(null, 0);
  return result;
}

// notebookId === null explicitly means "notes with no notebook" (a valid,
// intentional query, not "no filter") - callers that want every note use
// useAllNotes() instead.
export function useNotesInNotebook(notebookId: string | null) {
  const { data } = useQuery<Note>(
    notebookId
      ? "SELECT * FROM notes WHERE notebook_id = ? AND is_deleted = 0 ORDER BY updated_at DESC"
      : "SELECT * FROM notes WHERE notebook_id IS NULL AND is_deleted = 0 ORDER BY updated_at DESC",
    notebookId ? [notebookId] : []
  );
  return data;
}

export function useNoteCountsByNotebook(): Record<string, number> {
  const { data } = useQuery<{ notebook_id: string | null; count: number }>(
    "SELECT notebook_id as notebook_id, COUNT(*) as count FROM notes WHERE is_deleted = 0 GROUP BY notebook_id"
  );
  const counts: Record<string, number> = {};
  for (const row of data) {
    if (row.notebook_id) counts[row.notebook_id] = row.count;
  }
  return counts;
}

export function useAllNotes() {
  const { data } = useQuery<Note>("SELECT * FROM notes WHERE is_deleted = 0 ORDER BY updated_at DESC");
  return data;
}

export function useNote(id: string | null | undefined) {
  const { data } = useQuery<Note>("SELECT * FROM notes WHERE id = ?", [id ?? ""]);
  return data[0] ?? null;
}

export function useNoteTemplates() {
  const { data } = useQuery<NoteTemplate>("SELECT * FROM note_templates ORDER BY name");
  return data;
}

export interface NotePropertyRow {
  id: string;
  note_id: string;
  key: string;
  value_type: NotePropertyValueType;
  value_text: string | null;
  value_number: number | null;
  value_checkbox: number | null;
  value_date: string | null;
  value_list: string | null;
  sort_order: number;
}

export function useNoteProperties(noteId: string | null | undefined) {
  const { data } = useQuery<NotePropertyRow>(
    "SELECT * FROM note_properties WHERE note_id = ? ORDER BY sort_order, key",
    [noteId ?? ""]
  );
  return data;
}

export interface TagWithCount {
  id: string;
  name: string;
  note_count: number;
}

export function useAllTags() {
  const { data } = useQuery<TagWithCount>(
    `SELECT t.id as id, t.name as name, COUNT(a.note_id) as note_count
     FROM note_tags t
     LEFT JOIN note_tag_assignments a ON a.tag_id = t.id
     GROUP BY t.id, t.name
     ORDER BY t.name`
  );
  return data;
}

export function useNotesByTag(tagName: string | null | undefined) {
  const { data } = useQuery<Note>(
    `SELECT n.* FROM notes n
     JOIN note_tag_assignments a ON a.note_id = n.id
     JOIN note_tags t ON t.id = a.tag_id
     WHERE t.name = ? AND n.is_deleted = 0
     ORDER BY n.updated_at DESC`,
    [tagName ?? ""]
  );
  return data;
}

export interface BacklinkRow {
  link_id: string;
  source_note_id: string;
  title: string;
}

// Read-only, and may be stale until this device's next sync - note_links is
// only ever written by the Postgres trigger (see the notes_module
// migration), which can't run offline. Expected/documented, not a bug.
export function useBacklinks(noteId: string | null | undefined) {
  const { data } = useQuery<BacklinkRow>(
    `SELECT nl.id as link_id, nl.source_note_id as source_note_id, n.title as title
     FROM note_links nl
     JOIN notes n ON n.id = nl.source_note_id
     WHERE nl.target_note_id = ? AND n.is_deleted = 0
     ORDER BY n.title`,
    [noteId ?? ""]
  );
  return data;
}

export interface CreateNoteOptions {
  title: string;
  body?: string;
  notebookId?: string | null;
  dailyNoteDate?: string | null;
  visibility?: NoteAccessLevel;
  editAccess?: NoteAccessLevel;
}

export function useNoteActions() {
  const powersync = usePowerSync();
  const { profile } = useAuth();

  async function createNote(options: CreateNoteOptions): Promise<string> {
    if (!profile) throw new Error("Not signed in");
    const id = uuidv4();
    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO notes
         (id, tenant_id, notebook_id, title, body, daily_note_date, visibility, edit_access, revision, is_deleted, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`,
      [
        id,
        profile.tenant_id,
        options.notebookId ?? null,
        options.title.trim() || "Untitled",
        options.body ?? "",
        options.dailyNoteDate ?? null,
        options.visibility ?? "tenant",
        options.editAccess ?? "tenant",
        profile.id,
        profile.id,
        now,
        now,
      ]
    );
    return id;
  }

  // `note` must be the freshest locally-known row (from a live useQuery/
  // useNote(), not a stale snapshot) so `note.revision` really is "the
  // revision this device currently believes is current" at write time -
  // see this file's header comment.
  async function updateNote(
    note: Note,
    changes: { title?: string; body?: string; notebookId?: string | null }
  ): Promise<void> {
    if (!profile) throw new Error("Not signed in");
    const nextTitle = changes.title !== undefined ? changes.title.trim() || "Untitled" : note.title;
    const nextBody = changes.body !== undefined ? changes.body : note.body;
    const nextNotebookId = changes.notebookId !== undefined ? changes.notebookId : note.notebook_id;
    await powersync.execute(
      `UPDATE notes SET title = ?, body = ?, notebook_id = ?, revision = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [nextTitle, nextBody, nextNotebookId, note.revision, profile.id, new Date().toISOString(), note.id]
    );
  }

  async function softDeleteNote(note: Note): Promise<void> {
    if (!profile) throw new Error("Not signed in");
    await powersync.execute(
      "UPDATE notes SET is_deleted = 1, deleted_at = ?, revision = ?, updated_by = ?, updated_at = ? WHERE id = ?",
      [new Date().toISOString(), note.revision, profile.id, new Date().toISOString(), note.id]
    );
  }

  async function createNotebook(input: { name: string; parentId?: string | null }): Promise<string> {
    if (!profile) throw new Error("Not signed in");
    const id = uuidv4();
    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO note_notebooks (id, tenant_id, parent_id, name, sort_order, visibility, edit_access, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'tenant', 'tenant', ?, ?, ?)`,
      [id, profile.tenant_id, input.parentId ?? null, input.name.trim() || "Untitled Notebook", profile.id, now, now]
    );
    return id;
  }

  async function createTemplate(input: { name: string; body: string }): Promise<string> {
    if (!profile) throw new Error("Not signed in");
    const id = uuidv4();
    const now = new Date().toISOString();
    await powersync.execute(
      "INSERT INTO note_templates (id, tenant_id, name, body, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, profile.tenant_id, input.name.trim() || "Untitled Template", input.body, profile.id, now, now]
    );
    return id;
  }

  async function upsertProperty(input: {
    id?: string;
    noteId: string;
    key: string;
    valueType: NotePropertyValueType;
    valueText?: string | null;
    valueNumber?: number | null;
    valueCheckbox?: boolean | null;
    valueDate?: string | null;
    valueList?: string[] | null;
    sortOrder?: number;
  }): Promise<void> {
    if (!profile) throw new Error("Not signed in");
    const now = new Date().toISOString();
    const listJson = input.valueList ? JSON.stringify(input.valueList) : null;
    const checkboxInt = input.valueCheckbox == null ? null : input.valueCheckbox ? 1 : 0;
    if (input.id) {
      await powersync.execute(
        `UPDATE note_properties
         SET key = ?, value_type = ?, value_text = ?, value_number = ?, value_checkbox = ?, value_date = ?, value_list = ?, sort_order = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.key,
          input.valueType,
          input.valueText ?? null,
          input.valueNumber ?? null,
          checkboxInt,
          input.valueDate ?? null,
          listJson,
          input.sortOrder ?? 0,
          now,
          input.id,
        ]
      );
      return;
    }
    const id = uuidv4();
    await powersync.execute(
      `INSERT INTO note_properties
         (id, tenant_id, note_id, key, value_type, value_text, value_number, value_checkbox, value_date, value_list, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        profile.tenant_id,
        input.noteId,
        input.key,
        input.valueType,
        input.valueText ?? null,
        input.valueNumber ?? null,
        checkboxInt,
        input.valueDate ?? null,
        listJson,
        input.sortOrder ?? 0,
        now,
        now,
      ]
    );
  }

  async function deleteProperty(id: string): Promise<void> {
    await powersync.execute("DELETE FROM note_properties WHERE id = ?", [id]);
  }

  async function findNoteByTitle(title: string): Promise<Note | null> {
    const rows = await powersync.getAll<Note>(
      "SELECT * FROM notes WHERE lower(title) = lower(?) AND is_deleted = 0 LIMIT 1",
      [title]
    );
    return rows[0] ?? null;
  }

  // Used when tapping an unresolved [[wikilink]] (preview or backlinks) -
  // offline-safe: creates the target note locally now, and the Postgres
  // trigger resolves the *source* note's note_links row to it once both
  // sides have synced up (see notes_recompute_links_and_tags() in the
  // notes_module migration).
  async function resolveOrCreateByTitle(title: string): Promise<string> {
    const existing = await findNoteByTitle(title);
    if (existing) return existing.id;
    return createNote({ title });
  }

  async function findOrCreateDailyNote(date: Date = new Date()): Promise<string> {
    const dateKey = dailyNoteDateKey(date);
    const existing = await powersync.getAll<Note>(
      "SELECT * FROM notes WHERE daily_note_date = ? AND is_deleted = 0 LIMIT 1",
      [dateKey]
    );
    if (existing[0]) return existing[0].id;

    const templates = await powersync.getAll<NoteTemplate>(
      "SELECT * FROM note_templates WHERE lower(name) = 'daily note' LIMIT 1"
    );
    const tokens = buildDailyNoteTemplateTokens(date);
    const body = templates[0] ? renderNoteTemplate(templates[0].body, tokens) : "";
    return createNote({ title: dateKey, body, dailyNoteDate: dateKey });
  }

  return {
    createNote,
    updateNote,
    softDeleteNote,
    createNotebook,
    createTemplate,
    upsertProperty,
    deleteProperty,
    findNoteByTitle,
    resolveOrCreateByTitle,
    findOrCreateDailyNote,
  };
}

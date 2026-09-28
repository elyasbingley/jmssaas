import type {
  Note,
  NoteAttachment,
  NoteLink,
  NoteNotebook,
  NoteProperty,
  NoteRevision,
  NoteTag,
  NoteTagAssignment,
  NoteTemplate,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";

// Shared fetchers/types/helpers for the Notes module, used across
// pages/Notes.tsx (the sidebar shell) and its nested routes/detail panels.
// Kept in one place so every screen queries the same shape (and the same
// React Query cache keys) rather than each re-deriving its own slice.

export const NOTES_INDEX_KEY = ["notes-index"];
export const NOTEBOOKS_KEY = ["note-notebooks"];
export const NOTE_TAGS_KEY = ["note-tags"];
export const NOTE_TAG_ASSIGNMENTS_KEY = ["note-tag-assignments"];
export const NOTE_TEMPLATES_KEY = ["note-templates"];
export const ALL_NOTE_LINKS_KEY = ["note-links-all"];
export const ALL_NOTE_PROPERTIES_KEY = ["note-properties-all"];

// Slim projection used everywhere a full note body isn't needed - sidebar
// tree, wikilink autocomplete/resolution, table/card views, graph nodes.
export type NoteIndexRow = Pick<Note, "id" | "title" | "notebook_id" | "daily_note_date" | "updated_at" | "created_at">;

export async function fetchNotesIndex(): Promise<NoteIndexRow[]> {
  const { data, error } = await supabase
    .from("notes")
    .select("id, title, notebook_id, daily_note_date, updated_at, created_at")
    .eq("is_deleted", false)
    .order("title");
  if (error) throw error;
  return data as NoteIndexRow[];
}

export async function fetchNotebooks(): Promise<NoteNotebook[]> {
  const { data, error } = await supabase.from("note_notebooks").select("*").order("sort_order").order("name");
  if (error) throw error;
  return data as NoteNotebook[];
}

export async function fetchNoteTags(): Promise<NoteTag[]> {
  const { data, error } = await supabase.from("note_tags").select("*").order("name");
  if (error) throw error;
  return data as NoteTag[];
}

export async function fetchNoteTagAssignments(): Promise<NoteTagAssignment[]> {
  const { data, error } = await supabase.from("note_tag_assignments").select("*");
  if (error) throw error;
  return data as NoteTagAssignment[];
}

export async function fetchNoteTemplates(): Promise<NoteTemplate[]> {
  const { data, error } = await supabase.from("note_templates").select("*").order("name");
  if (error) throw error;
  return data as NoteTemplate[];
}

export async function fetchNote(noteId: string): Promise<Note> {
  const { data, error } = await supabase.from("notes").select("*").eq("id", noteId).single();
  if (error) throw error;
  return data as Note;
}

// Every link touching this note, in either direction, in one round trip -
// same "fetch flat rows, join client-side against an already-fetched index
// map" shape TaskDetail.tsx uses for task_dependencies (see its own
// `.or(blocking_task_id.eq...,dependent_task_id.eq...)`), which also sidesteps
// note_links having two FKs to `notes` (source/target) that would otherwise
// need PostgREST's `!column` embed-disambiguation syntax.
export async function fetchNoteLinksTouching(noteId: string): Promise<NoteLink[]> {
  const { data, error } = await supabase
    .from("note_links")
    .select("*")
    .or(`source_note_id.eq.${noteId},target_note_id.eq.${noteId}`);
  if (error) throw error;
  return data as NoteLink[];
}

// Tenant-wide, resolved-only links for the graph view - an unresolved link
// has no target_note_id, so it can't be drawn as an edge to a real node.
export async function fetchAllResolvedNoteLinks(): Promise<NoteLink[]> {
  const { data, error } = await supabase.from("note_links").select("*").not("target_note_id", "is", null);
  if (error) throw error;
  return data as NoteLink[];
}

export async function fetchAllNoteProperties(): Promise<NoteProperty[]> {
  const { data, error } = await supabase.from("note_properties").select("*").order("sort_order");
  if (error) throw error;
  return data as NoteProperty[];
}

export async function fetchNotePropertiesForNote(noteId: string): Promise<NoteProperty[]> {
  const { data, error } = await supabase.from("note_properties").select("*").eq("note_id", noteId).order("sort_order");
  if (error) throw error;
  return data as NoteProperty[];
}

export async function fetchNoteRevisions(noteId: string): Promise<NoteRevision[]> {
  const { data, error } = await supabase.from("note_revisions").select("*").eq("note_id", noteId).order("edited_at", { ascending: false });
  if (error) throw error;
  return data as NoteRevision[];
}

export async function fetchLatestNoteRevision(noteId: string): Promise<NoteRevision | null> {
  const { data, error } = await supabase
    .from("note_revisions")
    .select("*")
    .eq("note_id", noteId)
    .order("edited_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as NoteRevision | null) ?? null;
}

export async function fetchNoteAttachments(noteId: string): Promise<NoteAttachment[]> {
  const { data, error } = await supabase.from("note_attachments").select("*").eq("note_id", noteId).order("created_at");
  if (error) throw error;
  return data as NoteAttachment[];
}

// --- Lookup helpers -------------------------------------------------------

export interface TitleLookupEntry {
  id: string;
  title: string;
}

/** Case-insensitive title -> {id, title} map, mirroring the DB's own
 * `lower(title)` resolution rule in notes_recompute_links_and_tags(). */
export function buildTitleIndex(notes: NoteIndexRow[]): Map<string, TitleLookupEntry> {
  const map = new Map<string, TitleLookupEntry>();
  for (const n of notes) {
    map.set(n.title.toLowerCase(), { id: n.id, title: n.title });
  }
  return map;
}

export function resolveTitle(titleIndex: Map<string, TitleLookupEntry>, target: string): TitleLookupEntry | null {
  return titleIndex.get(target.trim().toLowerCase()) ?? null;
}

// Fixed, distinct notebook/tag graph-node colours - same reasoning as
// B2BReferrals.tsx's TIER_BADGE_COLORS: a stable, app-level distinction
// (not tenant-configurable data) chosen to stay legible on the CRT theme's
// dark background regardless of which accent preset is active. "No
// notebook" and "unresolved" get their own fixed entries below.
export const NOTEBOOK_PALETTE = ["#4ac6ff", "#ffd23f", "#ff6bd6", "#7ee787", "#ff8c5a", "#c78bff", "#5ad1c9", "#ff5a7a"];

export function colorForIndex(index: number): string {
  return NOTEBOOK_PALETTE[((index % NOTEBOOK_PALETTE.length) + NOTEBOOK_PALETTE.length) % NOTEBOOK_PALETTE.length]!;
}

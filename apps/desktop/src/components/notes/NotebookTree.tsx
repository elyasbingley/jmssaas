import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createNoteNotebookSchema, type NoteNotebook } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { ThemedModal } from "../theme/ThemedModal";
import { ThemedButton } from "../theme/ThemedButton";
import { ThemedFormField } from "../theme/ThemedFormField";
import { NOTEBOOKS_KEY } from "./notesData";

interface TreeNode {
  notebook: NoteNotebook;
  children: TreeNode[];
}

function buildTree(notebooks: NoteNotebook[]): TreeNode[] {
  const byParent = new Map<string | null, NoteNotebook[]>();
  for (const nb of notebooks) {
    const list = byParent.get(nb.parent_id) ?? [];
    list.push(nb);
    byParent.set(nb.parent_id, list);
  }
  const build = (parentId: string | null): TreeNode[] => (byParent.get(parentId) ?? []).map((notebook) => ({ notebook, children: build(notebook.id) }));
  return build(null);
}

export function NotebookTree({
  notebooks,
  noteCountByNotebook,
  selectedId,
  onSelect,
}: {
  notebooks: NoteNotebook[];
  noteCountByNotebook: Map<string, number>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const tree = useMemo(() => buildTree(notebooks), [notebooks]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(notebooks.map((n) => n.id)));

  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [parentId, setParentId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openCreate = (forParentId: string | null) => {
    setEditId(null);
    setParentId(forParentId);
    setName("");
    setError(null);
    setModalOpen(true);
  };

  const openRename = (notebook: NoteNotebook) => {
    setEditId(notebook.id);
    setParentId(notebook.parent_id);
    setName(notebook.name);
    setError(null);
    setModalOpen(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      if (editId) {
        const { error: dbError } = await supabase.from("note_notebooks").update({ name }).eq("id", editId);
        if (dbError) throw dbError;
        return;
      }
      const result = createNoteNotebookSchema.safeParse({ name, parent_id: parentId ?? undefined });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid notebook");
      const { error: dbError } = await supabase.from("note_notebooks").insert({
        tenant_id: profile.tenant_id,
        name: result.data.name,
        parent_id: result.data.parent_id ?? null,
        created_by: profile.id,
      });
      if (dbError) throw dbError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NOTEBOOKS_KEY });
      setModalOpen(false);
    },
    onError: (e) => setError(getErrorMessage(e, "Failed to save notebook")),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error: dbError } = await supabase.from("note_notebooks").delete().eq("id", id);
      if (dbError) throw dbError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NOTEBOOKS_KEY });
      queryClient.invalidateQueries({ queryKey: ["notes-index"] });
      if (selectedId) onSelect(null);
    },
  });

  const renderNode = (node: TreeNode, depth: number) => {
    const isExpanded = expanded.has(node.notebook.id);
    const count = noteCountByNotebook.get(node.notebook.id) ?? 0;
    return (
      <div key={node.notebook.id}>
        <div
          className="jms-nav-link group flex items-center gap-1 rounded px-1 py-1"
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          {node.children.length > 0 ? (
            <button onClick={() => toggle(node.notebook.id)} className="w-4 flex-shrink-0 text-left" style={{ color: "var(--jms-text-muted)" }}>
              {isExpanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="w-4 flex-shrink-0" />
          )}
          <button
            onClick={() => onSelect(node.notebook.id)}
            className={`min-w-0 flex-1 truncate text-left font-semibold ${selectedId === node.notebook.id ? "jms-nav-link-active" : ""}`}
            style={{ fontSize: "var(--jms-font-body)" }}
          >
            {node.notebook.name}
            <span className="ml-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              {count}
            </span>
          </button>
          <button onClick={() => openCreate(node.notebook.id)} title="New sub-notebook" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            +
          </button>
          <button onClick={() => openRename(node.notebook)} title="Rename" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {"✎"}
          </button>
          <button
            onClick={() => {
              if (window.confirm(`Delete "${node.notebook.name}"? Sub-notebooks are deleted too; notes inside become unfiled.`)) remove.mutate(node.notebook.id);
            }}
            title="Delete"
            style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}
          >
            {"✕"}
          </button>
        </div>
        {isExpanded ? node.children.map((child) => renderNode(child, depth + 1)) : null}
      </div>
    );
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="uppercase tracking-widest" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Notebooks
        </p>
        <button onClick={() => openCreate(null)} className="font-semibold" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          + New
        </button>
      </div>
      <button
        onClick={() => onSelect(null)}
        className={`jms-nav-link mb-1 w-full rounded px-2 py-1 text-left font-semibold ${selectedId === null ? "jms-nav-link-active" : ""}`}
        style={{ fontSize: "var(--jms-font-body)" }}
      >
        All notes
      </button>
      {tree.map((node) => renderNode(node, 0))}

      <ThemedModal open={modalOpen} onClose={() => setModalOpen(false)} title={editId ? "Rename notebook" : "New notebook"}>
        <ThemedFormField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SOPs" />
        {error ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
            {save.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}

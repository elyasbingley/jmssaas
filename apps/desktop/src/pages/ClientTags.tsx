import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createClientTagSchema, type ClientTag } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField } from "../components/theme/ThemedFormField";

// Admin-managed list of tags a client can carry (Clients page, Client
// Detail's own Tags section, and the SMS/WhatsApp broadcast recipient
// filters all read from this same list). Same shape/pattern as Job
// Setup's Service Categories - a plain name + optional hex colour, no
// ordering. Deliberately separate from clients.marketing_opt_out (the
// Spam Act opt-out flag) - see the client_tags migration's own comment
// on why that stays its own protected thing rather than a tag here.

async function fetchTags(): Promise<ClientTag[]> {
  const { data, error } = await supabase.from("client_tags").select("*").order("name");
  if (error) throw error;
  return data as ClientTag[];
}

export default function ClientTagsPage() {
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const { data: tags, isLoading } = useQuery({ queryKey: ["client-tags"], queryFn: fetchTags });

  const [modalOpen, setModalOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<ClientTag | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const openNew = () => {
    setEditingTag(null);
    setName("");
    setColor("");
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (tag: ClientTag) => {
    setEditingTag(tag);
    setName(tag.name);
    setColor(tag.color ?? "");
    setFormError(null);
    setModalOpen(true);
  };

  const saveTag = useMutation({
    mutationFn: async () => {
      const result = createClientTagSchema.safeParse({ name, color: color || undefined });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid tag");
      if (!profile) throw new Error("Not signed in");

      if (editingTag) {
        const { error } = await supabase
          .from("client_tags")
          .update({ name: result.data.name, color: result.data.color || null })
          .eq("id", editingTag.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("client_tags")
          .insert({ tenant_id: profile.tenant_id, name: result.data.name, color: result.data.color || null });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-tags"] });
      setModalOpen(false);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to save tag")),
  });

  const deleteTag = useMutation({
    mutationFn: async (tag: ClientTag) => {
      const { error } = await supabase.from("client_tags").delete().eq("id", tag.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["client-tags"] }),
  });

  const handleDelete = (tag: ClientTag) => {
    if (window.confirm(`Delete the "${tag.name}" tag? It'll be removed from every client that has it.`)) {
      deleteTag.mutate(tag);
    }
  };

  return (
    <div className="mx-auto max-w-2xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Settings
      </Link>
      <h1 className="mb-1 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Client Tags
      </h1>
      <p className="mb-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Customisable labels for clients - apply from a client's card, filter by them on the Clients page and when picking SMS/WhatsApp broadcast recipients.
      </p>

      {!isAdmin ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Only an admin can manage tags.</p>
      ) : (
        <>
          <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
            {isLoading ? (
              <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                Loading...
              </p>
            ) : !tags || tags.length === 0 ? (
              <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                No tags yet.
              </p>
            ) : (
              tags.map((tag) => (
                <div
                  key={tag.id}
                  className="flex items-center justify-between gap-3 px-4 py-3 last:border-0"
                  style={{ borderBottom: "1px solid var(--jms-border)" }}
                >
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ backgroundColor: tag.color ?? "var(--jms-border)" }} />
                    <span className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                      {tag.name}
                    </span>
                  </div>
                  <div className="flex shrink-0 gap-3">
                    <button onClick={() => openEdit(tag)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                      Edit
                    </button>
                    <button onClick={() => handleDelete(tag)} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="mt-3">
            <ThemedButton onClick={openNew} className="w-full">
              + New tag
            </ThemedButton>
          </div>
        </>
      )}

      <ThemedModal open={modalOpen} onClose={() => setModalOpen(false)} title={editingTag ? "Edit tag" : "New tag"}>
        <ThemedFormField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. VIP, Landlord, Roof only" />
        <ThemedFormField label="Color (optional hex, e.g. #1d4ed8)" value={color} onChange={(e) => setColor(e.target.value)} placeholder="#1d4ed8" />
        {formError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {formError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveTag.mutate()} disabled={saveTag.isPending}>
            {saveTag.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}

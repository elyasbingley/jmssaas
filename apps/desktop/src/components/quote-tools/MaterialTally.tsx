import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createJobMaterialTallySchema, type MaterialTallyItem } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { FormField } from "../FormField";

// On-Site Material Tally Engine - a walkthrough counter for tallying
// items as you move through a site (downlights, outlets, smoke alarms).
// Every row is independent (add/adjust/delete any of them at any time, no
// page refresh) - matches ordinary counter apps, not a form with a fixed
// field set. Large +/- steppers (44px) per spec, since this is meant to
// be usable one-handed while walking a site, on a phone/tablet-sized
// desktop browser window as much as a full monitor.

export function MaterialTally({ jobCardId, onTransferToOrder }: { jobCardId: string; onTransferToOrder: (items: MaterialTallyItem[]) => void }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const [tallyName, setTallyName] = useState("");
  const [items, setItems] = useState<MaterialTallyItem[]>([]);
  const [newItemName, setNewItemName] = useState("");

  const handleAddItem = () => {
    if (!newItemName.trim()) return;
    setItems((prev) => [...prev, { id: crypto.randomUUID(), name: newItemName.trim(), count: 1, category: "" }]);
    setNewItemName("");
  };
  const handleAdjust = (itemId: string, delta: number) => {
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, count: Math.max(0, i.count + delta) } : i)));
  };
  const handleDelete = (itemId: string) => setItems((prev) => prev.filter((i) => i.id !== itemId));

  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const saveToNotes = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const result = createJobMaterialTallySchema.safeParse({ job_card_id: jobCardId, tally_name: tallyName || undefined, items });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Add at least one item first");

      const { error: tallyError } = await supabase.from("job_material_tallies").insert({
        tenant_id: profile.tenant_id,
        job_card_id: jobCardId,
        tally_name: result.data.tally_name || null,
        items: result.data.items,
        saved_to_notes: true,
        created_by: profile.id,
      });
      if (tallyError) throw tallyError;

      const heading = result.data.tally_name ? `📋 Material Site Tally (${result.data.tally_name}):` : "📋 Material Site Tally:";
      const lines = [heading, ...result.data.items.map((i) => `- ${i.name}: ${i.count}`)];
      const { error: noteError } = await supabase.from("job_notes").insert({
        tenant_id: profile.tenant_id,
        job_card_id: jobCardId,
        author_id: profile.id,
        body: lines.join("\n"),
      });
      if (noteError) throw noteError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-notes", jobCardId] });
      setSaveError(null);
      setSavedMessage("Tally saved to Job Notes.");
      setTimeout(() => setSavedMessage(null), 4000);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save tally")),
  });

  return (
    <div>
      <FormField label="Tally name (optional)" placeholder='e.g. "Ground Floor Electrical Walkthrough"' value={tallyName} onChange={(e) => setTallyName(e.target.value)} />

      <div className="mt-3 mb-3 flex gap-2">
        <input
          type="text"
          placeholder="+ Material name..."
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAddItem()}
          className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        <button onClick={handleAddItem} disabled={!newItemName.trim()} className="flex-shrink-0 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60">
          + Create New Material
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-gray-500">No materials added yet - start typing above.</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-3 rounded-lg border border-gray-200 p-2">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900" title={item.name}>
                {item.name}
              </span>
              <div className="flex flex-shrink-0 items-center gap-2">
                <button
                  onClick={() => handleAdjust(item.id, -1)}
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-gray-100 text-lg font-bold text-gray-700 hover:bg-gray-200"
                >
                  -
                </button>
                <span className="w-8 text-center text-base font-bold text-gray-900">{item.count}</span>
                <button
                  onClick={() => handleAdjust(item.id, 1)}
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-blue-700 text-lg font-bold text-white hover:bg-blue-800"
                >
                  +
                </button>
              </div>
              <button onClick={() => handleDelete(item.id)} className="flex-shrink-0 text-xs font-semibold text-red-600 hover:underline">
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {saveError ? <p className="mt-3 text-sm text-red-600">{saveError}</p> : null}
      {savedMessage ? <p className="mt-3 text-sm text-green-700">{savedMessage}</p> : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={() => saveToNotes.mutate()}
          disabled={saveToNotes.isPending || items.length === 0}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {saveToNotes.isPending ? "Saving..." : "Save Tally to Job Notes"}
        </button>
        <button
          onClick={() => onTransferToOrder(items)}
          disabled={items.length === 0}
          className="rounded-md border border-blue-700 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-60"
        >
          Transfer to Material Order Form
        </button>
      </div>
    </div>
  );
}

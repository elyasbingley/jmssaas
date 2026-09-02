import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createLineItemBundleSchema, type LineItemBundle } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField } from "../components/FormField";

// List of pre-built line-item bundles (e.g. "Hot Water System Replacement")
// - each one's member items are managed on its own detail page (BundleDetail.tsx),
// same list -> detail split as Price Book's categories -> items.

async function fetchBundles(): Promise<(LineItemBundle & { item_count: number })[]> {
  const { data, error } = await supabase
    .from("line_item_bundles")
    .select("*, line_item_bundle_items(count)")
    .order("sort_order")
    .order("name");
  if (error) throw error;
  return ((data ?? []) as (LineItemBundle & { line_item_bundle_items: { count: number }[] })[]).map((row) => ({
    ...row,
    item_count: row.line_item_bundle_items?.[0]?.count ?? 0,
  }));
}

export default function BundlesPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data: bundles, isLoading } = useQuery({ queryKey: ["line-item-bundles"], queryFn: fetchBundles });

  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const createBundle = useMutation({
    mutationFn: async () => {
      const result = createLineItemBundleSchema.safeParse({ name, sort_order: bundles?.length ?? 0 });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid bundle");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("line_item_bundles").insert({ ...result.data, tenant_id: profile.tenant_id });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["line-item-bundles"] });
      setModalOpen(false);
      setName("");
      setFormError(null);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to create bundle")),
  });

  return (
    <div className="mx-auto max-w-2xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Bundles</h1>
          <p className="text-sm text-gray-500">Pre-built sets of line items - add them all to a quote/invoice in one click.</p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + New bundle
        </button>
      </div>

      <div className="divide-y divide-gray-100 rounded-lg border border-gray-300 bg-white">
        {isLoading ? (
          <p className="p-4 text-sm text-gray-500">Loading...</p>
        ) : !bundles || bundles.length === 0 ? (
          <p className="p-4 text-sm text-gray-500">No bundles yet.</p>
        ) : (
          bundles.map((bundle) => (
            <Link key={bundle.id} to={`/settings/bundles/${bundle.id}`} className="flex items-center justify-between gap-3 p-3 hover:bg-gray-50">
              <span className="text-sm font-semibold text-gray-900">{bundle.name}</span>
              <span className="flex-shrink-0 text-xs text-gray-500">
                {bundle.item_count} item{bundle.item_count === 1 ? "" : "s"}
              </span>
            </Link>
          ))
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New bundle">
        <FormField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hot Water System Replacement" />
        {formError ? <p className="mb-4 text-sm text-red-600">{formError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createBundle.mutate()}
            disabled={createBundle.isPending || !name.trim()}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createBundle.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

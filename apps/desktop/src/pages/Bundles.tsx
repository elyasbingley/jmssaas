import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createLineItemBundleSchema, type LineItemBundle } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField } from "../components/theme/ThemedFormField";

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
    <div className="mx-auto max-w-2xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Settings
      </Link>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            Bundles
          </h1>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Pre-built sets of line items - add them all to a quote/invoice in one click.
          </p>
        </div>
        <ThemedButton onClick={() => setModalOpen(true)}>+ New bundle</ThemedButton>
      </div>

      <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {isLoading ? (
          <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Loading...
          </p>
        ) : !bundles || bundles.length === 0 ? (
          <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No bundles yet.
          </p>
        ) : (
          bundles.map((bundle) => (
            <Link
              key={bundle.id}
              to={`/settings/bundles/${bundle.id}`}
              className="jms-nav-link flex items-center justify-between gap-3 p-3 last:border-0"
              style={{ borderBottom: "1px solid var(--jms-border)" }}
            >
              <span className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                {bundle.name}
              </span>
              <span className="flex-shrink-0" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                {bundle.item_count} item{bundle.item_count === 1 ? "" : "s"}
              </span>
            </Link>
          ))
        )}
      </div>

      <ThemedModal open={modalOpen} onClose={() => setModalOpen(false)} title="New bundle">
        <ThemedFormField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hot Water System Replacement" />
        {formError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {formError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => createBundle.mutate()} disabled={createBundle.isPending || !name.trim()}>
            {createBundle.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}

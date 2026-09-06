import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "./Modal";
import { FormField } from "./FormField";

// Single-purpose editor for quotes.po_number / invoices.po_number - same
// shape as WorkOrderNumberModal, but writes to the quote/invoice row
// itself (its own column, unlike work_order_number which lives on the
// linked job_card) since a client's PO reference is independent per
// document and applies to every client, not just real estate/strata jobs.
export function PurchaseOrderNumberModal({
  open,
  onClose,
  table,
  recordId,
  currentValue,
}: {
  open: boolean;
  onClose: () => void;
  table: "quotes" | "invoices";
  recordId: string;
  currentValue: string | null;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue(currentValue ?? "");
      setError(null);
    }
  }, [open, currentValue]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from(table).update({ po_number: value.trim() || null }).eq("id", recordId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [table === "quotes" ? "quote" : "invoice", recordId] });
      onClose();
    },
    onError: (e) => setError(getErrorMessage(e, "Failed to save PO number")),
  });

  return (
    <Modal open={open} onClose={onClose} title="Purchase order number">
      <FormField label="PO number" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. PO-4821" />
      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}
      <div className="flex justify-end gap-3">
        <button onClick={onClose} className="px-4 py-2 text-sm font-semibold text-gray-600">
          Cancel
        </button>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {save.isPending ? "Saving..." : "Save"}
        </button>
      </div>
    </Modal>
  );
}

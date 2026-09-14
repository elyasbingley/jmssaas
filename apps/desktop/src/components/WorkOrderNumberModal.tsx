import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "./Modal";
import { FormField } from "./FormField";

// A single-purpose, one-field editor for job_cards.work_order_number -
// deliberately separate from RealEstateAssignmentModal's full Agency/PM/
// Property picker, which is the right tool for actually (re)assigning a
// job to an agency but overkill for "the PM just texted me the work order
// number, let me type it in" - the single most common edit once a job is
// already correctly assigned. Same WorkDrive-link-modal pattern (a lone
// text field + Save) already used elsewhere on JobDetail.tsx. Mounted on
// JobDetail.tsx (writes to the job itself) and QuoteDetail.tsx/
// InvoiceDetail.tsx (write to the job linked via job_card_id) - a quote
// or invoice has no work order number of its own, it's always the job's.
export function WorkOrderNumberModal({
  open,
  onClose,
  jobCardId,
  currentValue,
  invalidateKeys,
}: {
  open: boolean;
  onClose: () => void;
  jobCardId: string;
  currentValue: string | null;
  // Query keys to invalidate on save, beyond ["job", jobCardId] and
  // ["jobs"] (always invalidated) - e.g. ["quote", quoteId] or
  // ["invoice", invoiceId] so the page that opened this modal picks up
  // the change immediately via its own join.
  invalidateKeys?: (string | undefined)[][];
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
      const { error } = await supabase.from("job_cards").update({ work_order_number: value.trim() || null }).eq("id", jobCardId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job", jobCardId] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      for (const key of invalidateKeys ?? []) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      onClose();
    },
    onError: (e) => setError(getErrorMessage(e, "Failed to save work order number")),
  });

  return (
    <Modal open={open} onClose={onClose} title="Work order number">
      <FormField label="Work order number" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. WO-4821" />
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

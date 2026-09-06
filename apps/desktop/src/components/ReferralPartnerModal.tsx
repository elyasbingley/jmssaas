import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReferralPartner } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "./Modal";
import { SelectField } from "./FormField";

async function fetchActiveReferralPartners(): Promise<ReferralPartner[]> {
  const { data, error } = await supabase
    .from("referral_partners")
    .select("*")
    .eq("status", "active")
    .order("contact_first_name");
  if (error) throw error;
  return data as ReferralPartner[];
}

export function referralPartnerLabel(p: Pick<ReferralPartner, "company_name" | "contact_first_name" | "contact_last_name">): string {
  const contact = [p.contact_first_name, p.contact_last_name].filter(Boolean).join(" ");
  return p.company_name ? `${p.company_name} (${contact})` : contact;
}

// Single-purpose referral-source editor, same shape as WorkOrderNumberModal
// (a one-field editor mountable from job/quote/invoice detail pages) rather
// than folded into any of those pages' own bigger edit forms. `table` picks
// which row actually owns the field being written: job_cards and quotes
// each carry their own independent referral_partner_id column (see the
// b2b_referral_tracking migration); invoices have no column of their own,
// so InvoiceDetail.tsx passes table="job_cards" with the linked job's id -
// same as how it edits work_order_number through the job it's for.
export function ReferralPartnerModal({
  open,
  onClose,
  table,
  recordId,
  currentValue,
  invalidateKeys,
}: {
  open: boolean;
  onClose: () => void;
  table: "job_cards" | "quotes";
  recordId: string;
  currentValue: string | null;
  invalidateKeys?: (string | undefined)[][];
}) {
  const queryClient = useQueryClient();
  const { data: partners } = useQuery({ queryKey: ["referral-partners", "active"], queryFn: fetchActiveReferralPartners, enabled: open });
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
      const { error } = await supabase
        .from(table)
        .update({ referral_partner_id: value || null })
        .eq("id", recordId);
      if (error) throw error;
    },
    onSuccess: () => {
      const recordKey = table === "job_cards" ? "job" : "quote";
      queryClient.invalidateQueries({ queryKey: [recordKey, recordId] });
      queryClient.invalidateQueries({ queryKey: [table === "job_cards" ? "jobs" : "quotes"] });
      for (const key of invalidateKeys ?? []) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      onClose();
    },
    onError: (e) => setError(getErrorMessage(e, "Failed to save referral source")),
  });

  return (
    <Modal open={open} onClose={onClose} title="Referral source">
      <SelectField
        label="Referral partner"
        value={value}
        onChange={setValue}
        options={(partners ?? []).map((p) => ({ value: p.id, label: referralPartnerLabel(p) }))}
        placeholder="None"
      />
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

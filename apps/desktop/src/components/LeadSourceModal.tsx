import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type LeadSource, type ReferralPartner } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "./Modal";
import { SelectField } from "./FormField";

async function fetchLeadSources(): Promise<LeadSource[]> {
  const { data, error } = await supabase.from("lead_sources").select("*").order("sort_order");
  if (error) throw error;
  return data as LeadSource[];
}
async function fetchActiveReferralPartners(): Promise<ReferralPartner[]> {
  const { data, error } = await supabase.from("referral_partners").select("*").eq("status", "active").order("contact_first_name");
  if (error) throw error;
  return data as ReferralPartner[];
}

export function referralPartnerLabel(p: Pick<ReferralPartner, "company_name" | "contact_first_name" | "contact_last_name">): string {
  const contact = [p.contact_first_name, p.contact_last_name].filter(Boolean).join(" ");
  return p.company_name ? `${p.company_name} (${contact})` : contact;
}

// job_cards-only editor (Lead Source is scoped to jobs, not quotes/clients -
// see the lead_sources migration's own comment). Subsumes the old standalone
// "Referral source" edit action on JobDetail.tsx: choosing a lead source
// flagged is_referral_source reveals the referral-partner picker right here,
// and both columns save together in one update - "if we choose referral
// from the dropdown then we can link the referral partner" in one motion,
// rather than two separate edits.
export function LeadSourceModal({
  open,
  onClose,
  jobCardId,
  currentLeadSourceId,
  currentReferralPartnerId,
}: {
  open: boolean;
  onClose: () => void;
  jobCardId: string;
  currentLeadSourceId: string | null;
  currentReferralPartnerId: string | null;
}) {
  const queryClient = useQueryClient();
  const { data: leadSources } = useQuery({ queryKey: ["lead-sources"], queryFn: fetchLeadSources, enabled: open });
  const { data: partners } = useQuery({ queryKey: ["referral-partners", "active"], queryFn: fetchActiveReferralPartners, enabled: open });
  const [leadSourceId, setLeadSourceId] = useState("");
  const [referralPartnerId, setReferralPartnerId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setLeadSourceId(currentLeadSourceId ?? "");
      setReferralPartnerId(currentReferralPartnerId ?? "");
      setError(null);
    }
  }, [open, currentLeadSourceId, currentReferralPartnerId]);

  const selectedLeadSource = (leadSources ?? []).find((s) => s.id === leadSourceId);
  const isReferral = selectedLeadSource?.is_referral_source ?? false;

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("job_cards")
        .update({
          lead_source_id: leadSourceId || null,
          // Only ever persisted when the chosen lead source is actually the
          // referral one - switching away from it silently clears a
          // previously-linked partner rather than leaving it dangling.
          referral_partner_id: isReferral ? referralPartnerId || null : null,
        })
        .eq("id", jobCardId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job", jobCardId] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      onClose();
    },
    onError: (e) => setError(getErrorMessage(e, "Failed to save lead source")),
  });

  return (
    <Modal open={open} onClose={onClose} title="Lead source">
      <SelectField
        label="Lead source"
        value={leadSourceId}
        onChange={setLeadSourceId}
        options={(leadSources ?? []).map((s) => ({ value: s.id, label: s.name }))}
        placeholder="None"
      />
      {isReferral ? (
        <SelectField
          label="Referral partner"
          value={referralPartnerId}
          onChange={setReferralPartnerId}
          options={(partners ?? []).map((p) => ({ value: p.id, label: referralPartnerLabel(p) }))}
          placeholder="None"
        />
      ) : null}
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

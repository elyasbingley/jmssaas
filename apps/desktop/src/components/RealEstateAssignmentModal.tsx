import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { updateJobRealEstateAssignmentSchema, type Agency, type Property, type PropertyManager } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "./Modal";
import { FormField, SelectField } from "./FormField";

async function fetchAgencies(): Promise<Agency[]> {
  const { data, error } = await supabase.from("agencies").select("*").order("name");
  if (error) throw error;
  return data as Agency[];
}
async function fetchPropertyManagers(): Promise<PropertyManager[]> {
  const { data, error } = await supabase.from("property_managers").select("*").order("first_name");
  if (error) throw error;
  return data as PropertyManager[];
}
async function fetchProperties(): Promise<Property[]> {
  const { data, error } = await supabase.from("properties").select("*").order("suburb");
  if (error) throw error;
  return data as Property[];
}

export interface RealEstateAssignment {
  is_real_estate_job: boolean;
  agency_id: string | null;
  property_manager_id: string | null;
  property_id: string | null;
  work_order_number: string | null;
  nte_limit_cents: number | null;
}

// Retrofits an EXISTING job with (or removes it from) real-estate/strata
// agency assignment - the "New job" form (Jobs.tsx) was previously the
// only place these fields could ever be set, with no way back in later if
// a work order surfaces after the job was created as an ordinary job, or
// the wrong agency/PM/property was picked at the time. Mounted from
// JobDetail.tsx (writes straight to the job), and from QuoteDetail.tsx/
// InvoiceDetail.tsx (write to the job linked via job_card_id) - a quote or
// invoice has no real-estate fields of its own, so both just point this
// same control at their underlying job_cards row. Same cascading Agency ->
// PM -> Property picker as Jobs.tsx's "New job" form, for consistency.
export function RealEstateAssignmentModal({
  open,
  onClose,
  jobCardId,
  initial,
  invalidateKeys,
}: {
  open: boolean;
  onClose: () => void;
  jobCardId: string;
  initial: RealEstateAssignment;
  // Query keys to invalidate on save, beyond ["job", jobCardId] and
  // ["jobs"] (always invalidated) - e.g. ["quote", quoteId] or
  // ["invoice", invoiceId] so the page that opened this modal picks up
  // the change immediately via its own join, without a manual refetch.
  invalidateKeys?: (string | undefined)[][];
}) {
  const queryClient = useQueryClient();
  const { data: agencies } = useQuery({ queryKey: ["agencies"], queryFn: fetchAgencies, enabled: open });
  const { data: propertyManagers } = useQuery({ queryKey: ["property-managers"], queryFn: fetchPropertyManagers, enabled: open });
  const { data: properties } = useQuery({ queryKey: ["properties"], queryFn: fetchProperties, enabled: open });

  const [isRealEstateJob, setIsRealEstateJob] = useState(false);
  const [agencyId, setAgencyId] = useState("");
  const [propertyManagerId, setPropertyManagerId] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [workOrderNumber, setWorkOrderNumber] = useState("");
  const [nteLimit, setNteLimit] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setIsRealEstateJob(initial.is_real_estate_job);
      setAgencyId(initial.agency_id ?? "");
      setPropertyManagerId(initial.property_manager_id ?? "");
      setPropertyId(initial.property_id ?? "");
      setWorkOrderNumber(initial.work_order_number ?? "");
      setNteLimit(initial.nte_limit_cents != null ? String(initial.nte_limit_cents / 100) : "");
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pmsForAgency = (propertyManagers ?? []).filter((pm) => pm.agency_id === agencyId);
  const propertiesForPm = (properties ?? []).filter((p) => (propertyManagerId ? p.property_manager_id === propertyManagerId : p.agency_id === agencyId));

  const save = useMutation({
    mutationFn: async () => {
      const result = updateJobRealEstateAssignmentSchema.safeParse({
        is_real_estate_job: isRealEstateJob,
        agency_id: isRealEstateJob ? agencyId || undefined : undefined,
        property_manager_id: isRealEstateJob ? propertyManagerId || undefined : undefined,
        property_id: isRealEstateJob ? propertyId || undefined : undefined,
        work_order_number: isRealEstateJob ? workOrderNumber || undefined : undefined,
        nte_limit_cents: isRealEstateJob && nteLimit.trim() ? Math.round(Number(nteLimit) * 100) : undefined,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid details");
      if (result.data.is_real_estate_job && !result.data.agency_id) throw new Error("Pick an agency");

      const { error } = await supabase
        .from("job_cards")
        .update({
          is_real_estate_job: result.data.is_real_estate_job,
          agency_id: result.data.agency_id || null,
          property_manager_id: result.data.property_manager_id || null,
          property_id: result.data.property_id || null,
          work_order_number: result.data.work_order_number || null,
          nte_limit_cents: result.data.nte_limit_cents ?? null,
        })
        .eq("id", jobCardId);
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
    onError: (e) => setError(getErrorMessage(e, "Failed to update")),
  });

  return (
    <Modal open={open} onClose={onClose} title="Real estate / strata assignment">
      <label className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-700">
        <input type="checkbox" checked={isRealEstateJob} onChange={(e) => setIsRealEstateJob(e.target.checked)} />
        This is a real estate / strata agency job
      </label>

      {isRealEstateJob ? (
        <div className="mb-2 rounded-md bg-gray-50 p-3">
          <SelectField
            label="Agency"
            value={agencyId}
            onChange={(v) => {
              setAgencyId(v);
              setPropertyManagerId("");
              setPropertyId("");
            }}
            options={(agencies ?? []).map((a) => ({ value: a.id, label: a.name }))}
            placeholder="Select agency"
          />
          <SelectField
            label="Property manager"
            value={propertyManagerId}
            onChange={(v) => {
              setPropertyManagerId(v);
              setPropertyId("");
            }}
            options={pmsForAgency.map((pm) => ({ value: pm.id, label: `${pm.first_name} ${pm.last_name}` }))}
            placeholder="Select property manager"
          />
          <SelectField
            label="Property"
            value={propertyId}
            onChange={setPropertyId}
            options={propertiesForPm.map((p) => ({ value: p.id, label: `${p.address_line1}, ${p.suburb}` }))}
            placeholder="Select property"
          />
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Work order number" value={workOrderNumber} onChange={(e) => setWorkOrderNumber(e.target.value)} />
            <FormField
              label="NTE limit ($)"
              type="number"
              step="0.01"
              value={nteLimit}
              onChange={(e) => setNteLimit(e.target.value)}
              placeholder="e.g. 300.00"
            />
          </div>
        </div>
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

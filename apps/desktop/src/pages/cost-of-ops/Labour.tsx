import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  calculateLabour,
  createLabourCostEntrySchema,
  formatCentsAsAud,
  type CostOfOpsPayType,
  type CostOfOpsRoleType,
  type CostOfOpsSettings,
  type LabourCostEntry,
  type Profile,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { getErrorMessage } from "../../lib/errors";
import { Modal } from "../../components/Modal";
import { FormField, SelectField } from "../../components/FormField";

async function fetchSettings(): Promise<CostOfOpsSettings> {
  const { data, error } = await supabase.from("cost_of_ops_settings").select("*").single();
  if (error) throw error;
  return data as CostOfOpsSettings;
}
async function fetchLabour(): Promise<LabourCostEntry[]> {
  const { data, error } = await supabase.from("labour_cost_entries").select("*").order("sort_order");
  if (error) throw error;
  return data as LabourCostEntry[];
}
async function fetchProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").order("full_name");
  if (error) throw error;
  return data as Profile[];
}

const ROLE_OPTIONS: { value: CostOfOpsRoleType; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "field_staff", label: "Field Staff" },
  { value: "apprentice", label: "Apprentice" },
  { value: "admin", label: "Admin" },
  { value: "subcontractor", label: "Subcontractor" },
];

function entryDisplayName(entry: LabourCostEntry, profileById: Map<string, Profile>): string {
  if (entry.profile_id) return profileById.get(entry.profile_id)?.full_name ?? entry.name ?? "Unnamed";
  return entry.name ?? "Unnamed";
}

const emptyForm = {
  role_type: "field_staff" as CostOfOpsRoleType,
  profile_id: "",
  name: "",
  annual_salary: "",
  superannuation_flat: "",
  hourly_rate: "",
  superannuation_rate: "",
  allowance: "",
  billable_hours: "0",
  non_billable_hours: "0",
  apprentice_utilisation: "100",
  subcontractor_charge_out_rate: "",
  subcontractor_travel_allow: "",
};

export default function LabourPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["cost-of-ops-settings"], queryFn: fetchSettings });
  const { data: labour } = useQuery({ queryKey: ["labour-cost-entries"], queryFn: fetchLabour });
  const { data: profiles } = useQuery({ queryKey: ["profiles"], queryFn: fetchProfiles });
  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

  const result = settings && labour ? calculateLabour(labour, settings) : null;

  const [modalOpen, setModalOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<LabourCostEntry | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const openNew = () => {
    setEditingEntry(null);
    setForm(emptyForm);
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (entry: LabourCostEntry) => {
    setEditingEntry(entry);
    setForm({
      role_type: entry.role_type,
      profile_id: entry.profile_id ?? "",
      name: entry.name ?? "",
      annual_salary: entry.annual_salary_cents ? (entry.annual_salary_cents / 100).toString() : "",
      superannuation_flat: entry.superannuation_cents ? (entry.superannuation_cents / 100).toString() : "",
      hourly_rate: entry.hourly_rate_cents ? (entry.hourly_rate_cents / 100).toString() : "",
      superannuation_rate: entry.superannuation_rate ? (entry.superannuation_rate * 100).toString() : "",
      allowance: entry.allowance_cents ? (entry.allowance_cents / 100).toString() : "",
      billable_hours: String(entry.billable_hours_per_week),
      non_billable_hours: String(entry.non_billable_hours_per_week),
      apprentice_utilisation: entry.apprentice_utilisation != null ? (entry.apprentice_utilisation * 100).toString() : "100",
      subcontractor_charge_out_rate: entry.subcontractor_charge_out_rate_cents ? (entry.subcontractor_charge_out_rate_cents / 100).toString() : "",
      subcontractor_travel_allow: entry.subcontractor_travel_allow_cents ? (entry.subcontractor_travel_allow_cents / 100).toString() : "",
    });
    setFormError(null);
    setModalOpen(true);
  };

  const saveEntry = useMutation({
    mutationFn: async () => {
      if (!settings) throw new Error("Settings not loaded");
      const payType: CostOfOpsPayType = form.role_type === "owner" ? "salary" : "hourly";
      const result = createLabourCostEntrySchema.safeParse({
        role_type: form.role_type,
        profile_id: form.profile_id || undefined,
        name: form.name || undefined,
        pay_type: payType,
        annual_salary_cents: form.annual_salary ? Math.round(Number(form.annual_salary) * 100) : undefined,
        superannuation_cents: form.superannuation_flat ? Math.round(Number(form.superannuation_flat) * 100) : undefined,
        hourly_rate_cents: form.hourly_rate ? Math.round(Number(form.hourly_rate) * 100) : undefined,
        superannuation_rate: form.superannuation_rate ? Number(form.superannuation_rate) / 100 : undefined,
        allowance_cents: form.allowance ? Math.round(Number(form.allowance) * 100) : undefined,
        billable_hours_per_week: Number(form.billable_hours || 0),
        non_billable_hours_per_week: Number(form.non_billable_hours || 0),
        apprentice_utilisation: form.role_type === "apprentice" ? Number(form.apprentice_utilisation || 100) / 100 : undefined,
        subcontractor_charge_out_rate_cents:
          form.role_type === "subcontractor" && form.subcontractor_charge_out_rate ? Math.round(Number(form.subcontractor_charge_out_rate) * 100) : undefined,
        subcontractor_travel_allow_cents:
          form.role_type === "subcontractor" && form.subcontractor_travel_allow ? Math.round(Number(form.subcontractor_travel_allow) * 100) : undefined,
        sort_order: editingEntry?.sort_order ?? (labour?.length ?? 0) + 1,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid entry");

      const payload = {
        role_type: result.data.role_type,
        profile_id: result.data.profile_id || null,
        name: result.data.name || null,
        pay_type: result.data.pay_type,
        annual_salary_cents: result.data.annual_salary_cents ?? null,
        superannuation_cents: result.data.superannuation_cents ?? null,
        hourly_rate_cents: result.data.hourly_rate_cents ?? null,
        superannuation_rate: result.data.superannuation_rate ?? null,
        allowance_cents: result.data.allowance_cents ?? null,
        billable_hours_per_week: result.data.billable_hours_per_week,
        non_billable_hours_per_week: result.data.non_billable_hours_per_week,
        apprentice_utilisation: result.data.apprentice_utilisation ?? null,
        subcontractor_charge_out_rate_cents: result.data.subcontractor_charge_out_rate_cents ?? null,
        subcontractor_travel_allow_cents: result.data.subcontractor_travel_allow_cents ?? null,
      };

      if (editingEntry) {
        const { error } = await supabase.from("labour_cost_entries").update(payload).eq("id", editingEntry.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("labour_cost_entries")
          .insert({ tenant_id: settings.tenant_id, sort_order: result.data.sort_order, ...payload });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labour-cost-entries"] });
      setModalOpen(false);
      setEditingEntry(null);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to save entry")),
  });

  const deleteEntry = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("labour_cost_entries").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["labour-cost-entries"] }),
  });

  const isLoading = !settings || !labour || !result;

  return (
    <div>
      <div className="mb-6 grid grid-cols-4 gap-4">
        <div className="rounded-lg border border-gray-300 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-400">Billable Resources</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{result ? result.billableResources.toFixed(2) : "-"}</p>
        </div>
        <div className="rounded-lg border border-gray-300 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-400">Non-Billable Resources</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{result ? result.nonBillableResources.toFixed(2) : "-"}</p>
        </div>
        <div className="rounded-lg border border-gray-300 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-400">Weekly Labour Cost</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{result ? formatCentsAsAud(result.weeklyLabourCostCents) : "-"}</p>
        </div>
        <div className="rounded-lg border border-gray-300 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-400">Monthly Labour Cost</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{result ? formatCentsAsAud(result.monthlyLabourCostCents) : "-"}</p>
        </div>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Roster</h2>
        <button onClick={openNew} className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800">
          + Add person
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-300 bg-white">
        {isLoading ? (
          <p className="p-6 text-sm text-gray-500">Loading...</p>
        ) : result!.entries.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No one on the roster yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-300 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Name</th>
                <th className="px-4 py-2 font-semibold">Role</th>
                <th className="px-4 py-2 text-right font-semibold">Billable Hrs</th>
                <th className="px-4 py-2 text-right font-semibold">Non-Billable Hrs</th>
                <th className="px-4 py-2 text-right font-semibold">Cost/Hr</th>
                <th className="px-4 py-2 text-right font-semibold">Cost/Week</th>
                <th className="px-4 py-2 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {result!.entries.map(({ entry, costPerHourCents, costPerWeekCents }) => (
                <tr key={entry.id} className="border-b border-gray-200 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium text-gray-900">{entryDisplayName(entry, profileById)}</td>
                  <td className="px-4 py-2 text-gray-600">{ROLE_OPTIONS.find((r) => r.value === entry.role_type)?.label}</td>
                  <td className="px-4 py-2 text-right">{entry.billable_hours_per_week}</td>
                  <td className="px-4 py-2 text-right">{entry.non_billable_hours_per_week}</td>
                  <td className="px-4 py-2 text-right">{formatCentsAsAud(costPerHourCents)}</td>
                  <td className="px-4 py-2 text-right font-semibold">{formatCentsAsAud(costPerWeekCents)}</td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => openEdit(entry)} className="mr-3 text-xs font-semibold text-blue-700 hover:underline">
                      Edit
                    </button>
                    <button onClick={() => deleteEntry.mutate(entry.id)} className="text-xs font-semibold text-red-600 hover:underline">
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingEntry(null);
        }}
        title={editingEntry ? "Edit labour entry" : "Add labour entry"}
      >
        <SelectField
          label="Role"
          value={form.role_type}
          onChange={(v) => setForm({ ...form, role_type: (v || "field_staff") as CostOfOpsRoleType })}
          options={ROLE_OPTIONS}
        />
        {form.role_type !== "subcontractor" ? (
          <SelectField
            label="Linked team member (optional)"
            value={form.profile_id}
            onChange={(v) => setForm({ ...form, profile_id: v })}
            options={(profiles ?? []).map((p) => ({ value: p.id, label: p.full_name }))}
            placeholder="Not linked"
          />
        ) : null}
        {!form.profile_id ? (
          <FormField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        ) : null}

        {form.role_type === "owner" ? (
          <div className="grid grid-cols-2 gap-3">
            <FormField
              label="Annual salary ($)"
              type="number"
              value={form.annual_salary}
              onChange={(e) => setForm({ ...form, annual_salary: e.target.value })}
            />
            <FormField
              label="Superannuation ($/yr, flat)"
              type="number"
              value={form.superannuation_flat}
              onChange={(e) => setForm({ ...form, superannuation_flat: e.target.value })}
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <FormField
              label={form.role_type === "subcontractor" ? "Cost rate ($/hr)" : "Hourly rate ($/hr)"}
              type="number"
              value={form.hourly_rate}
              onChange={(e) => setForm({ ...form, hourly_rate: e.target.value })}
            />
            {form.role_type !== "subcontractor" ? (
              <FormField
                label="Superannuation (% of rate)"
                type="number"
                step="0.1"
                value={form.superannuation_rate}
                onChange={(e) => setForm({ ...form, superannuation_rate: e.target.value })}
              />
            ) : (
              <FormField
                label="Travel allowance ($/week)"
                type="number"
                value={form.subcontractor_travel_allow}
                onChange={(e) => setForm({ ...form, subcontractor_travel_allow: e.target.value })}
              />
            )}
          </div>
        )}

        {form.role_type !== "owner" && form.role_type !== "subcontractor" ? (
          <FormField
            label="Allowance ($/hr)"
            type="number"
            value={form.allowance}
            onChange={(e) => setForm({ ...form, allowance: e.target.value })}
          />
        ) : null}

        {form.role_type === "subcontractor" ? (
          <FormField
            label="Charge-out rate ($/hr, for Quote Checker)"
            type="number"
            value={form.subcontractor_charge_out_rate}
            onChange={(e) => setForm({ ...form, subcontractor_charge_out_rate: e.target.value })}
          />
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Billable hours/week"
            type="number"
            value={form.billable_hours}
            onChange={(e) => setForm({ ...form, billable_hours: e.target.value })}
          />
          <FormField
            label="Non-billable hours/week"
            type="number"
            value={form.non_billable_hours}
            onChange={(e) => setForm({ ...form, non_billable_hours: e.target.value })}
          />
        </div>

        {form.role_type === "apprentice" ? (
          <FormField
            label="Utilisation (% of a full billable resource)"
            type="number"
            value={form.apprentice_utilisation}
            onChange={(e) => setForm({ ...form, apprentice_utilisation: e.target.value })}
          />
        ) : null}

        {formError ? <p className="mb-4 text-sm text-red-600">{formError}</p> : null}
        <div className="flex justify-end gap-3">
          <button
            onClick={() => {
              setModalOpen(false);
              setEditingEntry(null);
            }}
            className="px-4 py-2 text-sm font-semibold text-gray-600"
          >
            Cancel
          </button>
          <button
            onClick={() => saveEntry.mutate()}
            disabled={saveEntry.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveEntry.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

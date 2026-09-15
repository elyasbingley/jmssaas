import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  calculateCostOfOperations,
  calculateLabour,
  calculateOperatingExpenses,
  formatCentsAsAud,
  updateCostOfOpsSettingsSchema,
  type CostOfOpsSettings,
  type LabourCostEntry,
  type OperatingExpense,
  type Profile,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { getErrorMessage } from "../../lib/errors";
import { ThemedModal } from "../../components/theme/ThemedModal";
import { ThemedButton } from "../../components/theme/ThemedButton";
import { ThemedFormField } from "../../components/theme/ThemedFormField";

async function fetchSettings(): Promise<CostOfOpsSettings> {
  const { data, error } = await supabase.from("cost_of_ops_settings").select("*").single();
  if (error) throw error;
  return data as CostOfOpsSettings;
}
async function fetchExpenses(): Promise<OperatingExpense[]> {
  const { data, error } = await supabase.from("operating_expenses").select("*").order("sort_order");
  if (error) throw error;
  return data as OperatingExpense[];
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

function entryDisplayName(entry: LabourCostEntry, profileById: Map<string, Profile>): string {
  if (entry.profile_id) return profileById.get(entry.profile_id)?.full_name ?? entry.name ?? "Unnamed";
  return entry.name ?? "Unnamed";
}

export default function CostOfOperationsPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["cost-of-ops-settings"], queryFn: fetchSettings });
  const { data: expenses } = useQuery({ queryKey: ["operating-expenses"], queryFn: fetchExpenses });
  const { data: labour } = useQuery({ queryKey: ["labour-cost-entries"], queryFn: fetchLabour });
  const { data: profiles } = useQuery({ queryKey: ["profiles"], queryFn: fetchProfiles });
  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

  const isLoading = !settings || !expenses || !labour;
  const opex = settings && expenses ? calculateOperatingExpenses(expenses, settings) : null;
  const labourResult = settings && labour ? calculateLabour(labour, settings) : null;
  const coo = opex && labourResult && settings ? calculateCostOfOperations(opex, labourResult, settings) : null;

  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const [ordinaryHours, setOrdinaryHours] = useState("38");
  const [weekendDays, setWeekendDays] = useState("105");
  const [publicHolidays, setPublicHolidays] = useState("13");
  const [annualLeave, setAnnualLeave] = useState("20");
  const [sickDays, setSickDays] = useState("10");
  const [rainDays, setRainDays] = useState("10");
  const [efficiency, setEfficiency] = useState("80");
  const [assumptionsError, setAssumptionsError] = useState<string | null>(null);

  const openAssumptions = () => {
    if (!settings) return;
    setOrdinaryHours(String(settings.ordinary_hours_per_week));
    setWeekendDays(String(settings.weekend_days_per_year));
    setPublicHolidays(String(settings.public_holidays_per_year));
    setAnnualLeave(String(settings.annual_leave_days));
    setSickDays(String(settings.sick_days));
    setRainDays(String(settings.rain_shutdown_days));
    setEfficiency((settings.estimated_efficiency_rate * 100).toString());
    setAssumptionsError(null);
    setAssumptionsOpen(true);
  };

  const saveAssumptions = useMutation({
    mutationFn: async () => {
      if (!settings) throw new Error("Settings not loaded");
      const parsed = updateCostOfOpsSettingsSchema.safeParse({
        ...settings,
        ordinary_hours_per_week: Number(ordinaryHours || 0),
        weekend_days_per_year: Math.round(Number(weekendDays || 0)),
        public_holidays_per_year: Math.round(Number(publicHolidays || 0)),
        annual_leave_days: Math.round(Number(annualLeave || 0)),
        sick_days: Math.round(Number(sickDays || 0)),
        rain_shutdown_days: Math.round(Number(rainDays || 0)),
        estimated_efficiency_rate: Number(efficiency || 0) / 100,
      });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid settings");
      const { error } = await supabase
        .from("cost_of_ops_settings")
        .update({
          ordinary_hours_per_week: parsed.data.ordinary_hours_per_week,
          weekend_days_per_year: parsed.data.weekend_days_per_year,
          public_holidays_per_year: parsed.data.public_holidays_per_year,
          annual_leave_days: parsed.data.annual_leave_days,
          sick_days: parsed.data.sick_days,
          rain_shutdown_days: parsed.data.rain_shutdown_days,
          estimated_efficiency_rate: parsed.data.estimated_efficiency_rate,
        })
        .eq("id", settings.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cost-of-ops-settings"] });
      setAssumptionsOpen(false);
    },
    onError: (e) => setAssumptionsError(getErrorMessage(e, "Failed to save assumptions")),
  });

  if (isLoading || !coo) {
    return (
      <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)", fontFamily: "var(--jms-font)" }}>Loading...</p>
    );
  }

  return (
    <div style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-6 flex justify-end">
        <ThemedButton variant="secondary" onClick={openAssumptions} style={{ paddingBlock: 6, paddingInline: 12 }}>
          Edit Assumptions
        </ThemedButton>
      </div>

      <div className="mb-6 grid grid-cols-3 gap-4">
        <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Weekly Cost of Operations
          </p>
          <p className="mt-1 text-2xl font-bold" style={{ color: "var(--jms-text)" }}>
            {formatCentsAsAud(coo.weeklyCooRawCents)}
          </p>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {formatCentsAsAud(coo.weeklyCooAdjustedCents)} at estimated efficiency
          </p>
        </div>
        <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Daily Cost of Operations
          </p>
          <p className="mt-1 text-2xl font-bold" style={{ color: "var(--jms-text)" }}>
            {formatCentsAsAud(coo.dailyCooRawCents)}
          </p>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {formatCentsAsAud(coo.dailyCooAdjustedCents)} at estimated efficiency
          </p>
        </div>
        <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Monthly Cost of Operations
          </p>
          <p className="mt-1 text-2xl font-bold" style={{ color: "var(--jms-text)" }}>
            {formatCentsAsAud(coo.monthlyCooRawCents)}
          </p>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {formatCentsAsAud(coo.monthlyCooAdjustedCents)} at estimated efficiency
          </p>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-4 gap-4">
        <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Available Days / Year
          </p>
          <p className="mt-1 text-2xl font-bold" style={{ color: "var(--jms-text)" }}>
            {coo.availableDays}
          </p>
        </div>
        <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Ave Days / Month
          </p>
          <p className="mt-1 text-2xl font-bold" style={{ color: "var(--jms-text)" }}>
            {coo.aveDaysPerMonth.toFixed(1)}
          </p>
        </div>
        <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Daily COO / Billable Resource
          </p>
          <p className="mt-1 text-2xl font-bold" style={{ color: "var(--jms-text)" }}>
            {formatCentsAsAud(coo.dailyCooPerBillableResourceRawCents)}
          </p>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {formatCentsAsAud(coo.dailyCooPerBillableResourceAdjustedCents)} adjusted
          </p>
        </div>
        <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            (Team) Hourly COO
          </p>
          <p className="mt-1 text-2xl font-bold" style={{ color: "var(--jms-text)" }}>
            {formatCentsAsAud(coo.hourlyCooRawCents)}
          </p>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {formatCentsAsAud(coo.hourlyCooAdjustedCents)} adjusted
          </p>
        </div>
      </div>

      <h2 className="mb-3 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Team Split - Daily COO Share
      </h2>
      <div className="overflow-hidden rounded-lg" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {coo.teamSplit.length === 0 ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No billable staff on the roster yet.
          </p>
        ) : (
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead
              className="uppercase"
              style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
              <tr>
                <th className="px-4 py-2 font-semibold">Name</th>
                <th className="px-4 py-2 text-right font-semibold">Daily COO Share</th>
              </tr>
            </thead>
            <tbody>
              {coo.teamSplit.map(({ entry, dailyCooShareCents }) => (
                <tr key={entry.id} className="last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                  <td className="px-4 py-2 font-medium" style={{ color: "var(--jms-text)" }}>
                    {entryDisplayName(entry, profileById)}
                  </td>
                  <td className="px-4 py-2 text-right" style={{ color: "var(--jms-text)" }}>
                    {formatCentsAsAud(dailyCooShareCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        "Raw" is the pre-efficiency baseline; efficiency-adjusted figures divide by this tenant's estimated efficiency rate below.
        The Profitability tab uses the raw hourly figure as its own baseline and applies 75%/85%/95%/actual efficiency scenarios
        independently.
      </p>

      <ThemedModal open={assumptionsOpen} onClose={() => setAssumptionsOpen(false)} title="Edit assumptions">
        <ThemedFormField label="Ordinary hours per week" type="number" value={ordinaryHours} onChange={(e) => setOrdinaryHours(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField label="Weekend days / year" type="number" value={weekendDays} onChange={(e) => setWeekendDays(e.target.value)} />
          <ThemedFormField label="Public holidays / year" type="number" value={publicHolidays} onChange={(e) => setPublicHolidays(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField label="Annual leave days" type="number" value={annualLeave} onChange={(e) => setAnnualLeave(e.target.value)} />
          <ThemedFormField label="Sick days" type="number" value={sickDays} onChange={(e) => setSickDays(e.target.value)} />
        </div>
        <ThemedFormField label="Rain/shutdown days" type="number" value={rainDays} onChange={(e) => setRainDays(e.target.value)} />
        <ThemedFormField
          label="Estimated efficiency rate (%)"
          type="number"
          step="0.1"
          value={efficiency}
          onChange={(e) => setEfficiency(e.target.value)}
        />
        {assumptionsError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {assumptionsError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button
            onClick={() => setAssumptionsOpen(false)}
            className="px-4 py-2 font-semibold"
            style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
          >
            Cancel
          </button>
          <ThemedButton onClick={() => saveAssumptions.mutate()} disabled={saveAssumptions.isPending}>
            {saveAssumptions.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}

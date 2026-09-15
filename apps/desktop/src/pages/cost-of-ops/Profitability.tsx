import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  calculateCostOfOperations,
  calculateLabour,
  calculateOperatingExpenses,
  calculateProfitability,
  formatCentsAsAud,
  updateCostOfOpsSettingsSchema,
  type CostOfOpsSettings,
  type LabourCostEntry,
  type OperatingExpense,
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

export default function ProfitabilityPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["cost-of-ops-settings"], queryFn: fetchSettings });
  const { data: expenses } = useQuery({ queryKey: ["operating-expenses"], queryFn: fetchExpenses });
  const { data: labour } = useQuery({ queryKey: ["labour-cost-entries"], queryFn: fetchLabour });

  const opex = settings && expenses ? calculateOperatingExpenses(expenses, settings) : null;
  const labourResult = settings && labour ? calculateLabour(labour, settings) : null;
  const coo = opex && labourResult && settings ? calculateCostOfOperations(opex, labourResult, settings) : null;
  const profitability = coo && labourResult && settings ? calculateProfitability(coo, labourResult, settings) : null;

  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const [actualChargeRate, setActualChargeRate] = useState("0");
  const [targetMargin, setTargetMargin] = useState("15");
  const [materialsSpend, setMaterialsSpend] = useState("0");
  const [materialsMarkup, setMaterialsMarkup] = useState("0");
  const [contractorsSpend, setContractorsSpend] = useState("0");
  const [contractorsHours, setContractorsHours] = useState("0");
  const [assumptionsError, setAssumptionsError] = useState<string | null>(null);

  const openAssumptions = () => {
    if (!settings) return;
    setActualChargeRate((settings.actual_charge_rate_cents / 100).toString());
    setTargetMargin((settings.target_labour_profit_margin * 100).toString());
    setMaterialsSpend((settings.materials_avg_monthly_spend_cents / 100).toString());
    setMaterialsMarkup((settings.materials_avg_markup * 100).toString());
    setContractorsSpend((settings.contractors_weekly_spend_cents / 100).toString());
    setContractorsHours(String(settings.contractors_weekly_hours));
    setAssumptionsError(null);
    setAssumptionsOpen(true);
  };

  const saveAssumptions = useMutation({
    mutationFn: async () => {
      if (!settings) throw new Error("Settings not loaded");
      const parsed = updateCostOfOpsSettingsSchema.safeParse({
        ...settings,
        actual_charge_rate_cents: Math.round(Number(actualChargeRate || 0) * 100),
        target_labour_profit_margin: Number(targetMargin || 0) / 100,
        materials_avg_monthly_spend_cents: Math.round(Number(materialsSpend || 0) * 100),
        materials_avg_markup: Number(materialsMarkup || 0) / 100,
        contractors_weekly_spend_cents: Math.round(Number(contractorsSpend || 0) * 100),
        contractors_weekly_hours: Number(contractorsHours || 0),
      });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid settings");
      const { error } = await supabase
        .from("cost_of_ops_settings")
        .update({
          actual_charge_rate_cents: parsed.data.actual_charge_rate_cents,
          target_labour_profit_margin: parsed.data.target_labour_profit_margin,
          materials_avg_monthly_spend_cents: parsed.data.materials_avg_monthly_spend_cents,
          materials_avg_markup: parsed.data.materials_avg_markup,
          contractors_weekly_spend_cents: parsed.data.contractors_weekly_spend_cents,
          contractors_weekly_hours: parsed.data.contractors_weekly_hours,
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

  if (!settings || !profitability) {
    return (
      <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)", fontFamily: "var(--jms-font)" }}>Loading...</p>
    );
  }

  return (
    <div style={{ fontFamily: "var(--jms-font)" }}>
      <div
        className="mb-6 flex items-center justify-between rounded-lg p-4"
        style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
      >
        <div className="flex gap-8" style={{ fontSize: "var(--jms-font-body)" }}>
          <div>
            <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              COO/Hour (RAW)
            </p>
            <p className="font-bold" style={{ color: "var(--jms-text)" }}>
              {formatCentsAsAud(profitability.cooPerHourRawCents)}
            </p>
          </div>
          <div>
            <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Actual Charge Rate (ex GST)
            </p>
            <p className="font-bold" style={{ color: "var(--jms-text)" }}>
              {formatCentsAsAud(settings.actual_charge_rate_cents)}
            </p>
          </div>
          <div>
            <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Target Labour Profit Margin
            </p>
            <p className="font-bold" style={{ color: "var(--jms-text)" }}>
              {(settings.target_labour_profit_margin * 100).toFixed(1)}%
            </p>
          </div>
        </div>
        <ThemedButton variant="secondary" onClick={openAssumptions} style={{ paddingBlock: 6, paddingInline: 12 }}>
          Edit
        </ThemedButton>
      </div>

      <div className="mb-6 overflow-x-auto rounded-lg" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
          <thead
            className="uppercase"
            style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
          >
            <tr>
              <th className="px-4 py-2 font-semibold">Metric</th>
              {profitability.columns.map((c) => (
                <th key={c.label} className="px-4 py-2 text-right font-semibold">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: "1px solid var(--jms-border)" }}>
              <td className="px-4 py-2" style={{ color: "var(--jms-text-muted)" }}>
                COO/Hr
              </td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right" style={{ color: "var(--jms-text)" }}>
                  {formatCentsAsAud(c.cooPerHourCents)}
                </td>
              ))}
            </tr>
            <tr style={{ borderBottom: "1px solid var(--jms-border)" }}>
              <td className="px-4 py-2" style={{ color: "var(--jms-text-muted)" }}>
                Required Charge-out Rate
              </td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right font-semibold" style={{ color: "var(--jms-text)" }}>
                  {formatCentsAsAud(c.requiredChargeRateCents)}
                </td>
              ))}
            </tr>
            <tr style={{ borderBottom: "1px solid var(--jms-border)" }}>
              <td className="px-4 py-2" style={{ color: "var(--jms-text-muted)" }}>
                vs. Your Actual Rate
              </td>
              {profitability.columns.map((c) => {
                const diff = settings.actual_charge_rate_cents - c.requiredChargeRateCents;
                return (
                  <td key={c.label} className="px-4 py-2 text-right" style={{ color: diff < 0 ? "var(--jms-danger)" : "var(--jms-accent)" }}>
                    {diff >= 0 ? "+" : ""}
                    {formatCentsAsAud(diff)}
                  </td>
                );
              })}
            </tr>
            <tr style={{ borderBottom: "1px solid var(--jms-border)" }}>
              <td className="px-4 py-2" style={{ color: "var(--jms-text-muted)" }}>
                Billable Hrs / Resource / Week
              </td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right" style={{ color: "var(--jms-text)" }}>
                  {c.billableHoursPerResourcePerWeek.toFixed(1)}
                </td>
              ))}
            </tr>
            <tr style={{ borderBottom: "1px solid var(--jms-border)" }}>
              <td className="px-4 py-2" style={{ color: "var(--jms-text-muted)" }}>
                Profit / Billable Hr
              </td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right" style={{ color: "var(--jms-text)" }}>
                  {formatCentsAsAud(c.profitPerBillableHourCents)}
                </td>
              ))}
            </tr>
            <tr style={{ borderBottom: "1px solid var(--jms-border)" }}>
              <td className="px-4 py-2" style={{ color: "var(--jms-text-muted)" }}>
                Profit / Resource / Month
              </td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right" style={{ color: "var(--jms-text)" }}>
                  {formatCentsAsAud(c.profitPerResourceMonthCents)}
                </td>
              ))}
            </tr>
            <tr style={{ borderBottom: "1px solid var(--jms-border)" }}>
              <td className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text)" }}>
                Estimated Labour Profit (Monthly)
              </td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right font-semibold" style={{ color: "var(--jms-text)" }}>
                  {formatCentsAsAud(c.estimatedLabourProfitCents)}
                </td>
              ))}
            </tr>
            <tr style={{ borderBottom: "1px solid var(--jms-border)" }}>
              <td className="px-4 py-2" style={{ color: "var(--jms-text-muted)" }}>
                Estimated Contractor Profit (Monthly)
              </td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right" style={{ color: "var(--jms-text)" }}>
                  {formatCentsAsAud(c.estimatedContractorProfitCents)}
                </td>
              ))}
            </tr>
            <tr style={{ borderBottom: "2px solid var(--jms-border)", backgroundColor: "var(--jms-bg)" }}>
              <td className="px-4 py-2 font-bold" style={{ color: "var(--jms-text)" }}>
                Estimated Total Monthly Profit
              </td>
              {profitability.estimatedTotalMonthlyProfitCents.map((v, i) => (
                <td key={i} className="px-4 py-2 text-right font-bold" style={{ color: "var(--jms-accent)" }}>
                  {formatCentsAsAud(v)}
                </td>
              ))}
            </tr>
            <tr>
              <td className="px-4 py-2 font-bold" style={{ color: "var(--jms-text)" }}>
                Estimated Annual Profit
              </td>
              {profitability.estimatedAnnualProfitCents.map((v, i) => (
                <td key={i} className="px-4 py-2 text-right font-bold" style={{ color: "var(--jms-accent)" }}>
                  {formatCentsAsAud(v)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4">
        <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Estimated Material Profit (Monthly)
          </p>
          <p className="mt-1 text-2xl font-bold" style={{ color: "var(--jms-text)" }}>
            {formatCentsAsAud(profitability.estimatedMaterialProfitCents)}
          </p>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Same across every efficiency scenario - doesn't depend on labour efficiency.
          </p>
        </div>
        <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Owner's Wages + Super (Annual)
          </p>
          <p className="mt-1 text-2xl font-bold" style={{ color: "var(--jms-text)" }}>
            {formatCentsAsAud(profitability.ownerWagesAndSuperCents)}
          </p>
        </div>
      </div>

      <div className="rounded-lg p-6" style={{ border: "1px solid var(--jms-accent)", backgroundColor: "var(--jms-accent-glow)" }}>
        <h2 className="mb-3 font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          Total Benefit From Business (Actual Efficiency)
        </h2>
        <div className="grid grid-cols-3 gap-4" style={{ fontSize: "var(--jms-font-body)" }}>
          <div>
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>Annual Profit</p>
            <p className="text-xl font-bold" style={{ color: "var(--jms-text)" }}>
              {formatCentsAsAud(profitability.estimatedAnnualProfitCents[3]!)}
            </p>
          </div>
          <div>
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>+ Owner's Wages &amp; Super</p>
            <p className="text-xl font-bold" style={{ color: "var(--jms-text)" }}>
              {formatCentsAsAud(profitability.ownerWagesAndSuperCents)}
            </p>
          </div>
          <div>
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>= Total Benefit From Business</p>
            <p className="text-xl font-bold" style={{ color: "var(--jms-text)" }}>
              {formatCentsAsAud(profitability.totalBenefitFromBusinessCents)}
            </p>
          </div>
        </div>
      </div>

      <ThemedModal open={assumptionsOpen} onClose={() => setAssumptionsOpen(false)} title="Edit profitability assumptions">
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField
            label="Actual charge rate (ex GST, $/hr)"
            type="number"
            step="0.01"
            value={actualChargeRate}
            onChange={(e) => setActualChargeRate(e.target.value)}
          />
          <ThemedFormField
            label="Target labour profit margin (%)"
            type="number"
            step="0.1"
            value={targetMargin}
            onChange={(e) => setTargetMargin(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField
            label="Materials avg monthly spend ($)"
            type="number"
            value={materialsSpend}
            onChange={(e) => setMaterialsSpend(e.target.value)}
          />
          <ThemedFormField
            label="Materials avg markup (%)"
            type="number"
            step="0.1"
            value={materialsMarkup}
            onChange={(e) => setMaterialsMarkup(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField
            label="Contractors weekly spend ($)"
            type="number"
            value={contractorsSpend}
            onChange={(e) => setContractorsSpend(e.target.value)}
          />
          <ThemedFormField label="Contractors weekly hours" type="number" value={contractorsHours} onChange={(e) => setContractorsHours(e.target.value)} />
        </div>
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

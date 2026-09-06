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
import { Modal } from "../../components/Modal";
import { FormField } from "../../components/FormField";

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
    return <p className="text-sm text-gray-500">Loading...</p>;
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between rounded-lg border border-gray-300 bg-white p-4">
        <div className="flex gap-8 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-400">COO/Hour (RAW)</p>
            <p className="font-bold text-gray-900">{formatCentsAsAud(profitability.cooPerHourRawCents)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-400">Actual Charge Rate (ex GST)</p>
            <p className="font-bold text-gray-900">{formatCentsAsAud(settings.actual_charge_rate_cents)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-400">Target Labour Profit Margin</p>
            <p className="font-bold text-gray-900">{(settings.target_labour_profit_margin * 100).toFixed(1)}%</p>
          </div>
        </div>
        <button onClick={openAssumptions} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50">
          Edit
        </button>
      </div>

      <div className="mb-6 overflow-x-auto rounded-lg border border-gray-300 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-300 bg-gray-50 text-xs uppercase text-gray-500">
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
            <tr className="border-b border-gray-200">
              <td className="px-4 py-2 text-gray-600">COO/Hr</td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right">
                  {formatCentsAsAud(c.cooPerHourCents)}
                </td>
              ))}
            </tr>
            <tr className="border-b border-gray-200">
              <td className="px-4 py-2 text-gray-600">Required Charge-out Rate</td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right font-semibold">
                  {formatCentsAsAud(c.requiredChargeRateCents)}
                </td>
              ))}
            </tr>
            <tr className="border-b border-gray-200">
              <td className="px-4 py-2 text-gray-600">vs. Your Actual Rate</td>
              {profitability.columns.map((c) => {
                const diff = settings.actual_charge_rate_cents - c.requiredChargeRateCents;
                return (
                  <td key={c.label} className={`px-4 py-2 text-right ${diff < 0 ? "text-red-600" : "text-green-700"}`}>
                    {diff >= 0 ? "+" : ""}
                    {formatCentsAsAud(diff)}
                  </td>
                );
              })}
            </tr>
            <tr className="border-b border-gray-200">
              <td className="px-4 py-2 text-gray-600">Billable Hrs / Resource / Week</td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right">
                  {c.billableHoursPerResourcePerWeek.toFixed(1)}
                </td>
              ))}
            </tr>
            <tr className="border-b border-gray-200">
              <td className="px-4 py-2 text-gray-600">Profit / Billable Hr</td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right">
                  {formatCentsAsAud(c.profitPerBillableHourCents)}
                </td>
              ))}
            </tr>
            <tr className="border-b border-gray-200">
              <td className="px-4 py-2 text-gray-600">Profit / Resource / Month</td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right">
                  {formatCentsAsAud(c.profitPerResourceMonthCents)}
                </td>
              ))}
            </tr>
            <tr className="border-b border-gray-200">
              <td className="px-4 py-2 font-semibold text-gray-900">Estimated Labour Profit (Monthly)</td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right font-semibold text-gray-900">
                  {formatCentsAsAud(c.estimatedLabourProfitCents)}
                </td>
              ))}
            </tr>
            <tr className="border-b border-gray-200">
              <td className="px-4 py-2 text-gray-600">Estimated Contractor Profit (Monthly)</td>
              {profitability.columns.map((c) => (
                <td key={c.label} className="px-4 py-2 text-right">
                  {formatCentsAsAud(c.estimatedContractorProfitCents)}
                </td>
              ))}
            </tr>
            <tr className="border-b-2 border-gray-300 bg-gray-50">
              <td className="px-4 py-2 font-bold text-gray-900">Estimated Total Monthly Profit</td>
              {profitability.estimatedTotalMonthlyProfitCents.map((v, i) => (
                <td key={i} className="px-4 py-2 text-right font-bold text-blue-700">
                  {formatCentsAsAud(v)}
                </td>
              ))}
            </tr>
            <tr>
              <td className="px-4 py-2 font-bold text-gray-900">Estimated Annual Profit</td>
              {profitability.estimatedAnnualProfitCents.map((v, i) => (
                <td key={i} className="px-4 py-2 text-right font-bold text-blue-700">
                  {formatCentsAsAud(v)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-gray-300 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-400">Estimated Material Profit (Monthly)</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{formatCentsAsAud(profitability.estimatedMaterialProfitCents)}</p>
          <p className="text-xs text-gray-500">Same across every efficiency scenario - doesn't depend on labour efficiency.</p>
        </div>
        <div className="rounded-lg border border-gray-300 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-gray-400">Owner's Wages + Super (Annual)</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{formatCentsAsAud(profitability.ownerWagesAndSuperCents)}</p>
        </div>
      </div>

      <div className="rounded-lg border border-blue-300 bg-blue-50 p-6">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-blue-800">
          Total Benefit From Business (Actual Efficiency)
        </h2>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-xs text-blue-700">Annual Profit</p>
            <p className="text-xl font-bold text-blue-900">{formatCentsAsAud(profitability.estimatedAnnualProfitCents[3]!)}</p>
          </div>
          <div>
            <p className="text-xs text-blue-700">+ Owner's Wages &amp; Super</p>
            <p className="text-xl font-bold text-blue-900">{formatCentsAsAud(profitability.ownerWagesAndSuperCents)}</p>
          </div>
          <div>
            <p className="text-xs text-blue-700">= Total Benefit From Business</p>
            <p className="text-xl font-bold text-blue-900">{formatCentsAsAud(profitability.totalBenefitFromBusinessCents)}</p>
          </div>
        </div>
      </div>

      <Modal open={assumptionsOpen} onClose={() => setAssumptionsOpen(false)} title="Edit profitability assumptions">
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Actual charge rate (ex GST, $/hr)"
            type="number"
            step="0.01"
            value={actualChargeRate}
            onChange={(e) => setActualChargeRate(e.target.value)}
          />
          <FormField label="Target labour profit margin (%)" type="number" step="0.1" value={targetMargin} onChange={(e) => setTargetMargin(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Materials avg monthly spend ($)"
            type="number"
            value={materialsSpend}
            onChange={(e) => setMaterialsSpend(e.target.value)}
          />
          <FormField label="Materials avg markup (%)" type="number" step="0.1" value={materialsMarkup} onChange={(e) => setMaterialsMarkup(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Contractors weekly spend ($)"
            type="number"
            value={contractorsSpend}
            onChange={(e) => setContractorsSpend(e.target.value)}
          />
          <FormField label="Contractors weekly hours" type="number" value={contractorsHours} onChange={(e) => setContractorsHours(e.target.value)} />
        </div>
        {assumptionsError ? <p className="mb-4 text-sm text-red-600">{assumptionsError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setAssumptionsOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveAssumptions.mutate()}
            disabled={saveAssumptions.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveAssumptions.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

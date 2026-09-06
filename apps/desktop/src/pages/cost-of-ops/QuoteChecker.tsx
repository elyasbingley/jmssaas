import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  calculateCostOfOperations,
  calculateLabour,
  calculateOperatingExpenses,
  calculateQuoteChecker,
  formatCentsAsAud,
  type CostOfOpsSettings,
  type LabourCostEntry,
  type OperatingExpense,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
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

// Ad-hoc, standalone calculator - deliberately not tied to a saved quote/job
// for v1. "Load from an existing job" (pulling a job's quoted amount and
// logged hours in as a starting point) is a documented possible follow-up,
// not built here.
export default function QuoteCheckerPage() {
  const { data: settings } = useQuery({ queryKey: ["cost-of-ops-settings"], queryFn: fetchSettings });
  const { data: expenses } = useQuery({ queryKey: ["operating-expenses"], queryFn: fetchExpenses });
  const { data: labour } = useQuery({ queryKey: ["labour-cost-entries"], queryFn: fetchLabour });

  const opex = settings && expenses ? calculateOperatingExpenses(expenses, settings) : null;
  const labourResult = settings && labour ? calculateLabour(labour, settings) : null;
  const coo = opex && labourResult && settings ? calculateCostOfOperations(opex, labourResult, settings) : null;

  const [hoursRequired, setHoursRequired] = useState("8");
  const [resourcesRequired, setResourcesRequired] = useState("1");
  const [labourMargin, setLabourMargin] = useState("15");
  const [materialsCost, setMaterialsCost] = useState("0");
  const [materialsMargin, setMaterialsMargin] = useState("20");
  const [actualHoursTaken, setActualHoursTaken] = useState("");

  const [alternateRate, setAlternateRate] = useState("0");
  const [alternateQuantity, setAlternateQuantity] = useState("1");

  const [contractorCostPerHour, setContractorCostPerHour] = useState("0");
  const [contractorChargeOutRate, setContractorChargeOutRate] = useState("0");
  const [contractorHoursRequired, setContractorHoursRequired] = useState("8");

  if (!settings || !coo) {
    return <p className="text-sm text-gray-500">Loading...</p>;
  }

  const result = calculateQuoteChecker(
    {
      hoursRequired: Number(hoursRequired || 0),
      resourcesRequired: Number(resourcesRequired || 0),
      labourProfitMargin: Number(labourMargin || 0) / 100,
      materialsCostCents: Math.round(Number(materialsCost || 0) * 100),
      materialsProfitMargin: Number(materialsMargin || 0) / 100,
      actualHoursTaken: actualHoursTaken ? Number(actualHoursTaken) : undefined,
      alternateRateCents: Math.round(Number(alternateRate || 0) * 100),
      alternateQuantity: Number(alternateQuantity || 0),
      contractorCostPerHourCents: Math.round(Number(contractorCostPerHour || 0) * 100),
      contractorChargeOutRateCents: Math.round(Number(contractorChargeOutRate || 0) * 100),
      contractorHoursRequired: Number(contractorHoursRequired || 0),
    },
    coo.hourlyCooRawCents,
    settings
  );

  return (
    <div>
      <p className="mb-6 text-sm text-gray-500">
        A quick, ad-hoc check for one job - nothing here is saved. Compare pricing your own labour, a flat alternate rate, and
        subcontracting the same job, side by side.
      </p>

      <div className="grid grid-cols-3 gap-4">
        {/* PROFITABILITY - own labour */}
        <div className="rounded-lg border border-gray-300 bg-white p-4">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Profitability (Your Labour)</h2>
          <FormField label="Hours required" type="number" value={hoursRequired} onChange={(e) => setHoursRequired(e.target.value)} />
          <FormField label="Resources required" type="number" value={resourcesRequired} onChange={(e) => setResourcesRequired(e.target.value)} />
          <FormField label="Labour profit margin (%)" type="number" step="0.1" value={labourMargin} onChange={(e) => setLabourMargin(e.target.value)} />
          <FormField label="Materials cost ($)" type="number" value={materialsCost} onChange={(e) => setMaterialsCost(e.target.value)} />
          <FormField
            label="Materials profit margin (%)"
            type="number"
            step="0.1"
            value={materialsMargin}
            onChange={(e) => setMaterialsMargin(e.target.value)}
          />
          <FormField
            label="Actual hours taken (optional)"
            type="number"
            value={actualHoursTaken}
            onChange={(e) => setActualHoursTaken(e.target.value)}
            placeholder="Leave blank if not started/finished yet"
          />

          <div className="mt-4 space-y-1 border-t border-gray-200 pt-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Cost @ Efficiency</span>
              <span>{formatCentsAsAud(result.profitability.costAtEfficiencyCents)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Required Charge (Labour)</span>
              <span className="font-semibold">{formatCentsAsAud(result.profitability.requiredChargeLabourOnlyCents)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Profit/Loss on Labour</span>
              <span className={result.profitability.profitLossOnLabourCents < 0 ? "text-red-600" : "text-green-700"}>
                {formatCentsAsAud(result.profitability.profitLossOnLabourCents)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Required Charge (Materials)</span>
              <span>{formatCentsAsAud(result.profitability.requiredChargeMaterialsOnlyCents)}</span>
            </div>
            <div className="flex justify-between border-t border-gray-200 pt-1 font-semibold">
              <span>Total Charge For Job</span>
              <span>{formatCentsAsAud(result.profitability.totalChargeForJobCents)}</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span>GST</span>
              <span>{formatCentsAsAud(result.profitability.gstCents)}</span>
            </div>
            <div className="flex justify-between font-bold text-blue-700">
              <span>Total Job Value (inc GST)</span>
              <span>{formatCentsAsAud(result.profitability.totalJobValueIncGstCents)}</span>
            </div>
            <div className="flex justify-between font-bold">
              <span>Total Profit For Job</span>
              <span className={result.profitability.totalProfitForJobCents < 0 ? "text-red-600" : "text-green-700"}>
                {formatCentsAsAud(result.profitability.totalProfitForJobCents)}
              </span>
            </div>
            {result.profitability.actualProfitLossCents !== null ? (
              <>
                <div className="flex justify-between border-t border-gray-200 pt-1">
                  <span className="text-gray-500">Actual Profit/Loss</span>
                  <span className={result.profitability.actualProfitLossCents < 0 ? "text-red-600" : "text-green-700"}>
                    {formatCentsAsAud(result.profitability.actualProfitLossCents)}
                  </span>
                </div>
                {result.profitability.profitLostPerExtraHourCents ? (
                  <div className="flex justify-between text-xs text-red-600">
                    <span>Profit lost / extra hour</span>
                    <span>{formatCentsAsAud(result.profitability.profitLostPerExtraHourCents)}</span>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        {/* ALTERNATE PRICING */}
        <div className="rounded-lg border border-gray-300 bg-white p-4">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Alternate Pricing</h2>
          <FormField
            label="Rate (excl GST, e.g. per m²/day)"
            type="number"
            value={alternateRate}
            onChange={(e) => setAlternateRate(e.target.value)}
          />
          <FormField label="Quantity (e.g. m²/days)" type="number" value={alternateQuantity} onChange={(e) => setAlternateQuantity(e.target.value)} />

          <div className="mt-4 space-y-1 border-t border-gray-200 pt-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Total (ex GST)</span>
              <span className="font-semibold">{formatCentsAsAud(result.alternatePricing.totalExGstCents)}</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span>GST</span>
              <span>{formatCentsAsAud(result.alternatePricing.gstCents)}</span>
            </div>
            <div className="flex justify-between font-bold text-blue-700">
              <span>Total (inc GST)</span>
              <span>{formatCentsAsAud(result.alternatePricing.totalIncGstCents)}</span>
            </div>
          </div>
          <p className="mt-3 text-xs text-gray-400">A flat, externally-priced comparison for the same job - no profit calc, just a reference point.</p>
        </div>

        {/* USING CONTRACT LABOUR */}
        <div className="rounded-lg border border-gray-300 bg-white p-4">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Using Contract Labour</h2>
          <FormField
            label="Contractor cost ($/hr)"
            type="number"
            value={contractorCostPerHour}
            onChange={(e) => setContractorCostPerHour(e.target.value)}
          />
          <FormField
            label="Contractor charge-out rate ($/hr)"
            type="number"
            value={contractorChargeOutRate}
            onChange={(e) => setContractorChargeOutRate(e.target.value)}
          />
          <FormField
            label="Contractor hours required"
            type="number"
            value={contractorHoursRequired}
            onChange={(e) => setContractorHoursRequired(e.target.value)}
          />

          <div className="mt-4 space-y-1 border-t border-gray-200 pt-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Cost</span>
              <span>{formatCentsAsAud(result.contractLabour.costCents)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Charge (ex GST)</span>
              <span className="font-semibold">{formatCentsAsAud(result.contractLabour.chargeExGstCents)}</span>
            </div>
            <div className="flex justify-between font-bold text-blue-700">
              <span>Charge (inc GST)</span>
              <span>{formatCentsAsAud(result.contractLabour.chargeIncGstCents)}</span>
            </div>
            <div className="flex justify-between font-bold">
              <span>Profit/Loss</span>
              <span className={result.contractLabour.profitLossCents < 0 ? "text-red-600" : "text-green-700"}>
                {formatCentsAsAud(result.contractLabour.profitLossCents)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

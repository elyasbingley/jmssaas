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
    return (
      <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)", fontFamily: "var(--jms-font)" }}>Loading...</p>
    );
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
    <div style={{ fontFamily: "var(--jms-font)" }}>
      <p className="mb-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
        A quick, ad-hoc check for one job - nothing here is saved. Compare pricing your own labour, a flat alternate rate, and
        subcontracting the same job, side by side.
      </p>

      <div className="grid grid-cols-3 gap-4">
        {/* PROFITABILITY - own labour */}
        <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <h2 className="mb-3 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Profitability (Your Labour)
          </h2>
          <ThemedFormField label="Hours required" type="number" value={hoursRequired} onChange={(e) => setHoursRequired(e.target.value)} />
          <ThemedFormField
            label="Resources required"
            type="number"
            value={resourcesRequired}
            onChange={(e) => setResourcesRequired(e.target.value)}
          />
          <ThemedFormField
            label="Labour profit margin (%)"
            type="number"
            step="0.1"
            value={labourMargin}
            onChange={(e) => setLabourMargin(e.target.value)}
          />
          <ThemedFormField label="Materials cost ($)" type="number" value={materialsCost} onChange={(e) => setMaterialsCost(e.target.value)} />
          <ThemedFormField
            label="Materials profit margin (%)"
            type="number"
            step="0.1"
            value={materialsMargin}
            onChange={(e) => setMaterialsMargin(e.target.value)}
          />
          <ThemedFormField
            label="Actual hours taken (optional)"
            type="number"
            value={actualHoursTaken}
            onChange={(e) => setActualHoursTaken(e.target.value)}
            placeholder="Leave blank if not started/finished yet"
          />

          <div className="mt-4 space-y-1 pt-3" style={{ borderTop: "1px solid var(--jms-border)", fontSize: "var(--jms-font-body)" }}>
            <div className="flex justify-between">
              <span style={{ color: "var(--jms-text-muted)" }}>Cost @ Efficiency</span>
              <span style={{ color: "var(--jms-text)" }}>{formatCentsAsAud(result.profitability.costAtEfficiencyCents)}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--jms-text-muted)" }}>Required Charge (Labour)</span>
              <span className="font-semibold" style={{ color: "var(--jms-text)" }}>
                {formatCentsAsAud(result.profitability.requiredChargeLabourOnlyCents)}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--jms-text-muted)" }}>Profit/Loss on Labour</span>
              <span style={{ color: result.profitability.profitLossOnLabourCents < 0 ? "var(--jms-danger)" : "var(--jms-accent)" }}>
                {formatCentsAsAud(result.profitability.profitLossOnLabourCents)}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--jms-text-muted)" }}>Required Charge (Materials)</span>
              <span style={{ color: "var(--jms-text)" }}>{formatCentsAsAud(result.profitability.requiredChargeMaterialsOnlyCents)}</span>
            </div>
            <div className="flex justify-between pt-1 font-semibold" style={{ borderTop: "1px solid var(--jms-border)", color: "var(--jms-text)" }}>
              <span>Total Charge For Job</span>
              <span>{formatCentsAsAud(result.profitability.totalChargeForJobCents)}</span>
            </div>
            <div className="flex justify-between" style={{ color: "var(--jms-text-muted)" }}>
              <span>GST</span>
              <span>{formatCentsAsAud(result.profitability.gstCents)}</span>
            </div>
            <div className="flex justify-between font-bold" style={{ color: "var(--jms-accent)" }}>
              <span>Total Job Value (inc GST)</span>
              <span>{formatCentsAsAud(result.profitability.totalJobValueIncGstCents)}</span>
            </div>
            <div className="flex justify-between font-bold" style={{ color: "var(--jms-text)" }}>
              <span>Total Profit For Job</span>
              <span style={{ color: result.profitability.totalProfitForJobCents < 0 ? "var(--jms-danger)" : "var(--jms-accent)" }}>
                {formatCentsAsAud(result.profitability.totalProfitForJobCents)}
              </span>
            </div>
            {result.profitability.actualProfitLossCents !== null ? (
              <>
                <div className="flex justify-between pt-1" style={{ borderTop: "1px solid var(--jms-border)" }}>
                  <span style={{ color: "var(--jms-text-muted)" }}>Actual Profit/Loss</span>
                  <span style={{ color: result.profitability.actualProfitLossCents < 0 ? "var(--jms-danger)" : "var(--jms-accent)" }}>
                    {formatCentsAsAud(result.profitability.actualProfitLossCents)}
                  </span>
                </div>
                {result.profitability.profitLostPerExtraHourCents ? (
                  <div className="flex justify-between" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                    <span>Profit lost / extra hour</span>
                    <span>{formatCentsAsAud(result.profitability.profitLostPerExtraHourCents)}</span>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        {/* ALTERNATE PRICING */}
        <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <h2 className="mb-3 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Alternate Pricing
          </h2>
          <ThemedFormField
            label="Rate (excl GST, e.g. per m²/day)"
            type="number"
            value={alternateRate}
            onChange={(e) => setAlternateRate(e.target.value)}
          />
          <ThemedFormField
            label="Quantity (e.g. m²/days)"
            type="number"
            value={alternateQuantity}
            onChange={(e) => setAlternateQuantity(e.target.value)}
          />

          <div className="mt-4 space-y-1 pt-3" style={{ borderTop: "1px solid var(--jms-border)", fontSize: "var(--jms-font-body)" }}>
            <div className="flex justify-between">
              <span style={{ color: "var(--jms-text-muted)" }}>Total (ex GST)</span>
              <span className="font-semibold" style={{ color: "var(--jms-text)" }}>
                {formatCentsAsAud(result.alternatePricing.totalExGstCents)}
              </span>
            </div>
            <div className="flex justify-between" style={{ color: "var(--jms-text-muted)" }}>
              <span>GST</span>
              <span>{formatCentsAsAud(result.alternatePricing.gstCents)}</span>
            </div>
            <div className="flex justify-between font-bold" style={{ color: "var(--jms-accent)" }}>
              <span>Total (inc GST)</span>
              <span>{formatCentsAsAud(result.alternatePricing.totalIncGstCents)}</span>
            </div>
          </div>
          <p className="mt-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            A flat, externally-priced comparison for the same job - no profit calc, just a reference point.
          </p>
        </div>

        {/* USING CONTRACT LABOUR */}
        <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <h2 className="mb-3 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Using Contract Labour
          </h2>
          <ThemedFormField
            label="Contractor cost ($/hr)"
            type="number"
            value={contractorCostPerHour}
            onChange={(e) => setContractorCostPerHour(e.target.value)}
          />
          <ThemedFormField
            label="Contractor charge-out rate ($/hr)"
            type="number"
            value={contractorChargeOutRate}
            onChange={(e) => setContractorChargeOutRate(e.target.value)}
          />
          <ThemedFormField
            label="Contractor hours required"
            type="number"
            value={contractorHoursRequired}
            onChange={(e) => setContractorHoursRequired(e.target.value)}
          />

          <div className="mt-4 space-y-1 pt-3" style={{ borderTop: "1px solid var(--jms-border)", fontSize: "var(--jms-font-body)" }}>
            <div className="flex justify-between">
              <span style={{ color: "var(--jms-text-muted)" }}>Cost</span>
              <span style={{ color: "var(--jms-text)" }}>{formatCentsAsAud(result.contractLabour.costCents)}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--jms-text-muted)" }}>Charge (ex GST)</span>
              <span className="font-semibold" style={{ color: "var(--jms-text)" }}>
                {formatCentsAsAud(result.contractLabour.chargeExGstCents)}
              </span>
            </div>
            <div className="flex justify-between font-bold" style={{ color: "var(--jms-accent)" }}>
              <span>Charge (inc GST)</span>
              <span>{formatCentsAsAud(result.contractLabour.chargeIncGstCents)}</span>
            </div>
            <div className="flex justify-between font-bold" style={{ color: "var(--jms-text)" }}>
              <span>Profit/Loss</span>
              <span style={{ color: result.contractLabour.profitLossCents < 0 ? "var(--jms-danger)" : "var(--jms-accent)" }}>
                {formatCentsAsAud(result.contractLabour.profitLossCents)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

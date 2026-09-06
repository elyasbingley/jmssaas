import type { CostOfOpsSettings, LabourCostEntry, OperatingExpense } from "./types";

// Cost of Ops calculation layer - modelled on the "Cost of Operations
// Calculator" spreadsheet (Tradies Success Academy). Every function here is
// pure and recomputes from the raw settings/expenses/labour rows on every
// call - nothing is ever persisted, matching the module's own brief. Same
// role as money.ts's calculateDocumentTotals: a shared calc module fed by
// data the caller already fetched, not a database function - this schema
// has no precedent for read-side Postgres aggregation (Job Costing and the
// Analytics module both compute client-side too), unlike the membership
// discount engine's Postgres functions, which persist their result onto the
// quote/invoice row for consistent redisplay. There's nothing to persist
// here, so that pattern doesn't apply.
//
// A few formulas aren't fully pinned down by the reference tool's field
// list alone - each judgment call is documented at the point it's made.

const WEEKS_PER_YEAR = 52;
const MONTHS_PER_YEAR = 12;
const AU_GST_RATE = 0.1;
const BILLABLE_RESOURCE_ROLES = ["owner", "field_staff", "apprentice"] as const;

function isBillableResourceRole(role: LabourCostEntry["role_type"]): boolean {
  return (BILLABLE_RESOURCE_ROLES as readonly string[]).includes(role);
}

// ---------------------------------------------------------------------------
// Operating Expenses
// ---------------------------------------------------------------------------

export interface OperatingExpenseLineResult {
  expense: OperatingExpense;
  differenceCents: number; // budget - actual (positive = under budget)
  percentOfTotal: number; // 0-1
}

export interface OperatingExpensesResult {
  lines: OperatingExpenseLineResult[];
  totalMonthlyCents: number;
  vehicleCostCents: number;
  // Monthly total + vehicle allowance, marked up by buffer_percent.
  totalOperatingExpenseCents: number;
}

export function calculateOperatingExpenses(expenses: OperatingExpense[], settings: CostOfOpsSettings): OperatingExpensesResult {
  const totalMonthlyCents = expenses.reduce((sum, e) => sum + e.monthly_amount_cents, 0);
  const lines = expenses.map((expense) => ({
    expense,
    differenceCents: (expense.budget_amount_cents ?? 0) - expense.monthly_amount_cents,
    percentOfTotal: totalMonthlyCents > 0 ? expense.monthly_amount_cents / totalMonthlyCents : 0,
  }));
  const vehicleCostCents = settings.vehicles_owned * settings.vehicle_holding_cost_cents;
  const totalOperatingExpenseCents = Math.round((totalMonthlyCents + vehicleCostCents) * (1 + settings.buffer_percent));

  return { lines, totalMonthlyCents, vehicleCostCents, totalOperatingExpenseCents };
}

// ---------------------------------------------------------------------------
// Labour
// ---------------------------------------------------------------------------

export interface LabourEntryResult {
  entry: LabourCostEntry;
  costPerHourCents: number;
  costPerWeekCents: number;
  // (billable_hours_per_week / ordinary_hours_per_week), apprentice-
  // utilisation-adjusted - 0 for roles that don't count toward headcount
  // (admin, subcontractor).
  billableResourceFraction: number;
  nonBillableResourceFraction: number;
}

export interface LabourResult {
  entries: LabourEntryResult[];
  billableResources: number;
  nonBillableResources: number;
  weeklyLabourCostCents: number;
  monthlyLabourCostCents: number;
}

function labourEntryCost(entry: LabourCostEntry): { costPerHourCents: number; costPerWeekCents: number } {
  const totalHours = entry.billable_hours_per_week + entry.non_billable_hours_per_week;

  if (entry.pay_type === "salary") {
    // Owners: a flat annual cost (salary + super), spread evenly across the
    // year regardless of hours actually worked that week.
    const annualCents = (entry.annual_salary_cents ?? 0) + (entry.superannuation_cents ?? 0);
    const costPerWeekCents = annualCents / WEEKS_PER_YEAR;
    return { costPerHourCents: totalHours > 0 ? costPerWeekCents / totalHours : 0, costPerWeekCents };
  }

  // Hourly roles: rate + super (as a rate of the hourly rate) + a flat
  // per-hour allowance, all scaled by hours worked.
  const rate = entry.hourly_rate_cents ?? 0;
  const superRate = entry.superannuation_rate ?? 0;
  const allowance = entry.allowance_cents ?? 0;
  let costPerHourCents = rate * (1 + superRate) + allowance;
  let costPerWeekCents = costPerHourCents * totalHours;

  if (entry.role_type === "subcontractor") {
    // No super/allowance obligation on a subcontractor - just their rate,
    // plus a flat weekly travel allowance rather than a per-hour one.
    costPerHourCents = rate;
    costPerWeekCents = rate * totalHours + (entry.subcontractor_travel_allow_cents ?? 0);
  } else if (entry.role_type === "apprentice") {
    // apprentice_utilisation ("% of a full billable resource") additionally
    // scales their cost - see the module doc comment above.
    const utilisation = entry.apprentice_utilisation ?? 1;
    costPerWeekCents *= utilisation;
  }

  return { costPerHourCents, costPerWeekCents };
}

export function calculateLabour(labour: LabourCostEntry[], settings: CostOfOpsSettings): LabourResult {
  const entries: LabourEntryResult[] = labour.map((entry) => {
    const { costPerHourCents, costPerWeekCents } = labourEntryCost(entry);
    const billable = isBillableResourceRole(entry.role_type);
    const utilisation = entry.role_type === "apprentice" ? entry.apprentice_utilisation ?? 1 : 1;
    const billableResourceFraction =
      billable && settings.ordinary_hours_per_week > 0
        ? (entry.billable_hours_per_week / settings.ordinary_hours_per_week) * utilisation
        : 0;
    const nonBillableResourceFraction =
      billable && settings.ordinary_hours_per_week > 0 ? entry.non_billable_hours_per_week / settings.ordinary_hours_per_week : 0;

    return { entry, costPerHourCents, costPerWeekCents, billableResourceFraction, nonBillableResourceFraction };
  });

  const billableResources = entries.reduce((sum, e) => sum + e.billableResourceFraction, 0);
  const nonBillableResources = entries.reduce((sum, e) => sum + e.nonBillableResourceFraction, 0);
  const weeklyLabourCostCents = entries.reduce((sum, e) => sum + e.costPerWeekCents, 0);
  const monthlyLabourCostCents = (weeklyLabourCostCents * WEEKS_PER_YEAR) / MONTHS_PER_YEAR;

  return { entries, billableResources, nonBillableResources, weeklyLabourCostCents, monthlyLabourCostCents };
}

// ---------------------------------------------------------------------------
// Cost of Operations
// ---------------------------------------------------------------------------

export interface TeamSplitResult {
  entry: LabourCostEntry;
  dailyCooShareCents: number;
}

export interface CostOfOperationsResult {
  availableDays: number;
  aveDaysPerMonth: number;
  weeklyCooRawCents: number;
  dailyCooRawCents: number;
  monthlyCooRawCents: number;
  weeklyCooAdjustedCents: number;
  dailyCooAdjustedCents: number;
  monthlyCooAdjustedCents: number;
  dailyCooPerBillableResourceRawCents: number;
  dailyCooPerBillableResourceAdjustedCents: number;
  // "(TEAM) Hourly COO" and "COO/Hour" - raw is the pre-efficiency baseline
  // Profitability's own 75/85/95/actual scenarios each re-derive from;
  // adjusted uses this tenant's own single estimated_efficiency_rate.
  hourlyCooRawCents: number;
  hourlyCooAdjustedCents: number;
  teamSplit: TeamSplitResult[];
}

export function calculateCostOfOperations(
  operatingExpenses: OperatingExpensesResult,
  labourResult: LabourResult,
  settings: CostOfOpsSettings
): CostOfOperationsResult {
  const availableDays =
    365 -
    settings.weekend_days_per_year -
    settings.public_holidays_per_year -
    settings.annual_leave_days -
    settings.sick_days -
    settings.rain_shutdown_days;
  const aveDaysPerMonth = availableDays / MONTHS_PER_YEAR;

  const monthlyCooRawCents = labourResult.monthlyLabourCostCents + operatingExpenses.totalOperatingExpenseCents;
  const weeklyCooRawCents = (monthlyCooRawCents * MONTHS_PER_YEAR) / WEEKS_PER_YEAR;
  const dailyCooRawCents = aveDaysPerMonth > 0 ? monthlyCooRawCents / aveDaysPerMonth : 0;

  const efficiency = settings.estimated_efficiency_rate > 0 ? settings.estimated_efficiency_rate : 1;
  const monthlyCooAdjustedCents = monthlyCooRawCents / efficiency;
  const weeklyCooAdjustedCents = weeklyCooRawCents / efficiency;
  const dailyCooAdjustedCents = dailyCooRawCents / efficiency;

  const dailyCooPerBillableResourceRawCents = labourResult.billableResources > 0 ? dailyCooRawCents / labourResult.billableResources : 0;
  const dailyCooPerBillableResourceAdjustedCents =
    labourResult.billableResources > 0 ? dailyCooAdjustedCents / labourResult.billableResources : 0;

  const hoursPerDay = settings.ordinary_hours_per_week / 5;
  const hourlyCooRawCents = hoursPerDay > 0 ? dailyCooPerBillableResourceRawCents / hoursPerDay : 0;
  const hourlyCooAdjustedCents = hoursPerDay > 0 ? dailyCooPerBillableResourceAdjustedCents / hoursPerDay : 0;

  // TEAM SPLIT - the whole business's daily raw cost, allocated across
  // billable staff proportional to each one's share of total billable
  // resources (not cost) - same shape as the reference tool's own split.
  const teamSplit: TeamSplitResult[] = labourResult.entries
    .filter((e) => isBillableResourceRole(e.entry.role_type) && e.billableResourceFraction > 0)
    .map((e) => ({
      entry: e.entry,
      dailyCooShareCents:
        labourResult.billableResources > 0 ? dailyCooRawCents * (e.billableResourceFraction / labourResult.billableResources) : 0,
    }));

  return {
    availableDays,
    aveDaysPerMonth,
    weeklyCooRawCents,
    dailyCooRawCents,
    monthlyCooRawCents,
    weeklyCooAdjustedCents,
    dailyCooAdjustedCents,
    monthlyCooAdjustedCents,
    dailyCooPerBillableResourceRawCents,
    dailyCooPerBillableResourceAdjustedCents,
    hourlyCooRawCents,
    hourlyCooAdjustedCents,
    teamSplit,
  };
}

// ---------------------------------------------------------------------------
// Profitability
// ---------------------------------------------------------------------------

export interface ProfitabilityColumn {
  label: string;
  efficiency: number;
  cooPerHourCents: number;
  requiredChargeRateCents: number;
  billableHoursPerResourcePerWeek: number;
  profitPerBillableHourCents: number;
  profitPerResourceMonthCents: number;
  estimatedLabourProfitCents: number;
  estimatedContractorProfitCents: number;
}

export interface ProfitabilityResult {
  cooPerHourRawCents: number;
  columns: ProfitabilityColumn[];
  estimatedMaterialProfitCents: number;
  // Total monthly/annual profit per column (labour + materials + contractor).
  estimatedTotalMonthlyProfitCents: number[];
  estimatedAnnualProfitCents: number[];
  ownerWagesAndSuperCents: number;
  // Tied to the "Actual Efficiency" column (index 3) - the tenant's real
  // current position, not a 75/85/95 what-if scenario.
  totalBenefitFromBusinessCents: number;
}

export function calculateProfitability(
  costOfOperations: CostOfOperationsResult,
  labourResult: LabourResult,
  settings: CostOfOpsSettings
): ProfitabilityResult {
  const cooPerHourRawCents = costOfOperations.hourlyCooRawCents;
  const contractorCostPerHourCents =
    settings.contractors_weekly_hours > 0 ? settings.contractors_weekly_spend_cents / settings.contractors_weekly_hours : 0;

  const scenarios: { label: string; efficiency: number }[] = [
    { label: "75% Efficiency", efficiency: 0.75 },
    { label: "85% Efficiency", efficiency: 0.85 },
    { label: "95% Efficiency", efficiency: 0.95 },
    { label: "Actual Efficiency", efficiency: settings.estimated_efficiency_rate },
  ];

  const columns: ProfitabilityColumn[] = scenarios.map(({ label, efficiency }) => {
    const e = efficiency > 0 ? efficiency : 1;
    const cooPerHourCents = cooPerHourRawCents / e;
    // Cost / (1 - margin) - "profit margin" here is a % of the sell price,
    // not a cost markup, matching how membership_discount_percent and every
    // other percent field in this app is stored as a fraction of the total.
    const requiredChargeRateCents = settings.target_labour_profit_margin < 1 ? cooPerHourCents / (1 - settings.target_labour_profit_margin) : cooPerHourCents;
    const profitPerBillableHourCents = requiredChargeRateCents - cooPerHourCents;
    const billableHoursPerResourcePerWeek = settings.ordinary_hours_per_week * e;
    const profitPerResourceMonthCents = (profitPerBillableHourCents * billableHoursPerResourcePerWeek * WEEKS_PER_YEAR) / MONTHS_PER_YEAR;
    const estimatedLabourProfitCents = profitPerResourceMonthCents * labourResult.billableResources;

    // Contractor hours charged out at the same required rate as your own
    // labour for this scenario, profiting the spread against what you
    // actually pay the contractor - the settings row has no separate
    // contractor charge-out rate/markup of its own to derive this from.
    const estimatedContractorProfitCents =
      (requiredChargeRateCents - contractorCostPerHourCents) * settings.contractors_weekly_hours * (WEEKS_PER_YEAR / MONTHS_PER_YEAR);

    return {
      label,
      efficiency,
      cooPerHourCents,
      requiredChargeRateCents,
      billableHoursPerResourcePerWeek,
      profitPerBillableHourCents,
      profitPerResourceMonthCents,
      estimatedLabourProfitCents,
      estimatedContractorProfitCents,
    };
  });

  const estimatedMaterialProfitCents = settings.materials_avg_monthly_spend_cents * settings.materials_avg_markup;

  const estimatedTotalMonthlyProfitCents = columns.map(
    (c) => c.estimatedLabourProfitCents + estimatedMaterialProfitCents + c.estimatedContractorProfitCents
  );
  const estimatedAnnualProfitCents = estimatedTotalMonthlyProfitCents.map((m) => m * MONTHS_PER_YEAR);

  const ownerWagesAndSuperCents = labourResult.entries
    .filter((e) => e.entry.role_type === "owner")
    .reduce((sum, e) => sum + (e.entry.annual_salary_cents ?? 0) + (e.entry.superannuation_cents ?? 0), 0);

  const actualColumnIndex = 3;
  const totalBenefitFromBusinessCents = estimatedAnnualProfitCents[actualColumnIndex]! + ownerWagesAndSuperCents;

  return {
    cooPerHourRawCents,
    columns,
    estimatedMaterialProfitCents,
    estimatedTotalMonthlyProfitCents,
    estimatedAnnualProfitCents,
    ownerWagesAndSuperCents,
    totalBenefitFromBusinessCents,
  };
}

// ---------------------------------------------------------------------------
// Quote Checker - standalone, ad-hoc, never persisted.
// ---------------------------------------------------------------------------

export interface QuoteCheckerInput {
  // PROFITABILITY panel (own labour)
  hoursRequired: number;
  resourcesRequired: number;
  labourProfitMargin: number; // 0-1
  materialsCostCents: number;
  materialsProfitMargin: number; // 0-1
  actualHoursTaken?: number;
  // ALTERNATE PRICING panel
  alternateRateCents: number;
  alternateQuantity: number;
  // USING CONTRACT LABOUR panel
  contractorCostPerHourCents: number;
  contractorChargeOutRateCents: number;
  contractorHoursRequired: number;
}

export interface QuoteCheckerResult {
  profitability: {
    costAtEfficiencyCents: number;
    requiredChargeLabourOnlyCents: number;
    profitLossOnLabourCents: number;
    requiredChargeMaterialsOnlyCents: number;
    materialsProfitCents: number;
    totalChargeForJobCents: number;
    gstCents: number;
    totalJobValueIncGstCents: number;
    totalProfitForJobCents: number;
    actualCostCents: number | null;
    actualProfitLossCents: number | null;
    profitLostPerExtraHourCents: number | null;
  };
  alternatePricing: {
    totalExGstCents: number;
    gstCents: number;
    totalIncGstCents: number;
  };
  contractLabour: {
    costCents: number;
    chargeExGstCents: number;
    chargeIncGstCents: number;
    profitLossCents: number;
  };
}

export function calculateQuoteChecker(input: QuoteCheckerInput, cooHourRawCents: number, settings: CostOfOpsSettings): QuoteCheckerResult {
  const efficiency = settings.estimated_efficiency_rate > 0 ? settings.estimated_efficiency_rate : 1;
  const cooHourAtEfficiencyCents = cooHourRawCents / efficiency;

  const costAtEfficiencyCents = cooHourAtEfficiencyCents * input.hoursRequired * input.resourcesRequired;
  const requiredChargeLabourOnlyCents =
    input.labourProfitMargin < 1 ? costAtEfficiencyCents / (1 - input.labourProfitMargin) : costAtEfficiencyCents;
  const profitLossOnLabourCents = requiredChargeLabourOnlyCents - costAtEfficiencyCents;

  const requiredChargeMaterialsOnlyCents =
    input.materialsProfitMargin < 1 ? input.materialsCostCents / (1 - input.materialsProfitMargin) : input.materialsCostCents;
  const materialsProfitCents = requiredChargeMaterialsOnlyCents - input.materialsCostCents;

  const totalChargeForJobCents = requiredChargeLabourOnlyCents + requiredChargeMaterialsOnlyCents;
  const gstCents = totalChargeForJobCents * AU_GST_RATE;
  const totalJobValueIncGstCents = totalChargeForJobCents + gstCents;
  const totalProfitForJobCents = profitLossOnLabourCents + materialsProfitCents;

  let actualCostCents: number | null = null;
  let actualProfitLossCents: number | null = null;
  let profitLostPerExtraHourCents: number | null = null;
  if (input.actualHoursTaken !== undefined) {
    actualCostCents = cooHourAtEfficiencyCents * input.actualHoursTaken * input.resourcesRequired;
    actualProfitLossCents = requiredChargeLabourOnlyCents - actualCostCents;
    const extraHours = input.actualHoursTaken - input.hoursRequired;
    profitLostPerExtraHourCents = extraHours > 0 ? (actualCostCents - costAtEfficiencyCents) / extraHours : 0;
  }

  const alternateTotalExGstCents = input.alternateRateCents * input.alternateQuantity;
  const alternateGstCents = alternateTotalExGstCents * AU_GST_RATE;

  const contractLabourCostCents = input.contractorCostPerHourCents * input.contractorHoursRequired;
  const contractLabourChargeExGstCents = input.contractorChargeOutRateCents * input.contractorHoursRequired;

  return {
    profitability: {
      costAtEfficiencyCents,
      requiredChargeLabourOnlyCents,
      profitLossOnLabourCents,
      requiredChargeMaterialsOnlyCents,
      materialsProfitCents,
      totalChargeForJobCents,
      gstCents,
      totalJobValueIncGstCents,
      totalProfitForJobCents,
      actualCostCents,
      actualProfitLossCents,
      profitLostPerExtraHourCents,
    },
    alternatePricing: {
      totalExGstCents: alternateTotalExGstCents,
      gstCents: alternateGstCents,
      totalIncGstCents: alternateTotalExGstCents + alternateGstCents,
    },
    contractLabour: {
      costCents: contractLabourCostCents,
      chargeExGstCents: contractLabourChargeExGstCents,
      chargeIncGstCents: contractLabourChargeExGstCents * (1 + AU_GST_RATE),
      profitLossCents: contractLabourChargeExGstCents - contractLabourCostCents,
    },
  };
}

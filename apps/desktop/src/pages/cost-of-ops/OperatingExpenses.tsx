import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  calculateOperatingExpenses,
  createOperatingExpenseSchema,
  formatCentsAsAud,
  updateCostOfOpsSettingsSchema,
  type CostOfOpsSettings,
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

export default function OperatingExpensesPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["cost-of-ops-settings"], queryFn: fetchSettings });
  const { data: expenses } = useQuery({ queryKey: ["operating-expenses"], queryFn: fetchExpenses });

  const result = settings && expenses ? calculateOperatingExpenses(expenses, settings) : null;

  // --- Edit a line item's Monthly/Budget amounts ---
  const [editingExpense, setEditingExpense] = useState<OperatingExpense | null>(null);
  const [lineForm, setLineForm] = useState({ account_name: "", monthly_amount: "", budget_amount: "" });
  const [lineError, setLineError] = useState<string | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);

  const openEditLine = (expense: OperatingExpense) => {
    setEditingExpense(expense);
    setLineForm({
      account_name: expense.account_name,
      monthly_amount: expense.monthly_amount_cents ? (expense.monthly_amount_cents / 100).toString() : "",
      budget_amount: expense.budget_amount_cents != null ? (expense.budget_amount_cents / 100).toString() : "",
    });
    setLineError(null);
  };
  const openAddLine = () => {
    setEditingExpense(null);
    setLineForm({ account_name: "", monthly_amount: "", budget_amount: "" });
    setLineError(null);
    setAddModalOpen(true);
  };

  const saveLine = useMutation({
    mutationFn: async () => {
      const result = createOperatingExpenseSchema.safeParse({
        account_name: lineForm.account_name,
        monthly_amount_cents: Math.round(Number(lineForm.monthly_amount || 0) * 100),
        budget_amount_cents: lineForm.budget_amount ? Math.round(Number(lineForm.budget_amount) * 100) : undefined,
        is_default_category: editingExpense?.is_default_category ?? false,
        sort_order: editingExpense?.sort_order ?? (expenses?.length ?? 0) + 1,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid line item");

      if (editingExpense) {
        const { error } = await supabase
          .from("operating_expenses")
          .update({
            account_name: result.data.account_name,
            monthly_amount_cents: result.data.monthly_amount_cents,
            budget_amount_cents: result.data.budget_amount_cents ?? null,
          })
          .eq("id", editingExpense.id);
        if (error) throw error;
      } else {
        if (!settings) throw new Error("Settings not loaded");
        const { error } = await supabase.from("operating_expenses").insert({
          tenant_id: settings.tenant_id,
          account_name: result.data.account_name,
          monthly_amount_cents: result.data.monthly_amount_cents,
          budget_amount_cents: result.data.budget_amount_cents ?? null,
          is_default_category: false,
          sort_order: result.data.sort_order,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["operating-expenses"] });
      setEditingExpense(null);
      setAddModalOpen(false);
    },
    onError: (e) => setLineError(getErrorMessage(e, "Failed to save line item")),
  });

  const deleteLine = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("operating_expenses").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["operating-expenses"] }),
  });

  // --- Assumptions: vehicles/buffer (this tab's slice of cost_of_ops_settings) ---
  const [assumptionsModalOpen, setAssumptionsModalOpen] = useState(false);
  const [vehiclesOwned, setVehiclesOwned] = useState("0");
  const [vehicleHoldingCost, setVehicleHoldingCost] = useState("0");
  const [bufferPercent, setBufferPercent] = useState("0");
  const [assumptionsError, setAssumptionsError] = useState<string | null>(null);

  const openAssumptions = () => {
    if (!settings) return;
    setVehiclesOwned(String(settings.vehicles_owned));
    setVehicleHoldingCost((settings.vehicle_holding_cost_cents / 100).toString());
    setBufferPercent((settings.buffer_percent * 100).toString());
    setAssumptionsError(null);
    setAssumptionsModalOpen(true);
  };

  const saveAssumptions = useMutation({
    mutationFn: async () => {
      if (!settings) throw new Error("Settings not loaded");
      const parsed = updateCostOfOpsSettingsSchema.safeParse({
        ...settings,
        vehicles_owned: Math.round(Number(vehiclesOwned || 0)),
        vehicle_holding_cost_cents: Math.round(Number(vehicleHoldingCost || 0) * 100),
        buffer_percent: Number(bufferPercent || 0) / 100,
      });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid settings");
      const { error } = await supabase
        .from("cost_of_ops_settings")
        .update({
          vehicles_owned: parsed.data.vehicles_owned,
          vehicle_holding_cost_cents: parsed.data.vehicle_holding_cost_cents,
          buffer_percent: parsed.data.buffer_percent,
        })
        .eq("id", settings.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cost-of-ops-settings"] });
      setAssumptionsModalOpen(false);
    },
    onError: (e) => setAssumptionsError(getErrorMessage(e, "Failed to save assumptions")),
  });

  const isLoading = !settings || !expenses || !result;

  return (
    <div style={{ fontFamily: "var(--jms-font)" }}>
      <div
        className="mb-4 flex items-center justify-between rounded-lg p-4"
        style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
      >
        <div className="flex gap-8" style={{ fontSize: "var(--jms-font-body)" }}>
          <div>
            <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Vehicles Owned
            </p>
            <p className="font-bold" style={{ color: "var(--jms-text)" }}>
              {settings?.vehicles_owned ?? "-"}
            </p>
          </div>
          <div>
            <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Vehicle Holding Cost (monthly, each)
            </p>
            <p className="font-bold" style={{ color: "var(--jms-text)" }}>
              {settings ? formatCentsAsAud(settings.vehicle_holding_cost_cents) : "-"}
            </p>
          </div>
          <div>
            <p className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Buffer
            </p>
            <p className="font-bold" style={{ color: "var(--jms-text)" }}>
              {settings ? `${(settings.buffer_percent * 100).toFixed(1)}%` : "-"}
            </p>
          </div>
        </div>
        <ThemedButton variant="secondary" onClick={openAssumptions} style={{ paddingBlock: 6, paddingInline: 12 }}>
          Edit
        </ThemedButton>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Expense Line Items
        </h2>
        <ThemedButton onClick={openAddLine} style={{ paddingBlock: 6, paddingInline: 12 }}>
          + Add expense
        </ThemedButton>
      </div>

      <div className="overflow-hidden rounded-lg" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {isLoading ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Loading...
          </p>
        ) : (
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead
              className="uppercase"
              style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
              <tr>
                <th className="px-4 py-2 font-semibold">Account</th>
                <th className="px-4 py-2 text-right font-semibold">Monthly</th>
                <th className="px-4 py-2 text-right font-semibold">Budget</th>
                <th className="px-4 py-2 text-right font-semibold">Difference</th>
                <th className="px-4 py-2 text-right font-semibold">% of Total</th>
                <th className="px-4 py-2 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {result!.lines.map(({ expense, differenceCents, percentOfTotal }) => (
                <tr key={expense.id} className="last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                  <td className="px-4 py-2 font-medium" style={{ color: "var(--jms-text)" }}>
                    {expense.account_name}
                    {!expense.is_default_category ? (
                      <span
                        className="ml-2 rounded-full px-2 py-0.5 font-semibold"
                        style={{ backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                      >
                        Custom
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-right" style={{ color: "var(--jms-text)" }}>
                    {formatCentsAsAud(expense.monthly_amount_cents)}
                  </td>
                  <td className="px-4 py-2 text-right" style={{ color: "var(--jms-text)" }}>
                    {expense.budget_amount_cents != null ? formatCentsAsAud(expense.budget_amount_cents) : "-"}
                  </td>
                  <td className="px-4 py-2 text-right" style={{ color: differenceCents < 0 ? "var(--jms-danger)" : "var(--jms-text)" }}>
                    {expense.budget_amount_cents != null ? formatCentsAsAud(differenceCents) : "-"}
                  </td>
                  <td className="px-4 py-2 text-right" style={{ color: "var(--jms-text-muted)" }}>
                    {(percentOfTotal * 100).toFixed(1)}%
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => openEditLine(expense)}
                      className="mr-3 font-semibold hover:underline"
                      style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteLine.mutate(expense.id)}
                      className="font-semibold hover:underline"
                      style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            {result ? (
              <tfoot className="font-bold" style={{ borderTop: "2px solid var(--jms-border)", backgroundColor: "var(--jms-bg)" }}>
                <tr>
                  <td className="px-4 py-3" style={{ color: "var(--jms-text)" }}>
                    Total Monthly
                  </td>
                  <td className="px-4 py-3 text-right" style={{ color: "var(--jms-text)" }}>
                    {formatCentsAsAud(result.totalMonthlyCents)}
                  </td>
                  <td colSpan={4} />
                </tr>
                <tr>
                  <td className="px-4 py-3" style={{ color: "var(--jms-text)" }}>
                    + Vehicle Allowance
                  </td>
                  <td className="px-4 py-3 text-right" style={{ color: "var(--jms-text)" }}>
                    {formatCentsAsAud(result.vehicleCostCents)}
                  </td>
                  <td colSpan={4} />
                </tr>
                <tr style={{ borderTop: "1px solid var(--jms-border)" }}>
                  <td className="px-4 py-3" style={{ color: "var(--jms-text)" }}>
                    Total Operating Expense (w/ buffer)
                  </td>
                  <td className="px-4 py-3 text-right" style={{ color: "var(--jms-accent)" }}>
                    {formatCentsAsAud(result.totalOperatingExpenseCents)}
                  </td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            ) : null}
          </table>
        )}
      </div>

      <ThemedModal
        open={!!editingExpense || addModalOpen}
        onClose={() => {
          setEditingExpense(null);
          setAddModalOpen(false);
        }}
        title={editingExpense ? "Edit expense" : "Add expense"}
      >
        <ThemedFormField
          label="Account name"
          value={lineForm.account_name}
          onChange={(e) => setLineForm({ ...lineForm, account_name: e.target.value })}
          disabled={!!editingExpense?.is_default_category}
        />
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField
            label="Monthly amount ($)"
            type="number"
            step="0.01"
            value={lineForm.monthly_amount}
            onChange={(e) => setLineForm({ ...lineForm, monthly_amount: e.target.value })}
          />
          <ThemedFormField
            label="Budget amount ($, optional)"
            type="number"
            step="0.01"
            value={lineForm.budget_amount}
            onChange={(e) => setLineForm({ ...lineForm, budget_amount: e.target.value })}
          />
        </div>
        {lineError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {lineError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button
            onClick={() => {
              setEditingExpense(null);
              setAddModalOpen(false);
            }}
            className="px-4 py-2 font-semibold"
            style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
          >
            Cancel
          </button>
          <ThemedButton onClick={() => saveLine.mutate()} disabled={saveLine.isPending || !lineForm.account_name.trim()}>
            {saveLine.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal open={assumptionsModalOpen} onClose={() => setAssumptionsModalOpen(false)} title="Edit vehicle & buffer assumptions">
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField label="Vehicles owned" type="number" value={vehiclesOwned} onChange={(e) => setVehiclesOwned(e.target.value)} />
          <ThemedFormField
            label="Vehicle holding cost ($/month, each)"
            type="number"
            step="0.01"
            value={vehicleHoldingCost}
            onChange={(e) => setVehicleHoldingCost(e.target.value)}
          />
        </div>
        <ThemedFormField label="Buffer (%)" type="number" step="0.1" value={bufferPercent} onChange={(e) => setBufferPercent(e.target.value)} />
        {assumptionsError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {assumptionsError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button
            onClick={() => setAssumptionsModalOpen(false)}
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

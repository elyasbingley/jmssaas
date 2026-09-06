import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createJobConcreteCalculationSchema, type JobConcreteCalculation } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { FormField } from "../FormField";

// Concrete Volume Calculator - Volume = L x W x D x (1 + waste%), bags =
// volume x 108 (the standard yield of a 20kg premix bag, ~0.00926 m³/bag).
// A calculation is a one-shot record (no update policy on the table,
// matching the migration's own "recalculation is a new row" comment), so
// there's no draft/save distinction here like the other tools - filling
// the form computes live, "Save" just persists whatever's currently shown.

const BAGS_PER_CUBIC_METRE = 108;

async function fetchCalculations(jobCardId: string): Promise<JobConcreteCalculation[]> {
  const { data, error } = await supabase
    .from("job_concrete_calculations")
    .select("*")
    .eq("job_card_id", jobCardId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobConcreteCalculation[];
}

export function ConcreteCalculator({ jobCardId }: { jobCardId: string }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data: calculations } = useQuery({ queryKey: ["job-concrete-calculations", jobCardId], queryFn: () => fetchCalculations(jobCardId) });

  const [name, setName] = useState("");
  const [length, setLength] = useState("");
  const [width, setWidth] = useState("");
  const [depth, setDepth] = useState("");
  const [waste, setWaste] = useState("10");

  const { totalCubicMetres, bags } = useMemo(() => {
    const l = Number(length) || 0;
    const w = Number(width) || 0;
    const d = Number(depth) || 0;
    const wastePercent = Number(waste) || 0;
    const volume = l * w * d * (1 + wastePercent / 100);
    return { totalCubicMetres: volume, bags: Math.ceil(volume * BAGS_PER_CUBIC_METRE) };
  }, [length, width, depth, waste]);

  const [saveError, setSaveError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const result = createJobConcreteCalculationSchema.safeParse({
        job_card_id: jobCardId,
        calculation_name: name,
        length_meters: Number(length),
        width_meters: Number(width),
        depth_meters: Number(depth),
        waste_percentage: Number(waste),
        total_cubic_meters: Math.round(totalCubicMetres * 1000) / 1000,
        estimated_bags_20kg: bags,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");

      const { error } = await supabase.from("job_concrete_calculations").insert({
        tenant_id: profile.tenant_id,
        job_card_id: jobCardId,
        calculation_name: result.data.calculation_name,
        length_meters: result.data.length_meters,
        width_meters: result.data.width_meters,
        depth_meters: result.data.depth_meters,
        waste_percentage: result.data.waste_percentage,
        total_cubic_meters: result.data.total_cubic_meters,
        estimated_bags_20kg: result.data.estimated_bags_20kg,
        created_by: profile.id,
      });
      if (error) throw error;

      const noteLines = [
        `Concrete Calculation - ${result.data.calculation_name}`,
        `${result.data.length_meters}m x ${result.data.width_meters}m x ${result.data.depth_meters}m, +${result.data.waste_percentage}% waste`,
        `Total: ${result.data.total_cubic_meters.toFixed(2)} m³ (~${result.data.estimated_bags_20kg} x 20kg premix bags)`,
      ];
      const { error: noteError } = await supabase.from("job_notes").insert({
        tenant_id: profile.tenant_id,
        job_card_id: jobCardId,
        author_id: profile.id,
        body: noteLines.join("\n"),
      });
      if (noteError) throw noteError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-concrete-calculations", jobCardId] });
      queryClient.invalidateQueries({ queryKey: ["job-notes", jobCardId] });
      setName("");
      setLength("");
      setWidth("");
      setDepth("");
      setWaste("10");
      setSaveError(null);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save calculation")),
  });

  return (
    <div>
      <FormField label="Calculation name" placeholder='e.g. "Driveway Pour"' value={name} onChange={(e) => setName(e.target.value)} />
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <FormField label="Length (m)" type="number" step="0.01" value={length} onChange={(e) => setLength(e.target.value)} />
        <FormField label="Width (m)" type="number" step="0.01" value={width} onChange={(e) => setWidth(e.target.value)} />
        <FormField label="Depth (m)" type="number" step="0.01" placeholder="e.g. 0.1 for 100mm" value={depth} onChange={(e) => setDepth(e.target.value)} />
        <FormField label="Waste %" type="number" step="1" value={waste} onChange={(e) => setWaste(e.target.value)} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center">
          <p className="text-xs uppercase tracking-wide text-gray-500">Total Cubic Metres</p>
          <p className="text-2xl font-bold text-gray-900">{totalCubicMetres.toFixed(2)} m³</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center">
          <p className="text-xs uppercase tracking-wide text-gray-500">20kg Bag Estimate</p>
          <p className="text-2xl font-bold text-blue-700">{bags}</p>
        </div>
      </div>

      {saveError ? <p className="mt-3 text-sm text-red-600">{saveError}</p> : null}
      <button
        onClick={() => save.mutate()}
        disabled={save.isPending || !name.trim() || totalCubicMetres <= 0}
        className="mt-4 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
      >
        {save.isPending ? "Saving..." : "Save Concrete Calculation to Job Notes"}
      </button>

      {calculations && calculations.length > 0 ? (
        <div className="mt-6">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">Past calculations</h3>
          <div className="space-y-2">
            {calculations.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-gray-200 p-2 text-sm">
                <span className="font-semibold text-gray-900">{c.calculation_name}</span>
                <span className="text-gray-600">
                  {c.total_cubic_meters.toFixed(2)} m³ &middot; {c.estimated_bags_20kg} bags
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

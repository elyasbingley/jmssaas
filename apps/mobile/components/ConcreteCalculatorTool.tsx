import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { createJobConcreteCalculationSchema, type JobConcreteCalculation } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { FormField } from "./FormField";

// Concrete Volume Calculator (mobile) - same Volume = L x W x D x
// (1 + waste%), bags = volume x 108 formula as desktop's
// ConcreteCalculator.tsx. A calculation is a one-shot record (no update
// policy on the table), so there's no draft/save distinction - filling
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

export function ConcreteCalculatorTool({ jobCardId }: { jobCardId: string }) {
  const { profile } = useAuth();
  const [calculations, setCalculations] = useState<JobConcreteCalculation[]>([]);

  useMemo(() => {
    fetchCalculations(jobCardId)
      .then(setCalculations)
      .catch((e) => console.error("[ConcreteCalculator] Failed to load calculations", e));
  }, [jobCardId]);

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

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!profile) return;
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
    if (!result.success) {
      setSaveError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
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

      const updated = await fetchCalculations(jobCardId);
      setCalculations(updated);
      setName("");
      setLength("");
      setWidth("");
      setDepth("");
      setWaste("10");
    } catch (e) {
      setSaveError(getErrorMessage(e, "Failed to save calculation"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      <FormField label="Calculation name" placeholder='e.g. "Driveway Pour"' value={name} onChangeText={setName} />
      <View style={styles.dimensionsRow}>
        <View style={styles.dimensionField}>
          <FormField label="Length (m)" keyboardType="decimal-pad" value={length} onChangeText={setLength} />
        </View>
        <View style={styles.dimensionField}>
          <FormField label="Width (m)" keyboardType="decimal-pad" value={width} onChangeText={setWidth} />
        </View>
      </View>
      <View style={styles.dimensionsRow}>
        <View style={styles.dimensionField}>
          <FormField label="Depth (m)" placeholder="e.g. 0.1 for 100mm" keyboardType="decimal-pad" value={depth} onChangeText={setDepth} />
        </View>
        <View style={styles.dimensionField}>
          <FormField label="Waste %" keyboardType="decimal-pad" value={waste} onChangeText={setWaste} />
        </View>
      </View>

      <View style={styles.resultsRow}>
        <View style={styles.resultBox}>
          <Text style={styles.resultLabel}>Total Cubic Metres</Text>
          <Text style={styles.resultValue}>{totalCubicMetres.toFixed(2)} m³</Text>
        </View>
        <View style={styles.resultBox}>
          <Text style={styles.resultLabel}>20kg Bag Estimate</Text>
          <Text style={[styles.resultValue, styles.resultValueAccent]}>{bags}</Text>
        </View>
      </View>

      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
      <Pressable
        style={[styles.saveButton, (saving || !name.trim() || totalCubicMetres <= 0) && styles.saveButtonDisabled]}
        onPress={handleSave}
        disabled={saving || !name.trim() || totalCubicMetres <= 0}
      >
        <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save Concrete Calculation to Job Notes"}</Text>
      </Pressable>

      {calculations.length > 0 ? (
        <View style={styles.pastList}>
          <Text style={styles.pastHeading}>Past calculations</Text>
          {calculations.map((c) => (
            <View key={c.id} style={styles.pastRow}>
              <Text style={styles.pastName}>{c.calculation_name}</Text>
              <Text style={styles.pastValue}>
                {c.total_cubic_meters.toFixed(2)} m³ · {c.estimated_bags_20kg} bags
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dimensionsRow: { flexDirection: "row", gap: 12, marginTop: 8 },
  dimensionField: { flex: 1 },
  resultsRow: { flexDirection: "row", gap: 12, marginTop: 16 },
  resultBox: { flex: 1, backgroundColor: "#f9fafb", borderRadius: 10, padding: 14, alignItems: "center" },
  resultLabel: { fontSize: 11, textTransform: "uppercase", color: "#6b7280" },
  resultValue: { fontSize: 22, fontWeight: "700", color: "#111827", marginTop: 4 },
  resultValueAccent: { color: "#1d4ed8" },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingVertical: 14, alignItems: "center", marginTop: 16 },
  saveButtonDisabled: { opacity: 0.6 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  error: { color: "#dc2626", marginTop: 10 },
  pastList: { marginTop: 20, gap: 6 },
  pastHeading: { fontSize: 11, fontWeight: "700", textTransform: "uppercase", color: "#6b7280", marginBottom: 4 },
  pastRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 10, padding: 10 },
  pastName: { fontSize: 14, fontWeight: "600", color: "#111827" },
  pastValue: { fontSize: 13, color: "#374151" },
});

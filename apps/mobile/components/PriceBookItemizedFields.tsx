import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  computeItemizedLinePricing,
  formatCentsAsAud,
  marginPercentToMarkupPercent,
  type LabourCostEntry,
  type LineItemCrewInput,
  type LineItemFormInput,
  type LineItemMaterialInput,
} from "@jmssaas/shared";
import { CenteredModal } from "./CenteredModal";
import { supabase } from "../lib/supabase";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";

// Mobile port of apps/desktop/src/components/PriceBookItemizedFields.tsx -
// same fields/behaviour, same reasoning for being a new, separate
// component rather than a refactor of components/LineItemEditor.tsx (the
// most heavily-used screen in the app). See that file's own comment.

export type PriceBookPricingFields = Pick<
  LineItemFormInput,
  | "pricing_model"
  | "quantity"
  | "labour_rate_cents"
  | "labour_hours"
  | "labour_cost_rate_cents"
  | "labour_charge_out_rate_cents"
  | "crew"
  | "material_cost_cents"
  | "materials"
  | "markup_percent"
  | "material_margin_percent"
  | "waste_percent"
  | "contingency_percent"
  | "tip_fees_cents"
  | "equipment_hire_cents"
  | "travel_cost_cents"
  | "is_subcontracted"
  | "subcontractor_cost_cents"
  | "subcontractor_margin_percent"
>;

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

function DecimalInput({ value, onChangeValue, placeholder }: { value: number; onChangeValue: (n: number) => void; placeholder?: string }) {
  const styles = useThemedStyles(createStyles);
  const [text, setText] = useState(() => (value === 0 ? "" : String(value)));
  return (
    <TextInput
      style={styles.input}
      placeholder={placeholder}
      placeholderTextColor={styles.placeholder.color}
      keyboardType="decimal-pad"
      value={text}
      onChangeText={(next) => {
        if (!/^\d*\.?\d*$/.test(next)) return;
        setText(next);
        onChangeValue(parseNumber(next));
      }}
    />
  );
}

function MarginField({ value, onChangeValue }: { value: number; onChangeValue: (n: number) => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View>
      <DecimalInput value={value} onChangeValue={onChangeValue} placeholder="%" />
      <Text style={styles.marginHint}>= {marginPercentToMarkupPercent(value).toFixed(2)}% markup</Text>
    </View>
  );
}

function RosterPicker({
  entries,
  value,
  onSelect,
}: {
  entries: LabourCostEntry[];
  value: string | null | undefined;
  onSelect: (entry: LabourCostEntry | null) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const selected = entries.find((e) => e.id === value);
  return (
    <View>
      <Pressable style={styles.input} onPress={() => setOpen(true)}>
        <Text style={styles.pickerValueText}>{selected ? selected.name ?? selected.role_type : "Ad-hoc worker"}</Text>
      </Pressable>
      <CenteredModal visible={open} onClose={() => setOpen(false)}>
        <Text style={styles.modalTitle}>Select from Cost of Ops roster</Text>
        <Pressable
          style={styles.variationRow}
          onPress={() => {
            onSelect(null);
            setOpen(false);
          }}
        >
          <Text style={styles.variationRowText}>Ad-hoc worker (no link)</Text>
        </Pressable>
        {entries.map((entry) => (
          <Pressable
            key={entry.id}
            style={styles.variationRow}
            onPress={() => {
              onSelect(entry);
              setOpen(false);
            }}
          >
            <Text style={styles.variationRowText}>{entry.name ?? entry.role_type}</Text>
          </Pressable>
        ))}
      </CenteredModal>
    </View>
  );
}

function CrewEditor({
  crew,
  labourCostEntries,
  onChange,
}: {
  crew: LineItemCrewInput[];
  labourCostEntries: LabourCostEntry[];
  onChange: (crew: LineItemCrewInput[]) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const updateRow = (i: number, patch: Partial<LineItemCrewInput>) => onChange(crew.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const removeRow = (i: number) => onChange(crew.filter((_, idx) => idx !== i));
  const addRow = () => onChange([...crew, { worker_name: "", cost_rate_cents: 0, charge_out_rate_cents: 0, hours: 0, sort_order: crew.length }]);

  return (
    <View style={styles.subPanel}>
      <View style={styles.subPanelHeader}>
        <Text style={styles.subPanelTitle}>Crew</Text>
        <Pressable onPress={addRow}>
          <Text style={styles.link}>+ Add worker</Text>
        </Pressable>
      </View>
      {crew.map((c, i) => (
        <View key={i} style={styles.subRow}>
          {labourCostEntries.length > 0 ? (
            <RosterPicker
              entries={labourCostEntries}
              value={c.labour_cost_entry_id}
              onSelect={(entry) =>
                updateRow(i, {
                  labour_cost_entry_id: entry?.id ?? null,
                  worker_name: entry ? entry.name ?? c.worker_name : c.worker_name,
                  cost_rate_cents: entry?.hourly_rate_cents ?? c.cost_rate_cents,
                })
              }
            />
          ) : null}
          <TextInput
            style={styles.input}
            placeholder="Worker name"
            placeholderTextColor={styles.placeholder.color}
            value={c.worker_name}
            onChangeText={(text) => updateRow(i, { worker_name: text })}
          />
          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Cost $/hr</Text>
              <DecimalInput value={c.cost_rate_cents / 100} onChangeValue={(n) => updateRow(i, { cost_rate_cents: Math.round(n * 100) })} />
            </View>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Charge $/hr</Text>
              <DecimalInput value={c.charge_out_rate_cents / 100} onChangeValue={(n) => updateRow(i, { charge_out_rate_cents: Math.round(n * 100) })} />
            </View>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Hours</Text>
              <DecimalInput value={c.hours} onChangeValue={(n) => updateRow(i, { hours: n })} />
            </View>
          </View>
          <Pressable onPress={() => removeRow(i)}>
            <Text style={styles.removeButtonText}>Remove worker</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function MaterialsEditor({ materials, onChange }: { materials: LineItemMaterialInput[]; onChange: (materials: LineItemMaterialInput[]) => void }) {
  const styles = useThemedStyles(createStyles);
  const updateRow = (i: number, patch: Partial<LineItemMaterialInput>) =>
    onChange(materials.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  const removeRow = (i: number) => onChange(materials.filter((_, idx) => idx !== i));
  const addRow = () => onChange([...materials, { description: "", quantity: 1, unit_cost_cents: 0, sort_order: materials.length }]);
  const subtotalCents = materials.reduce((sum, m) => sum + Math.round(m.quantity * m.unit_cost_cents), 0);

  return (
    <View style={styles.subPanel}>
      <View style={styles.subPanelHeader}>
        <Text style={styles.subPanelTitle}>Materials</Text>
        <Pressable onPress={addRow}>
          <Text style={styles.link}>+ Add material</Text>
        </Pressable>
      </View>
      {materials.map((m, i) => (
        <View key={i} style={styles.subRow}>
          <TextInput
            style={styles.input}
            placeholder="Description"
            placeholderTextColor={styles.placeholder.color}
            value={m.description}
            onChangeText={(text) => updateRow(i, { description: text })}
          />
          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Qty</Text>
              <DecimalInput value={m.quantity} onChangeValue={(n) => updateRow(i, { quantity: n })} />
            </View>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Unit cost $</Text>
              <DecimalInput value={m.unit_cost_cents / 100} onChangeValue={(n) => updateRow(i, { unit_cost_cents: Math.round(n * 100) })} />
            </View>
          </View>
          <Pressable onPress={() => removeRow(i)}>
            <Text style={styles.removeButtonText}>Remove material</Text>
          </Pressable>
        </View>
      ))}
      {materials.length > 0 ? (
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>Materials subtotal</Text>
          <Text style={styles.totalsValue}>{formatCentsAsAud(subtotalCents)}</Text>
        </View>
      ) : null}
    </View>
  );
}

function ReadoutStat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.readoutCell}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.readoutValue, warn && styles.readoutValueWarn]}>{value}</Text>
    </View>
  );
}

function LiveReadout({ item }: { item: PriceBookPricingFields }) {
  const styles = useThemedStyles(createStyles);
  const pricing = computeItemizedLinePricing(item);
  return (
    <View style={styles.readoutBox}>
      <View style={styles.readoutRow}>
        <ReadoutStat label="Cost" value={formatCentsAsAud(pricing.totalCostCents)} />
        <ReadoutStat label="Profit" value={formatCentsAsAud(pricing.profitCents)} warn={pricing.profitCents < 0} />
      </View>
      <View style={styles.readoutRow}>
        <ReadoutStat label="Margin" value={`${pricing.marginPercent.toFixed(1)}%`} warn={pricing.marginPercent < 0} />
        <ReadoutStat label="Markup" value={`${pricing.markupPercent.toFixed(1)}%`} warn={pricing.markupPercent < 0} />
      </View>
      <View style={styles.readoutRow}>
        <ReadoutStat label="Effective $/hr" value={formatCentsAsAud(pricing.effectiveHourlyRateCents)} warn={pricing.effectiveHourlyRateCents < 0} />
      </View>
    </View>
  );
}

export function PriceBookItemizedFields({
  value,
  onChange,
}: {
  value: PriceBookPricingFields;
  onChange: (patch: Partial<PriceBookPricingFields>) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [labourCostEntries, setLabourCostEntries] = useState<LabourCostEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("labour_cost_entries")
      .select("*")
      .then(({ data }) => {
        if (!cancelled) setLabourCostEntries((data ?? []) as LabourCostEntry[]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const itemized = value.pricing_model === "itemized";
  const crew = value.crew ?? [];
  const materials = value.materials ?? [];

  const togglePricingModel = () => {
    if (itemized) onChange({ pricing_model: "legacy", crew: [], materials: [] });
    else onChange({ pricing_model: "itemized" });
  };

  return (
    <View>
      <View style={styles.pricingToggleRow}>
        <Pressable style={[styles.pricingToggleButton, !itemized && styles.pricingToggleButtonActive]} onPress={togglePricingModel}>
          <Text style={[styles.pricingToggleText, !itemized && styles.pricingToggleTextActive]}>Simple</Text>
        </Pressable>
        <Pressable style={[styles.pricingToggleButton, itemized && styles.pricingToggleButtonActive]} onPress={togglePricingModel}>
          <Text style={[styles.pricingToggleText, itemized && styles.pricingToggleTextActive]}>Itemised</Text>
        </Pressable>
      </View>

      {!itemized ? (
        <>
          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Labour rate ($/hr)</Text>
              <DecimalInput value={value.labour_rate_cents / 100} onChangeValue={(n) => onChange({ labour_rate_cents: Math.round(n * 100) })} />
            </View>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Labour hours</Text>
              <DecimalInput value={value.labour_hours} onChangeValue={(n) => onChange({ labour_hours: n })} />
            </View>
          </View>
          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Material cost ($)</Text>
              <DecimalInput value={value.material_cost_cents / 100} onChangeValue={(n) => onChange({ material_cost_cents: Math.round(n * 100) })} />
            </View>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Markup (%)</Text>
              <DecimalInput value={value.markup_percent} onChangeValue={(n) => onChange({ markup_percent: n })} />
            </View>
          </View>
        </>
      ) : (
        <>
          {crew.length === 0 ? (
            <View style={styles.fieldGrid}>
              <View style={styles.fieldCell}>
                <Text style={styles.fieldLabel}>Labour cost rate ($/hr)</Text>
                <DecimalInput
                  value={(value.labour_cost_rate_cents ?? 0) / 100}
                  onChangeValue={(n) => onChange({ labour_cost_rate_cents: Math.round(n * 100) })}
                />
              </View>
              <View style={styles.fieldCell}>
                <Text style={styles.fieldLabel}>Charge-out rate ($/hr)</Text>
                <DecimalInput
                  value={(value.labour_charge_out_rate_cents ?? 0) / 100}
                  onChangeValue={(n) => onChange({ labour_charge_out_rate_cents: Math.round(n * 100) })}
                />
              </View>
              <View style={styles.fieldCell}>
                <Text style={styles.fieldLabel}>Labour hours</Text>
                <DecimalInput value={value.labour_hours} onChangeValue={(n) => onChange({ labour_hours: n })} />
              </View>
            </View>
          ) : (
            <CrewEditor crew={crew} labourCostEntries={labourCostEntries} onChange={(nextCrew) => onChange({ crew: nextCrew })} />
          )}
          <Pressable
            onPress={() =>
              onChange(
                crew.length === 0
                  ? {
                      crew: [
                        {
                          worker_name: "",
                          cost_rate_cents: value.labour_cost_rate_cents ?? 0,
                          charge_out_rate_cents: value.labour_charge_out_rate_cents ?? 0,
                          hours: value.labour_hours,
                          sort_order: 0,
                        },
                      ],
                    }
                  : { crew: [] }
              )
            }
          >
            <Text style={styles.link}>{crew.length === 0 ? "+ Add crew (multiple workers)" : "Remove crew breakdown"}</Text>
          </Pressable>

          {materials.length === 0 ? (
            <View style={styles.fieldGrid}>
              <View style={styles.fieldCell}>
                <Text style={styles.fieldLabel}>Material cost ($)</Text>
                <DecimalInput value={value.material_cost_cents / 100} onChangeValue={(n) => onChange({ material_cost_cents: Math.round(n * 100) })} />
              </View>
            </View>
          ) : (
            <MaterialsEditor materials={materials} onChange={(nextMaterials) => onChange({ materials: nextMaterials })} />
          )}
          <Pressable
            onPress={() =>
              onChange(
                materials.length === 0
                  ? { materials: [{ description: "", quantity: 1, unit_cost_cents: value.material_cost_cents, sort_order: 0 }] }
                  : { materials: [] }
              )
            }
          >
            <Text style={styles.link}>{materials.length === 0 ? "+ Itemise materials" : "Remove itemised materials"}</Text>
          </Pressable>

          <View style={styles.fieldCell}>
            <Text style={styles.fieldLabel}>Material margin % (incl. waste/contingency/allowances below)</Text>
            <MarginField value={value.material_margin_percent ?? 0} onChangeValue={(n) => onChange({ material_margin_percent: n })} />
          </View>

          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Waste (%)</Text>
              <DecimalInput value={value.waste_percent ?? 0} onChangeValue={(n) => onChange({ waste_percent: n })} />
            </View>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Contingency (%)</Text>
              <DecimalInput value={value.contingency_percent ?? 0} onChangeValue={(n) => onChange({ contingency_percent: n })} />
            </View>
          </View>
          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Tip fees ($)</Text>
              <DecimalInput value={(value.tip_fees_cents ?? 0) / 100} onChangeValue={(n) => onChange({ tip_fees_cents: Math.round(n * 100) })} />
            </View>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Equipment/scaffold ($)</Text>
              <DecimalInput value={(value.equipment_hire_cents ?? 0) / 100} onChangeValue={(n) => onChange({ equipment_hire_cents: Math.round(n * 100) })} />
            </View>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Travel ($)</Text>
              <DecimalInput value={(value.travel_cost_cents ?? 0) / 100} onChangeValue={(n) => onChange({ travel_cost_cents: Math.round(n * 100) })} />
            </View>
          </View>
        </>
      )}

      <View style={styles.fieldGrid}>
        <View style={styles.fieldCell}>
          <Pressable
            style={[styles.subcontractedToggle, value.is_subcontracted && styles.subcontractedToggleActive]}
            onPress={() =>
              onChange({
                is_subcontracted: !value.is_subcontracted,
                subcontractor_cost_cents: !value.is_subcontracted ? value.subcontractor_cost_cents ?? 0 : 0,
              })
            }
          >
            <Text style={[styles.subcontractedToggleText, value.is_subcontracted && styles.subcontractedToggleTextActive]}>
              {value.is_subcontracted ? "Subcontracted" : "Not subcontracted"}
            </Text>
          </Pressable>
        </View>
        {value.is_subcontracted ? (
          <View style={styles.fieldCell}>
            <Text style={styles.fieldLabel}>Subcontractor cost ($, per unit)</Text>
            <DecimalInput
              value={(value.subcontractor_cost_cents ?? 0) / 100}
              onChangeValue={(n) => onChange({ subcontractor_cost_cents: Math.round(n * 100) })}
            />
          </View>
        ) : null}
      </View>
      {value.is_subcontracted && itemized ? (
        <View style={styles.fieldCell}>
          <Text style={styles.fieldLabel}>Subcontractor margin (%)</Text>
          <MarginField value={value.subcontractor_margin_percent ?? 0} onChangeValue={(n) => onChange({ subcontractor_margin_percent: n })} />
        </View>
      ) : null}

      {itemized ? <LiveReadout item={value} /> : null}
    </View>
  );
}

function createStyles({ tokens, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    input: { borderWidth: 1, borderColor: tokens.border, borderRadius: 8, padding: 10, fontSize: 15, color: tokens.textPrimary, backgroundColor: tokens.background, ...mono },
    placeholder: { color: tokens.textMuted },
    pickerValueText: { fontSize: 15, color: tokens.textPrimary, ...mono },
    fieldGrid: { flexDirection: "row" as const, gap: 8, marginTop: 12 },
    fieldCell: { flex: 1, gap: 4, marginTop: 12 },
    fieldLabel: { fontSize: 12, fontWeight: "600" as const, color: tokens.textMuted, ...mono },
    pricingToggleRow: { flexDirection: "row" as const, gap: 8, marginTop: 12 },
    pricingToggleButton: { flex: 1, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.background, alignItems: "center" as const },
    pricingToggleButtonActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    pricingToggleText: { color: tokens.textMuted, fontWeight: "700" as const, fontSize: 12, ...mono },
    pricingToggleTextActive: { color: tokens.accent },
    subcontractedToggle: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.background, alignItems: "center" as const },
    subcontractedToggleActive: { backgroundColor: tokens.warning, borderColor: tokens.warning },
    subcontractedToggleText: { color: tokens.textMuted, fontWeight: "700" as const, fontSize: 12, ...mono },
    subcontractedToggleTextActive: { color: tokens.background },
    marginHint: { marginTop: 4, fontSize: 11, color: tokens.textMuted, ...mono },
    subPanel: { borderWidth: 1, borderColor: tokens.border, borderRadius: 8, padding: 10, gap: 8, backgroundColor: tokens.background, marginTop: 12 },
    subPanelHeader: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const },
    subPanelTitle: { fontSize: 12, fontWeight: "700" as const, color: tokens.textMuted, textTransform: "uppercase" as const, letterSpacing: 0.5, ...mono },
    subRow: { gap: 6, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: tokens.border },
    modalTitle: { fontSize: 18, fontWeight: "700" as const, color: tokens.accent, letterSpacing: 1.5, textTransform: "uppercase" as const, ...mono },
    variationRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: tokens.border },
    variationRowText: { fontSize: 15, color: tokens.textPrimary, ...mono },
    link: { color: tokens.accent, fontWeight: "600" as const, fontSize: 13, ...mono },
    removeButtonText: { color: tokens.danger, fontWeight: "600" as const, fontSize: 12, ...mono },
    readoutBox: { borderWidth: 1, borderColor: tokens.border, borderRadius: 8, padding: 10, gap: 6, backgroundColor: tokens.background, marginTop: 12 },
    readoutRow: { flexDirection: "row" as const, gap: 12 },
    readoutCell: { flex: 1, gap: 2 },
    readoutValue: { fontWeight: "700" as const, fontSize: 14, color: tokens.accent, ...mono },
    readoutValueWarn: { color: tokens.danger },
    totalsRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, paddingTop: 6, borderTopWidth: 1, borderTopColor: tokens.border },
    totalsLabel: { color: tokens.textMuted, ...mono },
    totalsValue: { color: tokens.textPrimary, ...mono },
  };
}

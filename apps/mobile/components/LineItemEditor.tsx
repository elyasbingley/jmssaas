import { useEffect, useState } from "react";
import { Alert, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { decode as decodeBase64 } from "base64-arraybuffer";
import {
  calculateDocumentTotals,
  computeItemizedLinePricing,
  computeLineItemUnitPriceCents,
  formatCentsAsAud,
  marginPercentToMarkupPercent,
  LINE_ITEM_UNITS,
  type LabourCostEntry,
  type LineItemCrewInput,
  type LineItemFormInput,
  type LineItemMaterialInput,
} from "@jmssaas/shared";
import { AddLineItemBar } from "./AddLineItemBar";
import { CenteredModal } from "./CenteredModal";
import { supabase } from "../lib/supabase";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";

const LINE_ITEM_IMAGE_BUCKET = "line-item-images";
const CURATED_UNITS = LINE_ITEM_UNITS.filter((u) => u !== "other");

interface LineItemEditorProps {
  items: LineItemFormInput[];
  onChange: (items: LineItemFormInput[]) => void;
  membershipDiscountCents?: number;
  tenantId: string;
}

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

// See DecimalField's comment in the desktop port of this file: a plain
// `value={number.toString()}` TextInput re-derives its displayed text from
// the numeric state on every keystroke, which silently strips a trailing
// "." the instant it's typed ("12." -> parses to 12 -> redisplays as "12"),
// so decimals could never be entered by hand - only whole numbers worked.
// Local text state, seeded once per row (rows are keyed by index below, so
// this component instance persists across re-renders of the same row)
// keeps the raw keystrokes intact while still forwarding the parsed number
// via onChangeValue on every change.
function DecimalInput({
  value,
  onChangeValue,
  placeholder,
}: {
  value: number;
  onChangeValue: (n: number) => void;
  placeholder?: string;
}) {
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

async function fetchLabourCostEntries(): Promise<LabourCostEntry[]> {
  const { data } = await supabase.from("labour_cost_entries").select("*");
  return (data ?? []) as LabourCostEntry[];
}

// Margin is the one input (margin = profit / price) - markup (profit /
// cost) is shown alongside it, never entered directly, per the "Margin 30%
// (= 42.86% markup)" spec.
function MarginField({ value, onChangeValue }: { value: number; onChangeValue: (n: number) => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View>
      <DecimalInput value={value} onChangeValue={onChangeValue} placeholder="%" />
      <Text style={styles.marginHint}>= {marginPercentToMarkupPercent(value).toFixed(2)}% markup</Text>
    </View>
  );
}

// Curated dropdown (as a modal picker, RN has no inline <select>) plus a
// free-text field for anything not on the list.
function UnitPicker({ value, onChangeValue }: { value: string | null | undefined; onChangeValue: (unit: string | null) => void }) {
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const [customText, setCustomText] = useState(() => (value && !(CURATED_UNITS as readonly string[]).includes(value) ? value : ""));

  return (
    <View>
      <Pressable style={styles.input} onPress={() => setOpen(true)}>
        <Text style={value ? styles.pickerValueText : styles.pickerPlaceholderText}>{value || "No unit"}</Text>
      </Pressable>
      <CenteredModal visible={open} onClose={() => setOpen(false)}>
        <Text style={styles.modalTitle}>Select a unit</Text>
        <Pressable
          style={styles.variationRow}
          onPress={() => {
            onChangeValue(null);
            setOpen(false);
          }}
        >
          <Text style={styles.variationRowText}>No unit</Text>
        </Pressable>
        {CURATED_UNITS.map((u) => (
          <Pressable
            key={u}
            style={styles.variationRow}
            onPress={() => {
              onChangeValue(u);
              setOpen(false);
            }}
          >
            <Text style={styles.variationRowText}>{u}</Text>
          </Pressable>
        ))}
        <Text style={styles.fieldLabel}>Other (type your own)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. roll, sheet"
          placeholderTextColor={styles.placeholder.color}
          value={customText}
          onChangeText={setCustomText}
        />
        <Pressable
          style={styles.modalCancel}
          onPress={() => {
            onChangeValue(customText.trim() || null);
            setOpen(false);
          }}
        >
          <Text style={styles.modalCancelText}>Use custom unit</Text>
        </Pressable>
      </CenteredModal>
    </View>
  );
}

// Lets a crew row default its cost rate from a real Cost of Ops staff
// member instead of being re-typed - optional, ad-hoc workers have no
// roster entry at all.
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

// Crew lines: more than one worker on an itemized line, each at their own
// cost/charge-out rate and hours (e.g. "you 8 hrs + offsider 8 hrs").
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
  const addRow = () =>
    onChange([...crew, { worker_name: "", cost_rate_cents: 0, charge_out_rate_cents: 0, hours: 0, sort_order: crew.length }]);

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
              <DecimalInput
                value={c.charge_out_rate_cents / 100}
                onChangeValue={(n) => updateRow(i, { charge_out_rate_cents: Math.round(n * 100) })}
              />
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

// Itemised materials sub-table - replaces the single material_cost_cents
// figure once a line goes itemized.
function MaterialsEditor({
  materials,
  onChange,
}: {
  materials: LineItemMaterialInput[];
  onChange: (materials: LineItemMaterialInput[]) => void;
}) {
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

// Live readout: cost, profit $, margin %, markup %, effective $/hr - updates
// on every keystroke since it's just computeItemizedLinePricing re-run on
// the current form state, same as unit_price_cents itself.
function LiveReadout({ item }: { item: LineItemFormInput }) {
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

// Shared by quotes/new, quotes/[id], invoices/new and invoices/[id] - the
// full internal editor, all editable in place, with a live GST-inclusive
// total computed with the same calculateDocumentTotals helper the totals
// get saved with. This is admin-only: the breakdown fields are margin-
// revealing figures the client should never see - see LineItemSummary
// below for that view.
//
// Each line now also carries a pricing_model toggle (line_item_rework_
// schema migration, ported from the desktop editor): "legacy" keeps the
// original labour rate/hours + material cost + markup% bracket exactly as
// before; "itemized" switches to the new crew/materials breakdown,
// material/subcontractor margin %, waste/contingency/allowance fields, and
// the live cost/profit/margin/markup/$-per-hour readout. unit_price_cents
// is still the one value actually persisted and trusted by the server
// either way - toggling between models just changes which fields on this
// form produce it.
export function LineItemEditor({ items, onChange, membershipDiscountCents = 0, tenantId }: LineItemEditorProps) {
  const styles = useThemedStyles(createStyles);
  const totals = calculateDocumentTotals(items);
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);
  const [labourCostEntries, setLabourCostEntries] = useState<LabourCostEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchLabourCostEntries().then((entries) => {
      if (!cancelled) setLabourCostEntries(entries);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateItem = (index: number, patch: Partial<LineItemFormInput>) => {
    onChange(
      items.map((item, i) => {
        if (i !== index) return item;
        const next = { ...item, ...patch };
        const unit_price_cents =
          next.pricing_model === "itemized" ? computeItemizedLinePricing(next).unitPriceCents : computeLineItemUnitPriceCents(next);
        return { ...next, unit_price_cents };
      })
    );
  };

  // Clears crew/materials when switching back to legacy - otherwise an
  // itemized line's children would survive the toggle and still get
  // persisted (replace_quote_line_items/replace_invoice_line_items insert
  // whatever's in item.crew/item.materials regardless of pricing_model),
  // leaving a "legacy" line with phantom itemized children.
  const togglePricingModel = (index: number) => {
    const item = items[index]!;
    if (item.pricing_model === "itemized") {
      updateItem(index, { pricing_model: "legacy", crew: [], materials: [] });
    } else {
      updateItem(index, { pricing_model: "itemized" });
    }
  };

  const pickImage = async (index: number) => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Enable photo access in Settings to attach a photo.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.7, allowsEditing: true });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset?.base64) return;

    setUploadingIndex(index);
    try {
      const extension = (asset.mimeType ?? "image/jpeg").includes("png") ? "png" : "jpg";
      const path = `${tenantId}/${Date.now()}.${extension}`;
      const { error: uploadError } = await supabase.storage
        .from(LINE_ITEM_IMAGE_BUCKET)
        .upload(path, decodeBase64(asset.base64), { contentType: asset.mimeType ?? "image/jpeg" });
      if (uploadError) throw uploadError;
      const imageUrl = supabase.storage.from(LINE_ITEM_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
      updateItem(index, { image_url: imageUrl });
    } catch (e) {
      Alert.alert("Upload failed", e instanceof Error ? e.message : "Failed to upload image");
    } finally {
      setUploadingIndex(null);
    }
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  // Renumbers every item's sort_order to match its new array position on
  // every move - see the desktop port of this file for why: the RPC that
  // persists a reorder on an EXISTING quote/invoice prefers each item's
  // own carried sort_order field over its array position, so array order
  // alone isn't enough once an item has already been saved once.
  const moveItem = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next.map((item, i) => ({ ...item, sort_order: i })));
  };

  return (
    <View>
      {items.map((item, index) => {
        const itemized = item.pricing_model === "itemized";
        const crew = item.crew ?? [];
        const materials = item.materials ?? [];
        return (
          <View key={index} style={styles.row}>
            <View style={styles.rowHeader}>
              <View style={styles.rowBadges}>
                <Text style={styles.rowNumber}>#{index + 1}</Text>
                {itemized ? (
                  <View style={styles.optionalBadge}>
                    <Text style={styles.optionalBadgeText}>Itemised</Text>
                  </View>
                ) : null}
                {item.is_callout_fee ? (
                  <View style={styles.calloutBadge}>
                    <Text style={styles.calloutBadgeText}>Call-out fee</Text>
                  </View>
                ) : null}
                {item.waived_amount_cents > 0 ? (
                  <View style={styles.waivedBadge}>
                    <Text style={styles.waivedBadgeText}>Waived - Membership</Text>
                  </View>
                ) : null}
                {item.is_subcontracted ? (
                  <View style={styles.subcontractedBadge}>
                    <Text style={styles.subcontractedBadgeText}>Subcontracted</Text>
                  </View>
                ) : null}
                {item.is_optional ? (
                  <View style={styles.optionalBadge}>
                    <Text style={styles.optionalBadgeText}>Optional</Text>
                  </View>
                ) : null}
                {item.bundle_name ? (
                  <View style={styles.bundleBadge}>
                    <Text style={styles.bundleBadgeText}>Bundle: {item.bundle_name}</Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.rowMoveButtons}>
                <Pressable onPress={() => moveItem(index, -1)} disabled={index === 0} style={styles.moveButton}>
                  <Text style={[styles.moveButtonText, index === 0 && styles.moveButtonTextDisabled]}>&uarr;</Text>
                </Pressable>
                <Pressable onPress={() => moveItem(index, 1)} disabled={index === items.length - 1} style={styles.moveButton}>
                  <Text style={[styles.moveButtonText, index === items.length - 1 && styles.moveButtonTextDisabled]}>&darr;</Text>
                </Pressable>
                <Pressable onPress={() => removeItem(index)} style={styles.removeButton}>
                  <Text style={styles.removeButtonText}>Remove</Text>
                </Pressable>
              </View>
            </View>

            <TextInput
              style={[styles.input, styles.descriptionInput]}
              placeholder={"Description (e.g. supply and install valley channel)\n\n- Remove the existing tile\n- Supply and fit new tiles\n- Dispose of trade waste"}
              placeholderTextColor={styles.placeholder.color}
              value={item.description}
              onChangeText={(text) => updateItem(index, { description: text })}
              multiline
            />

            <View style={styles.pricingToggleRow}>
              <Pressable style={[styles.pricingToggleButton, !itemized && styles.pricingToggleButtonActive]} onPress={() => togglePricingModel(index)}>
                <Text style={[styles.pricingToggleText, !itemized && styles.pricingToggleTextActive]}>Simple</Text>
              </Pressable>
              <Pressable style={[styles.pricingToggleButton, itemized && styles.pricingToggleButtonActive]} onPress={() => togglePricingModel(index)}>
                <Text style={[styles.pricingToggleText, itemized && styles.pricingToggleTextActive]}>Itemised</Text>
              </Pressable>
            </View>

            <View style={styles.fieldGrid}>
              <View style={styles.fieldCell}>
                <Text style={styles.fieldLabel}>Quantity</Text>
                <DecimalInput placeholder="1" value={item.quantity} onChangeValue={(n) => updateItem(index, { quantity: n })} />
              </View>
              <View style={styles.fieldCell}>
                <Text style={styles.fieldLabel}>Unit</Text>
                <UnitPicker value={item.unit} onChangeValue={(unit) => updateItem(index, { unit })} />
              </View>
            </View>

            <View style={styles.fieldGrid}>
              <View style={styles.fieldCell}>
                <Pressable
                  style={[styles.gstToggle, item.gst_applicable && styles.gstToggleActive]}
                  onPress={() => updateItem(index, { gst_applicable: !item.gst_applicable })}
                >
                  <Text style={[styles.gstToggleText, item.gst_applicable && styles.gstToggleTextActive]}>
                    GST {item.gst_applicable ? "applicable" : "not applicable"}
                  </Text>
                </Pressable>
              </View>
            </View>

            {!itemized ? (
              <>
                <View style={styles.fieldGrid}>
                  <View style={styles.fieldCell}>
                    <Text style={styles.fieldLabel}>Labour rate ($/hr)</Text>
                    <DecimalInput
                      placeholder="0"
                      value={item.labour_rate_cents / 100}
                      onChangeValue={(n) => updateItem(index, { labour_rate_cents: Math.round(n * 100) })}
                    />
                  </View>
                  <View style={styles.fieldCell}>
                    <Text style={styles.fieldLabel}>Labour hours</Text>
                    <DecimalInput placeholder="0" value={item.labour_hours} onChangeValue={(n) => updateItem(index, { labour_hours: n })} />
                  </View>
                </View>
                <View style={styles.fieldGrid}>
                  <View style={styles.fieldCell}>
                    <Text style={styles.fieldLabel}>Material cost ($)</Text>
                    <DecimalInput
                      placeholder="0"
                      value={item.material_cost_cents / 100}
                      onChangeValue={(n) => updateItem(index, { material_cost_cents: Math.round(n * 100) })}
                    />
                  </View>
                  <View style={styles.fieldCell}>
                    <Text style={styles.fieldLabel}>Markup (%)</Text>
                    <DecimalInput placeholder="0" value={item.markup_percent} onChangeValue={(n) => updateItem(index, { markup_percent: n })} />
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
                        placeholder="0"
                        value={(item.labour_cost_rate_cents ?? 0) / 100}
                        onChangeValue={(n) => updateItem(index, { labour_cost_rate_cents: Math.round(n * 100) })}
                      />
                    </View>
                    <View style={styles.fieldCell}>
                      <Text style={styles.fieldLabel}>Charge-out rate ($/hr)</Text>
                      <DecimalInput
                        placeholder="0"
                        value={(item.labour_charge_out_rate_cents ?? 0) / 100}
                        onChangeValue={(n) => updateItem(index, { labour_charge_out_rate_cents: Math.round(n * 100) })}
                      />
                    </View>
                    <View style={styles.fieldCell}>
                      <Text style={styles.fieldLabel}>Labour hours</Text>
                      <DecimalInput placeholder="0" value={item.labour_hours} onChangeValue={(n) => updateItem(index, { labour_hours: n })} />
                    </View>
                  </View>
                ) : (
                  <CrewEditor crew={crew} labourCostEntries={labourCostEntries} onChange={(nextCrew) => updateItem(index, { crew: nextCrew })} />
                )}
                <Pressable
                  onPress={() =>
                    updateItem(
                      index,
                      crew.length === 0
                        ? {
                            crew: [
                              {
                                worker_name: "",
                                cost_rate_cents: item.labour_cost_rate_cents ?? 0,
                                charge_out_rate_cents: item.labour_charge_out_rate_cents ?? 0,
                                hours: item.labour_hours,
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
                      <DecimalInput
                        placeholder="0"
                        value={item.material_cost_cents / 100}
                        onChangeValue={(n) => updateItem(index, { material_cost_cents: Math.round(n * 100) })}
                      />
                    </View>
                  </View>
                ) : (
                  <MaterialsEditor materials={materials} onChange={(nextMaterials) => updateItem(index, { materials: nextMaterials })} />
                )}
                <Pressable
                  onPress={() =>
                    updateItem(
                      index,
                      materials.length === 0
                        ? { materials: [{ description: "", quantity: 1, unit_cost_cents: item.material_cost_cents, sort_order: 0 }] }
                        : { materials: [] }
                    )
                  }
                >
                  <Text style={styles.link}>{materials.length === 0 ? "+ Itemise materials" : "Remove itemised materials"}</Text>
                </Pressable>

                <View style={styles.fieldCell}>
                  <Text style={styles.fieldLabel}>Material margin % (incl. waste/contingency/allowances below)</Text>
                  <MarginField value={item.material_margin_percent ?? 0} onChangeValue={(n) => updateItem(index, { material_margin_percent: n })} />
                </View>

                <View style={styles.fieldGrid}>
                  <View style={styles.fieldCell}>
                    <Text style={styles.fieldLabel}>Waste (%)</Text>
                    <DecimalInput value={item.waste_percent ?? 0} onChangeValue={(n) => updateItem(index, { waste_percent: n })} />
                  </View>
                  <View style={styles.fieldCell}>
                    <Text style={styles.fieldLabel}>Contingency (%)</Text>
                    <DecimalInput value={item.contingency_percent ?? 0} onChangeValue={(n) => updateItem(index, { contingency_percent: n })} />
                  </View>
                </View>
                <View style={styles.fieldGrid}>
                  <View style={styles.fieldCell}>
                    <Text style={styles.fieldLabel}>Tip fees ($)</Text>
                    <DecimalInput
                      value={(item.tip_fees_cents ?? 0) / 100}
                      onChangeValue={(n) => updateItem(index, { tip_fees_cents: Math.round(n * 100) })}
                    />
                  </View>
                  <View style={styles.fieldCell}>
                    <Text style={styles.fieldLabel}>Equipment/scaffold ($)</Text>
                    <DecimalInput
                      value={(item.equipment_hire_cents ?? 0) / 100}
                      onChangeValue={(n) => updateItem(index, { equipment_hire_cents: Math.round(n * 100) })}
                    />
                  </View>
                  <View style={styles.fieldCell}>
                    <Text style={styles.fieldLabel}>Travel ($)</Text>
                    <DecimalInput
                      value={(item.travel_cost_cents ?? 0) / 100}
                      onChangeValue={(n) => updateItem(index, { travel_cost_cents: Math.round(n * 100) })}
                    />
                  </View>
                </View>
              </>
            )}

            <View style={styles.fieldGrid}>
              <View style={styles.fieldCell}>
                <Pressable
                  style={[styles.subcontractedToggle, item.is_subcontracted && styles.subcontractedToggleActive]}
                  onPress={() =>
                    updateItem(index, {
                      is_subcontracted: !item.is_subcontracted,
                      subcontractor_cost_cents: !item.is_subcontracted ? item.subcontractor_cost_cents ?? 0 : 0,
                    })
                  }
                >
                  <Text style={[styles.subcontractedToggleText, item.is_subcontracted && styles.subcontractedToggleTextActive]}>
                    {item.is_subcontracted ? "Subcontracted" : "Not subcontracted"}
                  </Text>
                </Pressable>
              </View>
              {item.is_subcontracted ? (
                <View style={styles.fieldCell}>
                  <Text style={styles.fieldLabel}>Subcontractor cost ($, per unit)</Text>
                  <DecimalInput
                    placeholder="0"
                    value={(item.subcontractor_cost_cents ?? 0) / 100}
                    onChangeValue={(n) => updateItem(index, { subcontractor_cost_cents: Math.round(n * 100) })}
                  />
                </View>
              ) : null}
            </View>
            {item.is_subcontracted && itemized ? (
              <View style={styles.fieldCell}>
                <Text style={styles.fieldLabel}>Subcontractor margin (%)</Text>
                <MarginField
                  value={item.subcontractor_margin_percent ?? 0}
                  onChangeValue={(n) => updateItem(index, { subcontractor_margin_percent: n })}
                />
              </View>
            ) : null}

            <View style={styles.fieldGrid}>
              <View style={styles.fieldCell}>
                <Text style={styles.fieldLabel}>Bundle name (optional grouping)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Gutter guard package"
                  placeholderTextColor={styles.placeholder.color}
                  value={item.bundle_name ?? ""}
                  onChangeText={(text) => updateItem(index, { bundle_name: text })}
                />
              </View>
            </View>

            <Pressable
              style={[styles.optionalToggle, item.is_optional && styles.optionalToggleActive]}
              onPress={() => updateItem(index, { is_optional: !item.is_optional, is_included: item.is_optional })}
            >
              <Text style={[styles.optionalToggleText, item.is_optional && styles.optionalToggleTextActive]}>
                {item.is_optional ? "Optional (client ticks on to include)" : "Not optional - always included"}
              </Text>
            </Pressable>

            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Warranty (shown to the client, directly under the description)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. 10 year workmanship warranty"
                placeholderTextColor={styles.placeholder.color}
                value={item.warranty_text ?? ""}
                onChangeText={(text) => updateItem(index, { warranty_text: text })}
              />
            </View>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Internal notes (office only - never shown to the client)</Text>
              <TextInput
                style={[styles.input, styles.notesInput]}
                placeholder="e.g. keep copper nails clear of valley"
                placeholderTextColor={styles.placeholder.color}
                value={item.internal_notes ?? ""}
                onChangeText={(text) => updateItem(index, { internal_notes: text })}
                multiline
              />
            </View>

            <View style={styles.imageSection}>
              <Text style={styles.fieldLabel}>Image (shown on the quote/invoice PDF)</Text>
              {item.image_url ? <Image source={{ uri: item.image_url }} style={styles.itemImagePreview} /> : null}
              <View style={styles.imageButtonsRow}>
                <Pressable onPress={() => pickImage(index)} disabled={uploadingIndex === index}>
                  <Text style={styles.link}>
                    {uploadingIndex === index ? "Uploading..." : item.image_url ? "Change image" : "+ Add image"}
                  </Text>
                </Pressable>
                {item.image_url ? (
                  <Pressable onPress={() => updateItem(index, { image_url: "" })}>
                    <Text style={styles.removeButtonText}>Remove image</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>

            {itemized ? <LiveReadout item={item} /> : null}

            <View style={styles.lineTotalRow}>
              <Text style={styles.lineTotalLabel}>Line total</Text>
              {item.waived_amount_cents > 0 ? (
                <View style={styles.lineTotalWaivedRow}>
                  <Text style={styles.lineTotalStrikethrough}>{formatCentsAsAud(item.quantity * item.unit_price_cents)}</Text>
                  <Text style={styles.lineTotalValue}>{formatCentsAsAud(item.quantity * item.unit_price_cents - item.waived_amount_cents)}</Text>
                </View>
              ) : (
                <Text style={styles.lineTotalValue}>{formatCentsAsAud(item.quantity * item.unit_price_cents)}</Text>
              )}
            </View>
          </View>
        );
      })}

      <AddLineItemBar
        itemCount={items.length}
        onAdd={(item) => onChange([...items, item])}
        onAddMany={(newItems) => onChange([...items, ...newItems])}
      />

      <View style={styles.totalsBox}>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>Subtotal</Text>
          <Text style={styles.totalsValue}>{formatCentsAsAud(totals.subtotal_cents)}</Text>
        </View>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>GST</Text>
          <Text style={styles.totalsValue}>{formatCentsAsAud(totals.gst_cents)}</Text>
        </View>
        {membershipDiscountCents > 0 ? (
          <View style={styles.totalsRow}>
            <Text style={styles.membershipDiscountLabel}>Membership discount</Text>
            <Text style={styles.membershipDiscountValue}>-{formatCentsAsAud(membershipDiscountCents)}</Text>
          </View>
        ) : null}
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabelBold}>Total</Text>
          <Text style={styles.totalsValueBold}>{formatCentsAsAud(totals.total_cents - membershipDiscountCents)}</Text>
        </View>
      </View>
    </View>
  );
}

// Client-facing summary: description / qty / rate / amount only - never the
// labour rate, hours, material cost, or markup that fed into the rate.
// warranty_text and unit are shown too since they're explicitly client-
// visible by design - crew/materials/internal_notes/pricing_model never
// appear here. Used wherever a non-admin views a quote/invoice in-app, and
// reused as-is for the itemised table in the PDF export (Phase 5) so the
// two never drift.
export function LineItemSummary({
  items,
  membershipDiscountCents = 0,
}: {
  items: LineItemFormInput[];
  membershipDiscountCents?: number;
}) {
  const styles = useThemedStyles(createStyles);
  const totals = calculateDocumentTotals(items);

  return (
    <View>
      <View style={styles.summaryHeaderRow}>
        <Text style={[styles.summaryHeaderCell, styles.summaryDescCell]}>Item &amp; Description</Text>
        <Text style={[styles.summaryHeaderCell, styles.summaryNumCell]}>Qty</Text>
        <Text style={[styles.summaryHeaderCell, styles.summaryNumCell]}>Rate</Text>
        <Text style={[styles.summaryHeaderCell, styles.summaryNumCell]}>Amount</Text>
      </View>
      {items.map((item, index) => {
        const excluded = item.is_optional && !item.is_included;
        const showBundleHeading = item.bundle_name && item.bundle_name !== items[index - 1]?.bundle_name;
        return (
          <View key={index}>
            {showBundleHeading ? (
              <View style={styles.summaryBundleHeading}>
                <Text style={styles.summaryBundleHeadingText}>{item.bundle_name}</Text>
              </View>
            ) : null}
            <View style={[styles.summaryRow, excluded && styles.summaryRowExcluded]}>
              {item.image_url ? <Image source={{ uri: item.image_url }} style={styles.summaryItemImage} /> : null}
              <View style={styles.summaryRowMain}>
                <View style={styles.summaryDescCell}>
                  <Text style={styles.summaryCell}>{item.description}</Text>
                  {item.is_optional ? (
                    <Text style={styles.summaryOptionalLabel}>{excluded ? "Not selected" : "Optional - included"}</Text>
                  ) : null}
                  {item.warranty_text ? <Text style={styles.summaryWarrantyText}>{item.warranty_text}</Text> : null}
                </View>
                <Text style={[styles.summaryCell, styles.summaryNumCell]}>
                  {item.quantity}
                  {item.unit ? ` ${item.unit}` : ""}
                </Text>
                <Text style={[styles.summaryCell, styles.summaryNumCell]}>{formatCentsAsAud(item.unit_price_cents)}</Text>
                <Text style={[styles.summaryCell, styles.summaryNumCell]}>
                  {excluded ? "—" : formatCentsAsAud(item.quantity * item.unit_price_cents - item.waived_amount_cents)}
                </Text>
              </View>
              {item.waived_amount_cents > 0 ? <Text style={styles.summaryWaivedLabel}>Waived - Membership</Text> : null}
            </View>
          </View>
        );
      })}

      <View style={styles.totalsBox}>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>Subtotal</Text>
          <Text style={styles.totalsValue}>{formatCentsAsAud(totals.subtotal_cents)}</Text>
        </View>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>GST</Text>
          <Text style={styles.totalsValue}>{formatCentsAsAud(totals.gst_cents)}</Text>
        </View>
        {membershipDiscountCents > 0 ? (
          <View style={styles.totalsRow}>
            <Text style={styles.membershipDiscountLabel}>Membership discount</Text>
            <Text style={styles.membershipDiscountValue}>-{formatCentsAsAud(membershipDiscountCents)}</Text>
          </View>
        ) : null}
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabelBold}>Total</Text>
          <Text style={styles.totalsValueBold}>{formatCentsAsAud(totals.total_cents - membershipDiscountCents)}</Text>
        </View>
      </View>
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    row: { borderWidth: 1, borderColor: tokens.border, borderRadius: 10, padding: 12, marginBottom: 10, gap: 8, backgroundColor: tokens.surface },
    rowHeader: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const },
    rowBadges: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexShrink: 1, flexWrap: "wrap" as const },
    rowNumber: { color: tokens.textMuted, fontWeight: "700" as const, fontSize: 12, ...mono },
    calloutBadge: { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
    calloutBadgeText: { fontSize: 11, fontWeight: "700" as const, color: tokens.textMuted, ...mono },
    waivedBadge: { backgroundColor: tokens.accentGlow, borderWidth: 1, borderColor: tokens.accent, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
    waivedBadgeText: { fontSize: 11, fontWeight: "700" as const, color: tokens.accent, ...mono },
    subcontractedBadge: { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.warning, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
    subcontractedBadgeText: { fontSize: 11, fontWeight: "700" as const, color: tokens.warning, ...mono },
    optionalBadge: { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.accent, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
    optionalBadgeText: { fontSize: 11, fontWeight: "700" as const, color: tokens.accent, ...mono },
    bundleBadge: { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
    bundleBadgeText: { fontSize: 11, fontWeight: "700" as const, color: tokens.textMuted, ...mono },
    optionalToggle: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.background, alignItems: "center" as const },
    optionalToggleActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    optionalToggleText: { color: tokens.textMuted, fontWeight: "700" as const, fontSize: 12, ...mono },
    optionalToggleTextActive: { color: tokens.accent },
    imageSection: { gap: 6 },
    imageButtonsRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 16 },
    itemImagePreview: { width: 140, height: 90, borderRadius: 8, backgroundColor: tokens.border },
    link: { color: tokens.accent, fontWeight: "600" as const, fontSize: 13, ...mono },
    rowMoveButtons: { marginLeft: "auto" as const, flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
    moveButton: { paddingHorizontal: 2 },
    moveButtonText: { fontSize: 14, fontWeight: "700" as const, color: tokens.textMuted, ...mono },
    moveButtonTextDisabled: { opacity: 0.3 },
    removeButton: {},
    removeButtonText: { color: tokens.danger, fontWeight: "600" as const, fontSize: 12, ...mono },
    input: {
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 8,
      padding: 10,
      fontSize: 15,
      color: tokens.textPrimary,
      backgroundColor: tokens.background,
      ...mono,
    },
    placeholder: { color: tokens.textMuted },
    descriptionInput: { minHeight: 90, textAlignVertical: "top" as const },
    notesInput: { minHeight: 60, textAlignVertical: "top" as const },
    pickerValueText: { fontSize: 15, color: tokens.textPrimary, ...mono },
    pickerPlaceholderText: { fontSize: 15, color: tokens.textMuted, ...mono },
    fieldGrid: { flexDirection: "row" as const, gap: 8 },
    fieldCell: { flex: 1, gap: 4 },
    fieldLabel: { fontSize: 12, fontWeight: "600" as const, color: tokens.textMuted, ...mono },
    gstToggle: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.background, alignItems: "center" as const },
    gstToggleActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    gstToggleText: { color: tokens.textMuted, fontWeight: "700" as const, fontSize: 12, ...mono },
    gstToggleTextActive: { color: tokens.accent },
    pricingToggleRow: { flexDirection: "row" as const, gap: 8 },
    pricingToggleButton: { flex: 1, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.background, alignItems: "center" as const },
    pricingToggleButtonActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    pricingToggleText: { color: tokens.textMuted, fontWeight: "700" as const, fontSize: 12, ...mono },
    pricingToggleTextActive: { color: tokens.accent },
    subcontractedToggle: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.background, alignItems: "center" as const },
    subcontractedToggleActive: { backgroundColor: tokens.warning, borderColor: tokens.warning },
    subcontractedToggleText: { color: tokens.textMuted, fontWeight: "700" as const, fontSize: 12, ...mono },
    subcontractedToggleTextActive: { color: tokens.background },
    marginHint: { marginTop: 4, fontSize: 11, color: tokens.textMuted, ...mono },
    subPanel: { borderWidth: 1, borderColor: tokens.border, borderRadius: 8, padding: 10, gap: 8, backgroundColor: tokens.background },
    subPanelHeader: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const },
    subPanelTitle: { fontSize: 12, fontWeight: "700" as const, color: tokens.textMuted, textTransform: "uppercase" as const, letterSpacing: 0.5, ...mono },
    subRow: { gap: 6, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border },
    modalTitle: { fontSize: 18, fontWeight: "700" as const, color: tokens.accent, letterSpacing: 1.5, textTransform: "uppercase" as const, ...mono },
    variationRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border },
    variationRowText: { fontSize: 15, color: tokens.textPrimary, ...mono },
    modalCancel: { marginTop: 8, alignSelf: "flex-end" as const },
    modalCancelText: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    readoutBox: { borderWidth: 1, borderColor: tokens.border, borderRadius: 8, padding: 10, gap: 6, backgroundColor: tokens.background },
    readoutRow: { flexDirection: "row" as const, gap: 12 },
    readoutCell: { flex: 1, gap: 2 },
    readoutValue: { fontWeight: "700" as const, fontSize: 14, color: tokens.accent, ...mono },
    readoutValueWarn: { color: tokens.danger },
    lineTotalRow: { flexDirection: "row" as const, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.border },
    lineTotalLabel: { color: tokens.textMuted, fontSize: 13, flex: 1, ...mono },
    lineTotalValue: { fontWeight: "700" as const, fontSize: 13, flexShrink: 0, color: tokens.textPrimary, ...mono },
    lineTotalWaivedRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexShrink: 0 },
    lineTotalStrikethrough: { fontSize: 12, color: tokens.textMuted, textDecorationLine: "line-through" as const, ...mono },
    membershipDiscountLabel: { color: tokens.accent, flex: 1, ...mono },
    membershipDiscountValue: { color: tokens.accent, flexShrink: 0, textAlign: "right" as const, ...mono },
    totalsBox: { marginTop: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.border, gap: 4 },
    // Deliberately not justifyContent: "space-between" with two auto-width
    // Text children - that layout gives Yoga a tight target width to hit,
    // and on Android it can resolve rounding by shaving a hair off the
    // label's measured width, silently clipping its last character with no
    // ellipsis ("Subtotal" -> "Subtota", "GST" -> "GS"). flexShrink: 0 alone
    // didn't fully rule this out on every device/font-scale combination, so
    // instead the label gets flex: 1 (it absorbs 100% of the row's leftover
    // width after the value's own natural size, so it's never measured
    // against a boundary it doesn't comfortably fit in) and the value keeps
    // its natural width, right-aligned by textAlign - same visual result,
    // structurally not the same class of bug.
    totalsRow: { flexDirection: "row" as const },
    totalsLabel: { color: tokens.textMuted, flex: 1, ...mono },
    totalsValue: { color: tokens.textPrimary, flexShrink: 0, textAlign: "right" as const, ...mono },
    totalsLabelBold: { fontWeight: "700" as const, flex: 1, color: tokens.textPrimary, ...mono },
    totalsValueBold: { fontWeight: "700" as const, flexShrink: 0, textAlign: "right" as const, color: tokens.textPrimary, ...mono },
    summaryHeaderRow: { flexDirection: "row" as const, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border },
    summaryHeaderCell: { fontSize: 12, fontWeight: "700" as const, color: tokens.textMuted, ...mono },
    summaryBundleHeading: { marginTop: 10, paddingBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border },
    summaryBundleHeadingText: { fontSize: 12, fontWeight: "700" as const, color: tokens.textMuted, textTransform: "uppercase" as const, letterSpacing: 0.5, ...mono },
    summaryRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border },
    summaryRowExcluded: { opacity: 0.5 },
    summaryItemImage: { width: 120, height: 80, borderRadius: 8, marginBottom: 6, backgroundColor: tokens.border },
    summaryRowMain: { flexDirection: "row" as const },
    summaryCell: { fontSize: 14, color: tokens.textPrimary, ...mono },
    summaryDescCell: { flex: 3 },
    summaryNumCell: { flex: 1, textAlign: "right" as const },
    summaryOptionalLabel: { marginTop: 2, fontSize: 11, fontWeight: "700" as const, color: tokens.accent, ...mono },
    summaryWarrantyText: { marginTop: 2, fontSize: 11, color: tokens.textMuted, ...mono },
    summaryWaivedLabel: { marginTop: 2, fontSize: 11, fontWeight: "700" as const, color: tokens.accent, textAlign: "right" as const, ...mono },
  };
}

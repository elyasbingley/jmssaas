import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { calculateDocumentTotals, computeLineItemUnitPriceCents, formatCentsAsAud, type LineItemFormInput } from "@jmssaas/shared";
import { AddLineItemBar } from "./AddLineItemBar";

interface LineItemEditorProps {
  items: LineItemFormInput[];
  onChange: (items: LineItemFormInput[]) => void;
}

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

// Shared by quotes/new, quotes/[id], invoices/new and invoices/[id] - the
// full internal editor (labour rate/hours, material cost, markup%,
// quantity), all editable in place, with a live GST-inclusive total computed
// with the same calculateDocumentTotals helper the totals get saved with.
// This is admin-only: the breakdown fields (rate/hours/material/markup) are
// margin-revealing figures the client (and, per the person's brief, anyone
// non-admin) should never see - see LineItemSummary below for that view.
export function LineItemEditor({ items, onChange }: LineItemEditorProps) {
  const totals = calculateDocumentTotals(items);

  const updateItem = (index: number, patch: Partial<LineItemFormInput>) => {
    onChange(
      items.map((item, i) => {
        if (i !== index) return item;
        const next = { ...item, ...patch };
        return { ...next, unit_price_cents: computeLineItemUnitPriceCents(next) };
      })
    );
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  return (
    <View>
      {items.map((item, index) => (
        <View key={index} style={styles.row}>
          <View style={styles.rowHeader}>
            <Text style={styles.rowNumber}>#{index + 1}</Text>
            <Pressable onPress={() => removeItem(index)} style={styles.removeButton}>
              <Text style={styles.removeButtonText}>Remove</Text>
            </Pressable>
          </View>

          <TextInput
            style={[styles.input, styles.descriptionInput]}
            placeholder={"Description (e.g. supply and install valley channel)\n\n- Remove the existing tile\n- Supply and fit new tiles\n- Dispose of trade waste"}
            value={item.description}
            onChangeText={(text) => updateItem(index, { description: text })}
            multiline
          />

          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Labour rate ($/hr)</Text>
              <TextInput
                style={styles.input}
                placeholder="0"
                keyboardType="decimal-pad"
                value={(item.labour_rate_cents / 100).toString()}
                onChangeText={(text) => updateItem(index, { labour_rate_cents: Math.round(parseNumber(text) * 100) })}
              />
            </View>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Labour hours</Text>
              <TextInput
                style={styles.input}
                placeholder="0"
                keyboardType="decimal-pad"
                value={item.labour_hours.toString()}
                onChangeText={(text) => updateItem(index, { labour_hours: parseNumber(text) })}
              />
            </View>
          </View>

          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Material cost ($)</Text>
              <TextInput
                style={styles.input}
                placeholder="0"
                keyboardType="decimal-pad"
                value={(item.material_cost_cents / 100).toString()}
                onChangeText={(text) => updateItem(index, { material_cost_cents: Math.round(parseNumber(text) * 100) })}
              />
            </View>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Markup (%)</Text>
              <TextInput
                style={styles.input}
                placeholder="0"
                keyboardType="decimal-pad"
                value={item.markup_percent.toString()}
                onChangeText={(text) => updateItem(index, { markup_percent: parseNumber(text) })}
              />
            </View>
          </View>

          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Quantity</Text>
              <TextInput
                style={styles.input}
                placeholder="1"
                keyboardType="decimal-pad"
                value={item.quantity.toString()}
                onChangeText={(text) => updateItem(index, { quantity: parseNumber(text) })}
              />
            </View>
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

          <View style={styles.lineTotalRow}>
            <Text style={styles.lineTotalLabel}>Line total</Text>
            <Text style={styles.lineTotalValue}>{formatCentsAsAud(item.quantity * item.unit_price_cents)}</Text>
          </View>
        </View>
      ))}

      <AddLineItemBar itemCount={items.length} onAdd={(item) => onChange([...items, item])} />

      <View style={styles.totalsBox}>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>Subtotal</Text>
          <Text style={styles.totalsValue}>{formatCentsAsAud(totals.subtotal_cents)}</Text>
        </View>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>GST</Text>
          <Text style={styles.totalsValue}>{formatCentsAsAud(totals.gst_cents)}</Text>
        </View>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabelBold}>Total</Text>
          <Text style={styles.totalsValueBold}>{formatCentsAsAud(totals.total_cents)}</Text>
        </View>
      </View>
    </View>
  );
}

// Client-facing summary: description / qty / rate / amount only - never the
// labour rate, hours, material cost, or markup that fed into the rate. Used
// wherever a non-admin views a quote/invoice in-app, and reused as-is for
// the itemised table in the PDF export (Phase 5) so the two never drift.
export function LineItemSummary({ items }: { items: LineItemFormInput[] }) {
  const totals = calculateDocumentTotals(items);

  return (
    <View>
      <View style={styles.summaryHeaderRow}>
        <Text style={[styles.summaryHeaderCell, styles.summaryDescCell]}>Item &amp; Description</Text>
        <Text style={[styles.summaryHeaderCell, styles.summaryNumCell]}>Qty</Text>
        <Text style={[styles.summaryHeaderCell, styles.summaryNumCell]}>Rate</Text>
        <Text style={[styles.summaryHeaderCell, styles.summaryNumCell]}>Amount</Text>
      </View>
      {items.map((item, index) => (
        <View key={index} style={styles.summaryRow}>
          <Text style={[styles.summaryCell, styles.summaryDescCell]}>{item.description}</Text>
          <Text style={[styles.summaryCell, styles.summaryNumCell]}>{item.quantity}</Text>
          <Text style={[styles.summaryCell, styles.summaryNumCell]}>{formatCentsAsAud(item.unit_price_cents)}</Text>
          <Text style={[styles.summaryCell, styles.summaryNumCell]}>
            {formatCentsAsAud(item.quantity * item.unit_price_cents)}
          </Text>
        </View>
      ))}

      <View style={styles.totalsBox}>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>Subtotal</Text>
          <Text style={styles.totalsValue}>{formatCentsAsAud(totals.subtotal_cents)}</Text>
        </View>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>GST</Text>
          <Text style={styles.totalsValue}>{formatCentsAsAud(totals.gst_cents)}</Text>
        </View>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabelBold}>Total</Text>
          <Text style={styles.totalsValueBold}>{formatCentsAsAud(totals.total_cents)}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 10, padding: 12, marginBottom: 10, gap: 8 },
  rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowNumber: { color: "#9ca3af", fontWeight: "700", fontSize: 12 },
  removeButton: { marginLeft: "auto" },
  removeButtonText: { color: "#dc2626", fontWeight: "600", fontSize: 12 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10, fontSize: 15 },
  descriptionInput: { minHeight: 90, textAlignVertical: "top" },
  fieldGrid: { flexDirection: "row", gap: 8 },
  fieldCell: { flex: 1, gap: 4 },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: "#6b7280" },
  gstToggle: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: "#f3f4f6", marginTop: 18, alignItems: "center" },
  gstToggleActive: { backgroundColor: "#111827" },
  gstToggleText: { color: "#374151", fontWeight: "700", fontSize: 12 },
  gstToggleTextActive: { color: "#fff" },
  lineTotalRow: { flexDirection: "row", justifyContent: "space-between", paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#f0f0f0" },
  lineTotalLabel: { color: "#6b7280", fontSize: 13, flexShrink: 0 },
  lineTotalValue: { fontWeight: "700", fontSize: 13, flexShrink: 0 },
  totalsBox: { marginTop: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#e5e7eb", gap: 4 },
  totalsRow: { flexDirection: "row", justifyContent: "space-between" },
  // flexShrink: 0 on both sides of a space-between row - without it, Yoga's
  // flex layout can ask these Text nodes to shrink by a hair to resolve
  // rounding in the available width, which on Android silently clips the
  // last character with no ellipsis rather than wrapping ("Subtotal" ->
  // "Subtota", "$690.01" -> "$690.0"). There's always enough width for this
  // short text, so disabling shrink entirely is safe here.
  totalsLabel: { color: "#6b7280", flexShrink: 0 },
  totalsValue: { color: "#111827", flexShrink: 0 },
  totalsLabelBold: { fontWeight: "700", flexShrink: 0 },
  totalsValueBold: { fontWeight: "700", flexShrink: 0 },
  summaryHeaderRow: { flexDirection: "row", paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#e5e7eb" },
  summaryHeaderCell: { fontSize: 12, fontWeight: "700", color: "#6b7280" },
  summaryRow: { flexDirection: "row", paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#f0f0f0" },
  summaryCell: { fontSize: 14, color: "#111827" },
  summaryDescCell: { flex: 3 },
  summaryNumCell: { flex: 1, textAlign: "right" },
});

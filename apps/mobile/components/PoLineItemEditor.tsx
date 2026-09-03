import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { formatCentsAsAud, type PoLineItemInput } from "@jmssaas/shared";

// Mobile port of desktop's PoLineItemEditor.tsx - PO/quote request line
// items are a flatter shape than quotes/invoices' LineItemFormInput (no
// labour/material/markup/GST split), so this gets its own small editor
// rather than reusing LineItemEditor.

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

// Same "plain value={number} input can never accept a typed decimal point"
// issue LineItemEditor.tsx's DecimalField works around - see that file.
function DecimalField({ value, onChange, disabled }: { value: number; onChange: (n: number) => void; disabled?: boolean }) {
  const [text, setText] = useState(() => (value === 0 ? "" : String(value)));
  return (
    <TextInput
      editable={!disabled}
      keyboardType="decimal-pad"
      style={[styles.decimalInput, disabled && styles.decimalInputDisabled]}
      value={text}
      onChangeText={(next) => {
        if (!/^\d*\.?\d*$/.test(next)) return;
        setText(next);
        onChange(parseNumber(next));
      }}
    />
  );
}

export function PoLineItemEditor({
  items,
  onChange,
  readOnly = false,
}: {
  items: PoLineItemInput[];
  onChange: (items: PoLineItemInput[]) => void;
  readOnly?: boolean;
}) {
  const totalCents = items.reduce((sum, item) => sum + Math.round(item.quantity * item.unit_cost_cents), 0);

  const updateItem = (index: number, patch: Partial<PoLineItemInput>) => {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };
  const removeItem = (index: number) => onChange(items.filter((_, i) => i !== index));
  const addItem = () => onChange([...items, { description: "", quantity: 1, unit_cost_cents: 0 }]);

  return (
    <View>
      {items.map((item, index) => (
        <View key={index} style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardIndex}>#{index + 1}</Text>
            {!readOnly ? (
              <Pressable onPress={() => removeItem(index)}>
                <Text style={styles.removeLink}>Remove</Text>
              </Pressable>
            ) : null}
          </View>
          <TextInput
            editable={!readOnly}
            placeholder="Description of work"
            multiline
            style={[styles.descriptionInput, readOnly && styles.decimalInputDisabled]}
            value={item.description}
            onChangeText={(v) => updateItem(index, { description: v })}
          />
          <View style={styles.fieldRow}>
            <View style={styles.flex1}>
              <Text style={styles.fieldLabel}>Quantity</Text>
              <DecimalField value={item.quantity} disabled={readOnly} onChange={(n) => updateItem(index, { quantity: n })} />
            </View>
            <View style={styles.flex1}>
              <Text style={styles.fieldLabel}>Unit cost ($)</Text>
              <DecimalField
                value={item.unit_cost_cents / 100}
                disabled={readOnly}
                onChange={(n) => updateItem(index, { unit_cost_cents: Math.round(n * 100) })}
              />
            </View>
            <View style={styles.flex1}>
              <Text style={styles.fieldLabel}>Line total</Text>
              <Text style={styles.lineTotal}>{formatCentsAsAud(Math.round(item.quantity * item.unit_cost_cents))}</Text>
            </View>
          </View>
        </View>
      ))}

      {!readOnly ? (
        <Pressable style={styles.addButton} onPress={addItem}>
          <Text style={styles.addButtonText}>+ Add line item</Text>
        </Pressable>
      ) : null}

      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total cost</Text>
        <Text style={styles.totalValue}>{formatCentsAsAud(totalCents)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  card: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 10, padding: 12, marginBottom: 10 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  cardIndex: { fontSize: 11, fontWeight: "700", color: "#9ca3af" },
  removeLink: { color: "#dc2626", fontWeight: "700", fontSize: 12 },
  descriptionInput: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, padding: 10, fontSize: 13, minHeight: 50, textAlignVertical: "top", marginBottom: 10, backgroundColor: "#fff" },
  decimalInput: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, padding: 8, fontSize: 13, backgroundColor: "#fff" },
  decimalInputDisabled: { backgroundColor: "#f3f4f6" },
  fieldRow: { flexDirection: "row", gap: 8 },
  fieldLabel: { fontSize: 11, fontWeight: "600", color: "#6b7280", marginBottom: 4 },
  lineTotal: { fontSize: 13, fontWeight: "700", color: "#111827", paddingTop: 8 },
  addButton: { borderWidth: 1, borderColor: "#d1d5db", borderStyle: "dashed", borderRadius: 8, padding: 10, alignItems: "center", marginBottom: 10 },
  addButtonText: { color: "#1d4ed8", fontWeight: "700", fontSize: 13 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: "#d1d5db", paddingTop: 10 },
  totalLabel: { fontSize: 14, fontWeight: "700", color: "#111827" },
  totalValue: { fontSize: 14, fontWeight: "700", color: "#111827" },
});

import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { calculateDocumentTotals, formatCentsAsAud, type LineItemFormInput } from "@jmssaas/shared";

const ITEM_TYPES: LineItemFormInput["item_type"][] = ["materials", "labour", "markup", "other"];
const ITEM_TYPE_LABELS: Record<LineItemFormInput["item_type"], string> = {
  materials: "Materials",
  labour: "Labour",
  markup: "Markup",
  other: "Other",
};

export function emptyLineItem(sortOrder: number): LineItemFormInput {
  return {
    item_type: "materials",
    description: "",
    quantity: 1,
    unit_price_cents: 0,
    gst_applicable: true,
    sort_order: sortOrder,
  };
}

interface LineItemEditorProps {
  items: LineItemFormInput[];
  onChange: (items: LineItemFormInput[]) => void;
}

// Shared by quotes/new, quotes/[id], invoices/new and invoices/[id] - editable
// line items (materials/labour/markup/other) with a live GST-inclusive total,
// computed with the same calculateDocumentTotals helper the totals get saved
// with, so the on-screen number always matches what's persisted.
export function LineItemEditor({ items, onChange }: LineItemEditorProps) {
  const totals = calculateDocumentTotals(items);

  const updateItem = (index: number, patch: Partial<LineItemFormInput>) => {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const addItem = () => {
    onChange([...items, emptyLineItem(items.length)]);
  };

  return (
    <View>
      {items.map((item, index) => (
        <View key={index} style={styles.row}>
          <View style={styles.typeRow}>
            {ITEM_TYPES.map((type) => (
              <Pressable
                key={type}
                style={[styles.typeChip, item.item_type === type && styles.typeChipActive]}
                onPress={() => updateItem(index, { item_type: type })}
              >
                <Text style={[styles.typeChipText, item.item_type === type && styles.typeChipTextActive]}>
                  {ITEM_TYPE_LABELS[type]}
                </Text>
              </Pressable>
            ))}
            <Pressable onPress={() => removeItem(index)} style={styles.removeButton}>
              <Text style={styles.removeButtonText}>Remove</Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.input}
            placeholder="Description (e.g. supply and install valley channel)"
            value={item.description}
            onChangeText={(text) => updateItem(index, { description: text })}
          />

          <View style={styles.numberRow}>
            <TextInput
              style={[styles.input, styles.numberInput]}
              placeholder="Qty"
              keyboardType="decimal-pad"
              value={String(item.quantity)}
              onChangeText={(text) => updateItem(index, { quantity: parseFloat(text) || 0 })}
            />
            <TextInput
              style={[styles.input, styles.numberInput]}
              placeholder="Unit price ($)"
              keyboardType="decimal-pad"
              value={(item.unit_price_cents / 100).toString()}
              onChangeText={(text) =>
                updateItem(index, { unit_price_cents: Math.round((parseFloat(text) || 0) * 100) })
              }
            />
            <Pressable
              style={[styles.gstToggle, item.gst_applicable && styles.gstToggleActive]}
              onPress={() => updateItem(index, { gst_applicable: !item.gst_applicable })}
            >
              <Text style={[styles.gstToggleText, item.gst_applicable && styles.gstToggleTextActive]}>GST</Text>
            </Pressable>
          </View>
        </View>
      ))}

      <Pressable style={styles.addButton} onPress={addItem}>
        <Text style={styles.addButtonText}>+ Add line item</Text>
      </Pressable>

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
  typeRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  typeChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, backgroundColor: "#f3f4f6" },
  typeChipActive: { backgroundColor: "#1d4ed8" },
  typeChipText: { color: "#374151", fontWeight: "600", fontSize: 12 },
  typeChipTextActive: { color: "#fff" },
  removeButton: { marginLeft: "auto" },
  removeButtonText: { color: "#dc2626", fontWeight: "600", fontSize: 12 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10, fontSize: 15 },
  numberRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  numberInput: { flex: 1 },
  gstToggle: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: "#f3f4f6" },
  gstToggleActive: { backgroundColor: "#111827" },
  gstToggleText: { color: "#374151", fontWeight: "700", fontSize: 12 },
  gstToggleTextActive: { color: "#fff" },
  addButton: { alignSelf: "flex-start", paddingVertical: 8 },
  addButtonText: { color: "#1d4ed8", fontWeight: "600" },
  totalsBox: { marginTop: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#e5e7eb", gap: 4 },
  totalsRow: { flexDirection: "row", justifyContent: "space-between" },
  totalsLabel: { color: "#6b7280" },
  totalsValue: { color: "#111827" },
  totalsLabelBold: { fontWeight: "700" },
  totalsValueBold: { fontWeight: "700" },
});

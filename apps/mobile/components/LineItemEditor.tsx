import { useState } from "react";
import { Alert, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { calculateDocumentTotals, computeLineItemUnitPriceCents, formatCentsAsAud, type LineItemFormInput } from "@jmssaas/shared";
import { AddLineItemBar } from "./AddLineItemBar";
import { supabase } from "../lib/supabase";

const LINE_ITEM_IMAGE_BUCKET = "line-item-images";

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
  const [text, setText] = useState(() => (value === 0 ? "" : String(value)));

  return (
    <TextInput
      style={styles.input}
      placeholder={placeholder}
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

// Shared by quotes/new, quotes/[id], invoices/new and invoices/[id] - the
// full internal editor (labour rate/hours, material cost, markup%,
// quantity), all editable in place, with a live GST-inclusive total computed
// with the same calculateDocumentTotals helper the totals get saved with.
// This is admin-only: the breakdown fields (rate/hours/material/markup) are
// margin-revealing figures the client (and, per the person's brief, anyone
// non-admin) should never see - see LineItemSummary below for that view.
export function LineItemEditor({ items, onChange, membershipDiscountCents = 0, tenantId }: LineItemEditorProps) {
  const totals = calculateDocumentTotals(items);
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);

  const updateItem = (index: number, patch: Partial<LineItemFormInput>) => {
    onChange(
      items.map((item, i) => {
        if (i !== index) return item;
        const next = { ...item, ...patch };
        return { ...next, unit_price_cents: computeLineItemUnitPriceCents(next) };
      })
    );
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
      {items.map((item, index) => (
        <View key={index} style={styles.row}>
          <View style={styles.rowHeader}>
            <View style={styles.rowBadges}>
              <Text style={styles.rowNumber}>#{index + 1}</Text>
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
            value={item.description}
            onChangeText={(text) => updateItem(index, { description: text })}
            multiline
          />

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
              <DecimalInput
                placeholder="0"
                value={item.labour_hours}
                onChangeValue={(n) => updateItem(index, { labour_hours: n })}
              />
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
              <DecimalInput
                placeholder="0"
                value={item.markup_percent}
                onChangeValue={(n) => updateItem(index, { markup_percent: n })}
              />
            </View>
          </View>

          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Quantity</Text>
              <DecimalInput
                placeholder="1"
                value={item.quantity}
                onChangeValue={(n) => updateItem(index, { quantity: n })}
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

          <View style={styles.fieldGrid}>
            <View style={styles.fieldCell}>
              <Text style={styles.fieldLabel}>Bundle name (optional grouping)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Gutter guard package"
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
      ))}

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
// labour rate, hours, material cost, or markup that fed into the rate. Used
// wherever a non-admin views a quote/invoice in-app, and reused as-is for
// the itemised table in the PDF export (Phase 5) so the two never drift.
export function LineItemSummary({
  items,
  membershipDiscountCents = 0,
}: {
  items: LineItemFormInput[];
  membershipDiscountCents?: number;
}) {
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
                </View>
                <Text style={[styles.summaryCell, styles.summaryNumCell]}>{item.quantity}</Text>
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

const styles = StyleSheet.create({
  row: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 10, padding: 12, marginBottom: 10, gap: 8 },
  rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowBadges: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, flexWrap: "wrap" },
  rowNumber: { color: "#9ca3af", fontWeight: "700", fontSize: 12 },
  calloutBadge: { backgroundColor: "#f3f4f6", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  calloutBadgeText: { fontSize: 11, fontWeight: "700", color: "#4b5563" },
  waivedBadge: { backgroundColor: "#dbeafe", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  waivedBadgeText: { fontSize: 11, fontWeight: "700", color: "#1d4ed8" },
  subcontractedBadge: { backgroundColor: "#ffedd5", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  subcontractedBadgeText: { fontSize: 11, fontWeight: "700", color: "#c2410c" },
  optionalBadge: { backgroundColor: "#f3e8ff", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  optionalBadgeText: { fontSize: 11, fontWeight: "700", color: "#7e22ce" },
  bundleBadge: { backgroundColor: "#ccfbf1", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  bundleBadgeText: { fontSize: 11, fontWeight: "700", color: "#0f766e" },
  optionalToggle: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: "#f3f4f6", alignItems: "center" },
  optionalToggleActive: { backgroundColor: "#7e22ce" },
  optionalToggleText: { color: "#374151", fontWeight: "700", fontSize: 12 },
  optionalToggleTextActive: { color: "#fff" },
  imageSection: { gap: 6 },
  imageButtonsRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  itemImagePreview: { width: 140, height: 90, borderRadius: 8, backgroundColor: "#f3f4f6" },
  link: { color: "#2563eb", fontWeight: "600", fontSize: 13 },
  rowMoveButtons: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 12 },
  moveButton: { paddingHorizontal: 2 },
  moveButtonText: { fontSize: 14, fontWeight: "700", color: "#6b7280" },
  moveButtonTextDisabled: { opacity: 0.3 },
  removeButton: {},
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
  subcontractedToggle: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: "#f3f4f6", alignItems: "center" },
  subcontractedToggleActive: { backgroundColor: "#c2410c" },
  subcontractedToggleText: { color: "#374151", fontWeight: "700", fontSize: 12 },
  subcontractedToggleTextActive: { color: "#fff" },
  lineTotalRow: { flexDirection: "row", paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#d1d5db" },
  lineTotalLabel: { color: "#6b7280", fontSize: 13, flex: 1 },
  lineTotalValue: { fontWeight: "700", fontSize: 13, flexShrink: 0 },
  lineTotalWaivedRow: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
  lineTotalStrikethrough: { fontSize: 12, color: "#9ca3af", textDecorationLine: "line-through" },
  membershipDiscountLabel: { color: "#1d4ed8", flex: 1 },
  membershipDiscountValue: { color: "#1d4ed8", flexShrink: 0, textAlign: "right" },
  totalsBox: { marginTop: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#d1d5db", gap: 4 },
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
  totalsRow: { flexDirection: "row" },
  totalsLabel: { color: "#6b7280", flex: 1 },
  totalsValue: { color: "#111827", flexShrink: 0, textAlign: "right" },
  totalsLabelBold: { fontWeight: "700", flex: 1 },
  totalsValueBold: { fontWeight: "700", flexShrink: 0, textAlign: "right" },
  summaryHeaderRow: { flexDirection: "row", paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db" },
  summaryHeaderCell: { fontSize: 12, fontWeight: "700", color: "#6b7280" },
  summaryBundleHeading: { marginTop: 10, paddingBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db" },
  summaryBundleHeadingText: { fontSize: 12, fontWeight: "700", color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 },
  summaryRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db" },
  summaryRowExcluded: { opacity: 0.5 },
  summaryItemImage: { width: 120, height: 80, borderRadius: 8, marginBottom: 6, backgroundColor: "#f3f4f6" },
  summaryRowMain: { flexDirection: "row" },
  summaryCell: { fontSize: 14, color: "#111827" },
  summaryDescCell: { flex: 3 },
  summaryNumCell: { flex: 1, textAlign: "right" },
  summaryOptionalLabel: { marginTop: 2, fontSize: 11, fontWeight: "700", color: "#7e22ce" },
  summaryWaivedLabel: { marginTop: 2, fontSize: 11, fontWeight: "700", color: "#1d4ed8", textAlign: "right" },
});

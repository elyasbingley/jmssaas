import { useState } from "react";
import { Alert, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { calculateDocumentTotals, computeLineItemUnitPriceCents, formatCentsAsAud, type LineItemFormInput } from "@jmssaas/shared";
import { AddLineItemBar } from "./AddLineItemBar";
import { supabase } from "../lib/supabase";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";

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

// Shared by quotes/new, quotes/[id], invoices/new and invoices/[id] - the
// full internal editor (labour rate/hours, material cost, markup%,
// quantity), all editable in place, with a live GST-inclusive total computed
// with the same calculateDocumentTotals helper the totals get saved with.
// This is admin-only: the breakdown fields (rate/hours/material/markup) are
// margin-revealing figures the client (and, per the person's brief, anyone
// non-admin) should never see - see LineItemSummary below for that view.
export function LineItemEditor({ items, onChange, membershipDiscountCents = 0, tenantId }: LineItemEditorProps) {
  const styles = useThemedStyles(createStyles);
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
            placeholderTextColor={styles.placeholder.color}
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
    fieldGrid: { flexDirection: "row" as const, gap: 8 },
    fieldCell: { flex: 1, gap: 4 },
    fieldLabel: { fontSize: 12, fontWeight: "600" as const, color: tokens.textMuted, ...mono },
    gstToggle: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.background, marginTop: 18, alignItems: "center" as const },
    gstToggleActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    gstToggleText: { color: tokens.textMuted, fontWeight: "700" as const, fontSize: 12, ...mono },
    gstToggleTextActive: { color: tokens.accent },
    subcontractedToggle: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.background, alignItems: "center" as const },
    subcontractedToggleActive: { backgroundColor: tokens.warning, borderColor: tokens.warning },
    subcontractedToggleText: { color: tokens.textMuted, fontWeight: "700" as const, fontSize: 12, ...mono },
    subcontractedToggleTextActive: { color: tokens.background },
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
    summaryWaivedLabel: { marginTop: 2, fontSize: 11, fontWeight: "700" as const, color: tokens.accent, textAlign: "right" as const, ...mono },
  };
}

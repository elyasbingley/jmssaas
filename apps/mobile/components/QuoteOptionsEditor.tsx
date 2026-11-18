import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { v4 as uuidv4 } from "uuid";
import {
  duplicateOption,
  formatCentsAsAud,
  optionTotals,
  replaceSection,
  sectionLines,
  type LineItemFormInput,
  type QuoteOption,
  type QuoteOptionInput,
} from "@jmssaas/shared";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { LineItemEditor, LineItemSummary } from "./LineItemEditor";

// Phone version of desktop's QuoteOptionsEditor (quote_options migration):
// a tab for the shared section ("In every option") and one per option,
// each editing just its own lines with the usual LineItemEditor. A quote
// with no options looks as before, with a button to start offering them.

const SHARED = "shared";

export function QuoteOptionsEditor({
  options,
  onOptionsChange,
  lineItems,
  onLineItemsChange,
  savedOptions,
  chosenOptionId,
  editable,
  canChoose,
  onChoose,
  membershipDiscountCents,
  tenantId,
}: {
  options: QuoteOptionInput[];
  onOptionsChange: (options: QuoteOptionInput[]) => void;
  lineItems: LineItemFormInput[];
  onLineItemsChange: (items: LineItemFormInput[]) => void;
  savedOptions: QuoteOption[];
  chosenOptionId: string | null;
  editable: boolean;
  canChoose: boolean;
  onChoose: (optionId: string | null) => void;
  membershipDiscountCents: number;
  tenantId: string;
}) {
  const styles = useThemedStyles(createStyles);
  const [active, setActive] = useState<string>(options[0]?.id ?? SHARED);
  const sorted = [...options].sort((a, b) => a.sort_order - b.sort_order);
  const activeOption = sorted.find((o) => o.id === active) ?? null;
  const activeKey = activeOption ? activeOption.id : null;
  const renumber = (list: QuoteOptionInput[]) => list.map((o, i) => ({ ...o, sort_order: i }));
  const updateOption = (id: string, patch: Partial<QuoteOptionInput>) =>
    onOptionsChange(options.map((o) => (o.id === id ? { ...o, ...patch } : patch.is_recommended ? { ...o, is_recommended: false } : o)));

  if (!options.length) {
    if (!editable) return <LineItemSummary items={lineItems} membershipDiscountCents={membershipDiscountCents} />;
    return (
      <View>
        <LineItemEditor items={lineItems} onChange={onLineItemsChange} membershipDiscountCents={membershipDiscountCents} tenantId={tenantId} />
        <Pressable
          onPress={() => {
            const first: QuoteOptionInput = { id: uuidv4(), name: "Option 1", description: "", is_recommended: false, sort_order: 0 };
            onOptionsChange([first, { id: uuidv4(), name: "Option 2", description: "", is_recommended: false, sort_order: 1 }]);
            setActive(first.id);
          }}
          style={styles.startButton}
        >
          <Text style={styles.link}>+ Offer options (e.g. Repair / Restore / Replace)</Text>
        </Pressable>
        <Text style={styles.hint}>The client picks one option on their quote link. The lines above stay in every option.</Text>
      </View>
    );
  }

  const removeOption = (option: QuoteOptionInput) => {
    Alert.alert("Remove option", `Remove "${option.name}" and its lines?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          const rest = renumber(sorted.filter((o) => o.id !== option.id));
          const remaining = lineItems.filter((item) => item.option_id !== option.id);
          if (rest.length === 1) {
            onLineItemsChange(remaining.map((item) => ({ ...item, option_id: null })));
            onOptionsChange([]);
            setActive(SHARED);
            return;
          }
          onLineItemsChange(remaining);
          onOptionsChange(rest);
          setActive(rest[0]?.id ?? SHARED);
        },
      },
    ]);
  };

  return (
    <View style={{ gap: 10 }}>
      <View style={styles.summary}>
        {sorted.map((o) => {
          const saved = savedOptions.find((s) => s.id === o.id);
          const isChosen = chosenOptionId === o.id;
          const total = saved && !editable ? saved.total_cents : optionTotals(lineItems, o.id).total_cents - (saved?.membership_discount_cents ?? 0);
          return (
            <View key={o.id} style={styles.summaryRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.summaryName}>
                  {o.name}
                  {o.is_recommended ? <Text style={styles.accent}> · Recommended</Text> : null}
                  {isChosen ? <Text style={styles.accent}> · CHOSEN</Text> : null}
                </Text>
                {canChoose && saved ? (
                  <Pressable onPress={() => onChoose(isChosen ? null : o.id)} hitSlop={6}>
                    <Text style={styles.smallLink}>{isChosen ? "Undo choice" : "Client chose this"}</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text style={styles.summaryTotal}>{formatCentsAsAud(total)}</Text>
            </View>
          );
        })}
        <Text style={styles.hint}>Until the client chooses, the quote counts as the recommended option (or the first).</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {[{ id: SHARED, name: "In every option", is_recommended: false } as Pick<QuoteOptionInput, "id" | "name" | "is_recommended">, ...sorted].map((o) => (
          <Pressable key={o.id} onPress={() => setActive(o.id)} style={[styles.tab, active === o.id && styles.tabActive]}>
            <Text style={[styles.tabText, active === o.id && styles.tabTextActive]}>
              {o.is_recommended ? "★ " : ""}
              {o.name} ({sectionLines(lineItems, o.id === SHARED ? null : o.id).length})
            </Text>
          </Pressable>
        ))}
        {editable ? (
          <Pressable
            onPress={() => {
              const option: QuoteOptionInput = { id: uuidv4(), name: `Option ${sorted.length + 1}`, description: "", is_recommended: false, sort_order: sorted.length };
              onOptionsChange([...sorted, option]);
              setActive(option.id);
            }}
            style={styles.tab}
          >
            <Text style={styles.link}>+ Add option</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {activeOption && editable ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={activeOption.name}
            onChangeText={(name) => updateOption(activeOption.id, { name })}
            placeholder="Option name"
            placeholderTextColor={styles.placeholder.color}
            style={styles.input}
          />
          <TextInput
            value={activeOption.description}
            onChangeText={(description) => updateOption(activeOption.id, { description })}
            placeholder="What this option includes (shown to the client)"
            placeholderTextColor={styles.placeholder.color}
            multiline
            style={[styles.input, { minHeight: 60 }]}
          />
          <View style={styles.actions}>
            <Pressable onPress={() => updateOption(activeOption.id, { is_recommended: !activeOption.is_recommended })}>
              <Text style={styles.smallLink}>{activeOption.is_recommended ? "★ Recommended (tap to unmark)" : "☆ Mark recommended"}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                const copy = duplicateOption(lineItems, activeOption, uuidv4(), sorted.length);
                onOptionsChange([...sorted, copy.option]);
                onLineItemsChange([...lineItems, ...copy.lines]);
                setActive(copy.option.id);
              }}
            >
              <Text style={styles.smallLink}>Copy option</Text>
            </Pressable>
            <Pressable onPress={() => removeOption(activeOption)}>
              <Text style={styles.danger}>Remove option</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {activeOption && !editable && activeOption.description ? <Text style={styles.hint}>{activeOption.description}</Text> : null}
      {!activeOption ? <Text style={styles.hint}>These lines are in every option - e.g. a call-out fee.</Text> : null}

      {editable ? (
        <LineItemEditor
          key={active}
          items={sectionLines(lineItems, activeKey)}
          onChange={(section) => onLineItemsChange(replaceSection(lineItems, activeKey, section))}
          membershipDiscountCents={0}
          tenantId={tenantId}
        />
      ) : (
        <LineItemSummary items={sectionLines(lineItems, activeKey)} membershipDiscountCents={0} />
      )}
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    startButton: { paddingVertical: 10 },
    link: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.body - 1, ...mono },
    smallLink: { color: tokens.accent, fontWeight: "600" as const, fontSize: font.label, marginTop: 2, ...mono },
    danger: { color: tokens.danger, fontWeight: "600" as const, fontSize: font.label, ...mono },
    accent: { color: tokens.accent, fontSize: font.label },
    hint: { color: tokens.textMuted, fontSize: font.label, ...mono },
    summary: { borderWidth: 1, borderColor: tokens.border, borderRadius: 4, backgroundColor: tokens.surface, padding: 10, gap: 8 },
    summaryRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    summaryName: { color: tokens.textPrimary, fontSize: font.body - 1, fontWeight: "600" as const, ...mono },
    summaryTotal: { color: tokens.textPrimary, fontSize: font.body, fontWeight: "800" as const, ...mono },
    tab: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 3, borderWidth: 1, borderColor: tokens.border },
    tabActive: { borderColor: tokens.accent, backgroundColor: tokens.accentGlow },
    tabText: { color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.label, ...mono },
    tabTextActive: { color: tokens.accent },
    input: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 10, color: tokens.textPrimary, backgroundColor: tokens.background, fontSize: font.body - 1, ...mono },
    placeholder: { color: tokens.textMuted },
    actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 14 },
  };
}

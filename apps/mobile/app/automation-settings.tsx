import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, TextInput, View, Pressable } from "react-native";
import { usePowerSync, useQuery } from "@powersync/react";
import {
  ALL_PLACEHOLDER_TOKENS,
  updateCommunicationRuleSchema,
  updateCommunicationTemplateSchema,
  type CommunicationRule,
  type CommunicationTemplate,
  type CommunicationDelayUnit,
  type CommunicationDelayDirection,
  type CommunicationChannel,
} from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { useIsOnline } from "../lib/connectivity";
import { supabase } from "../lib/supabase";
import { useSupabaseFetch } from "../lib/use-supabase-fetch";
import { getErrorMessage } from "../lib/errors";
import { CenteredModal } from "../components/CenteredModal";
import { FormField } from "../components/FormField";
import { DateField } from "../components/DateField";

// Reached via a small admin-only "Automation & Messaging" link on the
// Settings tab, alongside Company Details/Team/Job Setup/Inventory Setup.
// communication_rules/communication_templates are PowerSync-synced
// (tenant_reference_data bucket, admin-only write via RLS - see
// powersync/sync-rules.yaml), so timing/message edits work offline like
// Job Setup does. The one exception is the Google review link field below,
// which lives on `tenants` directly (not PowerSync-synced, same as every
// other Company Settings field) and so needs a live connection to save,
// same RequiresConnectionNotice-style gating as company-settings.tsx.
//
// Deliberately scoped to editing the six trigger_keys this migration seeds
// and the triggers below actually know how to fire (see the
// communication_engine migration's own header comment) - not a fully
// custom "add your own automation" builder. An admin can still create
// extra communication_rules/communication_templates rows some other way,
// but there's no UI for that here.

interface TenantReviewLink {
  google_review_link: string | null;
}

const TRIGGER_GROUPS: { title: string; keys: string[] }[] = [
  { title: "Quote Follow-ups", keys: ["quote_stage_1", "quote_stage_2"] },
  { title: "Invoice Reminders", keys: ["invoice_pre_due", "invoice_overdue_1"] },
  { title: "Field Alerts", keys: ["job_on_the_way", "job_review_request"] },
];

const TRIGGER_LABELS: Record<string, string> = {
  quote_stage_1: "First follow-up",
  quote_stage_2: "Second follow-up",
  invoice_pre_due: "Reminder before due",
  invoice_overdue_1: "Overdue reminder",
  job_on_the_way: "On The Way",
  job_review_request: "Review request",
};

// What the delay is measured relative to - used to build a plain-English
// timing summary, e.g. "3 days after the quote is sent".
const TRIGGER_ANCHORS: Record<string, string> = {
  quote_stage_1: "the quote is sent",
  quote_stage_2: "the quote is sent",
  invoice_pre_due: "the invoice is due",
  invoice_overdue_1: "the invoice is due",
  job_on_the_way: "sent",
  job_review_request: "the job is completed",
};

const CHANNEL_OPTIONS: CommunicationChannel[] = ["sms", "email", "both"];
const UNIT_OPTIONS: CommunicationDelayUnit[] = ["hours", "days"];
const DIRECTION_OPTIONS: CommunicationDelayDirection[] = ["before", "after"];

function summarizeTiming(rule: CommunicationRule): string {
  const anchor = TRIGGER_ANCHORS[rule.trigger_key] ?? "the trigger event";
  if (rule.delay_offset_value === 0) return `Sent immediately when ${anchor}`;
  const unitLabel = rule.delay_offset_value === 1 ? rule.delay_offset_unit.replace(/s$/, "") : rule.delay_offset_unit;
  return `${rule.delay_offset_value} ${unitLabel} ${rule.delay_direction} ${anchor}`;
}

// quiet_hours_start/end come back from PowerSync as "HH:MM:SS" text -
// DateField wants a Date, so round-trip through today's date purely to
// carry the time-of-day component.
function timeStringToDate(time: string): Date {
  const [h, m] = time.split(":").map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

function dateToTimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

export default function AutomationSettingsScreen() {
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";

  const { data: rules } = useQuery<CommunicationRule>("SELECT * FROM communication_rules ORDER BY trigger_key");
  const { data: templates } = useQuery<CommunicationTemplate>(
    "SELECT * FROM communication_templates ORDER BY trigger_key, type"
  );

  const { data: tenant, refetch: refetchTenant } = useSupabaseFetch<TenantReviewLink>(async () => {
    const { data, error } = await supabase
      .from("tenants")
      .select("google_review_link")
      .eq("id", profile?.tenant_id)
      .single();
    if (error) throw error;
    return data as TenantReviewLink;
  }, [profile?.tenant_id, isOnline]);

  const [reviewLink, setReviewLink] = useState("");
  const [reviewLinkSaving, setReviewLinkSaving] = useState(false);
  const [reviewLinkError, setReviewLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (tenant) setReviewLink(tenant.google_review_link ?? "");
  }, [tenant]);

  const handleSaveReviewLink = async () => {
    setReviewLinkSaving(true);
    setReviewLinkError(null);
    try {
      const { error } = await supabase
        .from("tenants")
        .update({ google_review_link: reviewLink || null })
        .eq("id", profile?.tenant_id);
      if (error) throw error;
      refetchTenant();
    } catch (e) {
      setReviewLinkError(getErrorMessage(e, "Failed to save (see console for details)"));
    } finally {
      setReviewLinkSaving(false);
    }
  };

  // Rule edit modal
  const [ruleModalVisible, setRuleModalVisible] = useState(false);
  const [editingRule, setEditingRule] = useState<CommunicationRule | null>(null);
  const [ruleDelayValue, setRuleDelayValue] = useState("0");
  const [ruleDelayUnit, setRuleDelayUnit] = useState<CommunicationDelayUnit>("days");
  const [ruleDirection, setRuleDirection] = useState<CommunicationDelayDirection>("after");
  const [ruleChannel, setRuleChannel] = useState<CommunicationChannel>("sms");
  const [ruleQuietStart, setRuleQuietStart] = useState<Date>(timeStringToDate("08:00:00"));
  const [ruleQuietEnd, setRuleQuietEnd] = useState<Date>(timeStringToDate("18:00:00"));
  const [ruleError, setRuleError] = useState<string | null>(null);

  const openEditRule = (rule: CommunicationRule) => {
    setEditingRule(rule);
    setRuleDelayValue(String(rule.delay_offset_value));
    setRuleDelayUnit(rule.delay_offset_unit);
    setRuleDirection(rule.delay_direction);
    setRuleChannel(rule.channel);
    setRuleQuietStart(timeStringToDate(rule.quiet_hours_start));
    setRuleQuietEnd(timeStringToDate(rule.quiet_hours_end));
    setRuleError(null);
    setRuleModalVisible(true);
  };

  const handleToggleRule = async (rule: CommunicationRule) => {
    await powersync.execute("UPDATE communication_rules SET is_enabled = ?, updated_at = ? WHERE id = ?", [
      rule.is_enabled ? 0 : 1,
      new Date().toISOString(),
      rule.id,
    ]);
  };

  const handleSaveRule = async () => {
    if (!editingRule) return;
    const result = updateCommunicationRuleSchema.safeParse({
      is_enabled: !!editingRule.is_enabled,
      delay_offset_value: Number(ruleDelayValue) || 0,
      delay_offset_unit: ruleDelayUnit,
      delay_direction: ruleDirection,
      channel: ruleChannel,
      quiet_hours_start: dateToTimeString(ruleQuietStart),
      quiet_hours_end: dateToTimeString(ruleQuietEnd),
    });
    if (!result.success) {
      setRuleError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    await powersync.execute(
      `UPDATE communication_rules
       SET delay_offset_value = ?, delay_offset_unit = ?, delay_direction = ?, channel = ?,
           quiet_hours_start = ?, quiet_hours_end = ?, updated_at = ?
       WHERE id = ?`,
      [
        result.data.delay_offset_value,
        result.data.delay_offset_unit,
        result.data.delay_direction,
        result.data.channel,
        result.data.quiet_hours_start,
        result.data.quiet_hours_end,
        new Date().toISOString(),
        editingRule.id,
      ]
    );
    setRuleModalVisible(false);
  };

  // Template edit modal
  const [templateModalVisible, setTemplateModalVisible] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<CommunicationTemplate | null>(null);
  const [templateSubject, setTemplateSubject] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [templateActive, setTemplateActive] = useState(true);
  const [bodySelection, setBodySelection] = useState({ start: 0, end: 0 });
  const [templateError, setTemplateError] = useState<string | null>(null);

  const openEditTemplate = (template: CommunicationTemplate) => {
    setEditingTemplate(template);
    setTemplateSubject(template.subject ?? "");
    setTemplateBody(template.body);
    setTemplateActive(!!template.is_active);
    setBodySelection({ start: template.body.length, end: template.body.length });
    setTemplateError(null);
    setTemplateModalVisible(true);
  };

  const insertToken = (token: string) => {
    const insert = `{${token}}`;
    const start = bodySelection.start;
    const end = bodySelection.end;
    const next = templateBody.slice(0, start) + insert + templateBody.slice(end);
    setTemplateBody(next);
    const cursor = start + insert.length;
    setBodySelection({ start: cursor, end: cursor });
  };

  const handleSaveTemplate = async () => {
    if (!editingTemplate) return;
    const result = updateCommunicationTemplateSchema.safeParse({
      name: editingTemplate.name,
      subject: templateSubject || undefined,
      body: templateBody,
      is_active: templateActive,
    });
    if (!result.success) {
      setTemplateError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    await powersync.execute(
      `UPDATE communication_templates SET subject = ?, body = ?, is_active = ?, updated_at = ? WHERE id = ?`,
      [result.data.subject || null, result.data.body, result.data.is_active ? 1 : 0, new Date().toISOString(), editingTemplate.id]
    );
    setTemplateModalVisible(false);
  };

  if (!isAdmin) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Only admins can manage automation & messaging.</Text>
      </View>
    );
  }

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={styles.subtitle}>
          Control when automated SMS/email messages go out, and edit their wording.
        </Text>

        {TRIGGER_GROUPS.map((group) => (
          <View key={group.title}>
            <Text style={styles.sectionTitle}>{group.title}</Text>
            {group.keys.map((key) => {
              const rule = rules.find((r) => r.trigger_key === key);
              const triggerTemplates = templates.filter((t) => t.trigger_key === key);
              if (!rule) return null;
              return (
                <View key={key} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.cardTitle}>{TRIGGER_LABELS[key] ?? key}</Text>
                    <Switch value={!!rule.is_enabled} onValueChange={() => handleToggleRule(rule)} />
                  </View>
                  <Text style={styles.cardSummary}>{summarizeTiming(rule)}</Text>
                  <Text style={styles.cardMeta}>
                    Channel: {rule.channel} · Quiet hours {rule.quiet_hours_start.slice(0, 5)}-
                    {rule.quiet_hours_end.slice(0, 5)}
                  </Text>
                  <Pressable onPress={() => openEditRule(rule)}>
                    <Text style={styles.link}>Edit timing</Text>
                  </Pressable>

                  {triggerTemplates.map((template) => (
                    <View key={template.id} style={styles.templateRow}>
                      <View style={styles.templateRowText}>
                        <Text style={styles.templateName}>
                          {template.name} ({template.type})
                        </Text>
                        <Text style={styles.templatePreview} numberOfLines={2}>
                          {template.body}
                        </Text>
                      </View>
                      <Pressable onPress={() => openEditTemplate(template)}>
                        <Text style={styles.link}>Edit message</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              );
            })}
          </View>
        ))}

        <Text style={styles.sectionTitle}>Review link</Text>
        <Text style={styles.subtitle}>Used by the {"{google_review_link}"} tag in the review request message.</Text>
        {!isOnline ? (
          <Text style={styles.empty}>Connect to the internet to edit the review link.</Text>
        ) : (
          <>
            <FormField
              label="Google review link"
              placeholder="https://g.page/r/..."
              value={reviewLink}
              onChangeText={setReviewLink}
              autoCapitalize="none"
            />
            {reviewLinkError ? <Text style={styles.error}>{reviewLinkError}</Text> : null}
            <Pressable style={styles.saveButton} onPress={handleSaveReviewLink} disabled={reviewLinkSaving}>
              <Text style={styles.saveButtonText}>{reviewLinkSaving ? "Saving..." : "Save review link"}</Text>
            </Pressable>
          </>
        )}
      </ScrollView>

      <CenteredModal visible={ruleModalVisible} onClose={() => setRuleModalVisible(false)}>
        <Text style={styles.modalTitle}>Edit timing{editingRule ? ` - ${TRIGGER_LABELS[editingRule.trigger_key]}` : ""}</Text>

        <FormField label="Delay value" value={ruleDelayValue} onChangeText={setRuleDelayValue} keyboardType="number-pad" />

        <Text style={styles.fieldLabel}>Delay unit</Text>
        <View style={styles.chipRow}>
          {UNIT_OPTIONS.map((unit) => (
            <Pressable
              key={unit}
              style={[styles.chip, ruleDelayUnit === unit && styles.chipSelected]}
              onPress={() => setRuleDelayUnit(unit)}
            >
              <Text style={[styles.chipText, ruleDelayUnit === unit && styles.chipTextSelected]}>{unit}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.fieldLabel}>Direction</Text>
        <View style={styles.chipRow}>
          {DIRECTION_OPTIONS.map((direction) => (
            <Pressable
              key={direction}
              style={[styles.chip, ruleDirection === direction && styles.chipSelected]}
              onPress={() => setRuleDirection(direction)}
            >
              <Text style={[styles.chipText, ruleDirection === direction && styles.chipTextSelected]}>{direction}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.fieldLabel}>Channel</Text>
        <View style={styles.chipRow}>
          {CHANNEL_OPTIONS.map((channel) => (
            <Pressable
              key={channel}
              style={[styles.chip, ruleChannel === channel && styles.chipSelected]}
              onPress={() => setRuleChannel(channel)}
            >
              <Text style={[styles.chipText, ruleChannel === channel && styles.chipTextSelected]}>{channel}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.quietHoursRow}>
          <View style={styles.quietHoursItem}>
            <DateField label="Quiet hours start" value={ruleQuietStart} onChange={setRuleQuietStart} mode="time" />
          </View>
          <View style={styles.quietHoursItem}>
            <DateField label="Quiet hours end" value={ruleQuietEnd} onChange={setRuleQuietEnd} mode="time" />
          </View>
        </View>

        {ruleError ? <Text style={styles.error}>{ruleError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setRuleModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleSaveRule}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <CenteredModal visible={templateModalVisible} onClose={() => setTemplateModalVisible(false)}>
        <Text style={styles.modalTitle}>{editingTemplate?.name}</Text>

        {editingTemplate?.type === "email" ? (
          <FormField label="Subject" value={templateSubject} onChangeText={setTemplateSubject} />
        ) : null}

        <Text style={styles.fieldLabel}>Insert tag</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tokenScroll}>
          {ALL_PLACEHOLDER_TOKENS.map((token) => (
            <Pressable key={token} style={styles.tokenChip} onPress={() => insertToken(token)}>
              <Text style={styles.tokenChipText}>{`{${token}}`}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <View style={styles.fieldSpacing}>
          <Text style={styles.fieldLabel}>Message</Text>
          <TextInput
            style={styles.bodyInput}
            multiline
            numberOfLines={5}
            value={templateBody}
            onChangeText={setTemplateBody}
            selection={bodySelection}
            onSelectionChange={(e) => setBodySelection(e.nativeEvent.selection)}
          />
        </View>

        <View style={styles.cardHeader}>
          <Text style={styles.fieldLabel}>Active</Text>
          <Switch value={templateActive} onValueChange={setTemplateActive} />
        </View>

        {templateError ? <Text style={styles.error}>{templateError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setTemplateModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleSaveTemplate}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  subtitle: { color: "#6b7280", marginTop: 2, marginBottom: 12 },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: "#111827", marginTop: 20, marginBottom: 8 },
  card: {
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    gap: 4,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardTitle: { fontSize: 15, fontWeight: "700", color: "#111827" },
  cardSummary: { fontSize: 14, color: "#374151" },
  cardMeta: { fontSize: 12, color: "#6b7280", marginBottom: 4 },
  link: { color: "#1d4ed8", fontWeight: "600" },
  templateRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e5e7eb",
  },
  templateRowText: { flex: 1 },
  templateName: { fontSize: 13, fontWeight: "600", color: "#111827" },
  templatePreview: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
  error: { color: "#dc2626", marginTop: 12 },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 12 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: "#374151", marginTop: 12, marginBottom: 6 },
  fieldSpacing: { marginTop: 4 },
  chipRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  chip: { borderWidth: 1, borderColor: "#ccc", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  chipSelected: { backgroundColor: "#1d4ed8", borderColor: "#1d4ed8" },
  chipText: { color: "#374151", fontWeight: "600", fontSize: 13 },
  chipTextSelected: { color: "#fff" },
  quietHoursRow: { flexDirection: "row", gap: 12, marginTop: 12 },
  quietHoursItem: { flex: 1 },
  tokenScroll: { marginBottom: 4 },
  tokenChip: {
    backgroundColor: "#eff6ff",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 6,
  },
  tokenChipText: { color: "#1d4ed8", fontSize: 12, fontWeight: "600" },
  bodyInput: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    color: "#111827",
    minHeight: 110,
    textAlignVertical: "top",
  },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 16 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
});

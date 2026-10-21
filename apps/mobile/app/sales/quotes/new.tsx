import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  createQuoteSchema,
  type Client,
  type JobCard,
  type LineItemFormInput,
  type ReferralPartner,
  type Template,
} from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { supabase } from "../../../lib/supabase";
import { getErrorMessage } from "../../../lib/errors";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedFormField } from "../../../components/theme/ThemedFormField";
import { ThemedDateField } from "../../../components/theme/ThemedDateField";
import { ThemedPickerModal } from "../../../components/theme/ThemedPickerModal";
import { ThemedButton } from "../../../components/theme/ThemedButton";
import { LineItemEditor } from "../../../components/LineItemEditor";
import { emptyLineItem, normalizeLineItem } from "../../../lib/line-items";
import { partnerDisplayName } from "../../b2b-referrals/index";

function toDateInput(d: Date | null): string {
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function NewQuoteScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);
  // Cross-linking: arriving here from a job card's "+ New quote for this
  // job" button pre-fills and locks the client/job so the created quote
  // automatically links back (job_card_id), matching how the job then shows
  // it in its own linked-quotes list.
  const { jobCardId, clientId } = useLocalSearchParams<{ jobCardId?: string; clientId?: string }>();

  const { data: clients } = useQuery<Client>("SELECT * FROM clients ORDER BY name");

  const { data: templates } = useSupabaseFetch<Template[]>(async () => {
    const { data, error } = await supabase.from("templates").select("*").eq("type", "quote");
    if (error) throw error;
    return (data ?? []) as Template[];
  }, [isOnline]);
  const { data: referralPartners } = useSupabaseFetch<ReferralPartner[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("referral_partners").select("*").order("contact_first_name");
    if (error) throw error;
    return data as ReferralPartner[];
  }, [isOnline]);

  const [client, setClient] = useState<Client | null>(null);
  const [jobCard, setJobCard] = useState<JobCard | null>(null);
  const [expiryDate, setExpiryDate] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  const [lineItems, setLineItems] = useState<LineItemFormInput[]>([emptyLineItem(0)]);
  const [referralPartner, setReferralPartner] = useState<ReferralPartner | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [clientPickerVisible, setClientPickerVisible] = useState(false);
  const [jobPickerVisible, setJobPickerVisible] = useState(false);
  const [templatePickerVisible, setTemplatePickerVisible] = useState(false);
  const [referralPartnerPickerVisible, setReferralPartnerPickerVisible] = useState(false);

  const { data: clientJobCards } = useQuery<JobCard>(
    "SELECT * FROM job_cards WHERE client_id = ? ORDER BY created_at DESC",
    [client?.id ?? ""]
  );

  const lockedFromJob = !!jobCardId;

  useEffect(() => {
    if (clientId && clients.length > 0 && !client) {
      setClient(clients.find((c) => c.id === clientId) ?? null);
    }
  }, [clientId, clients, client]);

  useEffect(() => {
    if (jobCardId && clientJobCards.length > 0 && !jobCard) {
      setJobCard(clientJobCards.find((j) => j.id === jobCardId) ?? null);
    }
  }, [jobCardId, clientJobCards, jobCard]);

  const handleSubmit = async () => {
    const result = createQuoteSchema.safeParse({
      client_id: client?.id,
      job_card_id: jobCard?.id,
      expiry_date: toDateInput(expiryDate) || undefined,
      notes,
      line_items: lineItems,
      referral_partner_id: referralPartner?.id,
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    if (!profile) return;

    setSubmitting(true);
    setFormError(null);
    try {
      const quoteId = uuidv4();
      const now = new Date().toISOString();

      const { error: quoteError } = await supabase.from("quotes").insert({
        id: quoteId,
        tenant_id: profile.tenant_id,
        client_id: result.data.client_id,
        job_card_id: result.data.job_card_id ?? null,
        status: "draft",
        issue_date: now.slice(0, 10),
        expiry_date: result.data.expiry_date ?? null,
        notes: result.data.notes || null,
        referral_partner_id: result.data.referral_partner_id ?? null,
        created_by: profile.id,
      });
      if (quoteError) throw quoteError;

      // replace_quote_line_items inserts every line item - including the
      // itemized breakdown fields and crew/materials children - and
      // recomputes subtotal/gst/total/membership discount from them
      // server-side, same as the desktop fix and this screen's own
      // quotes/[id].tsx save path. Previously this used a second,
      // hand-rolled insert here that only knew about the pre-itemized-
      // rework columns, so a quote created from scratch on mobile silently
      // lost pricing_model/unit/labour_cost_rate_cents/crew/materials/etc
      // the moment it was first saved. This screen already requires
      // connectivity to submit (quotes.insert above is a direct network
      // call via the plain Supabase client, not a local PowerSync write),
      // so calling the RPC here doesn't change the screen's offline
      // behaviour.
      const { error: lineItemsError } = await supabase.rpc("replace_quote_line_items", {
        p_quote_id: quoteId,
        p_items: result.data.line_items,
      });
      if (lineItemsError) throw lineItemsError;

      router.replace(`/sales/quotes/${quoteId}`);
    } catch (e) {
      console.error("[Quotes] Failed to create quote", e);
      setFormError(getErrorMessage(e, "Failed to create quote (see console for details)"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>New Quote</Text>
        </View>

        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Quotes" />
        ) : (
          <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
            <Text style={styles.sectionTitle}>Client</Text>
            <Pressable
              style={styles.pickerField}
              // Only actually locked once the pre-fill has resolved - if
              // this screen arrived with jobCardId but the client never
              // resolves (clientId missing/stale, or the client hasn't
              // synced locally yet), the field stays pickable instead of
              // trapping the person on a locked, empty box with no way to
              // choose anyone and no way to save the quote.
              onPress={() => (!lockedFromJob || !client) && setClientPickerVisible(true)}
              disabled={lockedFromJob && !!client}
            >
              <Text style={client ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
                {client?.name ?? "Select a client"}
              </Text>
            </Pressable>

            <Text style={styles.sectionTitle}>Linked Job{lockedFromJob ? "" : " (optional)"}</Text>
            <Pressable
              style={styles.pickerField}
              onPress={() => client && (!lockedFromJob || !jobCard) && setJobPickerVisible(true)}
              disabled={!client || (lockedFromJob && !!jobCard)}
            >
              <Text style={jobCard ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
                {jobCard?.title ?? (client ? "Select a job" : "Pick a client first")}
              </Text>
            </Pressable>

            <View style={styles.fieldSpacing}>
              <ThemedDateField label="Expiry date (optional)" value={expiryDate} onChange={setExpiryDate} mode="date" placeholder="No expiry date" />
            </View>

            <Text style={styles.sectionTitle}>Referral Source (optional)</Text>
            <Pressable style={styles.pickerField} onPress={() => setReferralPartnerPickerVisible(true)}>
              <Text style={referralPartner ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
                {referralPartner ? partnerDisplayName(referralPartner) : "None"}
              </Text>
            </Pressable>

            {templates && templates.length > 0 ? (
              <Pressable style={styles.templateButton} onPress={() => setTemplatePickerVisible(true)}>
                <Text style={styles.templateButtonText}>Load from template</Text>
              </Pressable>
            ) : null}

            <Text style={styles.sectionTitle}>Line Items</Text>
            <LineItemEditor items={lineItems} onChange={setLineItems} tenantId={profile?.tenant_id ?? ""} />

            <View style={styles.fieldSpacing}>
              <ThemedFormField
                label="Notes (optional)"
                placeholder="Terms, exclusions, etc."
                value={notes}
                onChangeText={setNotes}
                multiline
                style={styles.multiline}
              />
            </View>

            {formError ? <Text style={styles.error}>{formError}</Text> : null}

            <View style={styles.submitButtonWrap}>
              <ThemedButton label={submitting ? "Saving..." : "Create Quote"} onPress={handleSubmit} disabled={submitting} />
            </View>
          </ScrollView>
        )}
      </SafeAreaView>

      <ThemedPickerModal
        visible={clientPickerVisible}
        title="Select client"
        items={clients}
        getKey={(c) => c.id}
        getLabel={(c) => c.name}
        onSelect={(c) => {
          setClient(c);
          setJobCard(null);
        }}
        onClose={() => setClientPickerVisible(false)}
      />
      <ThemedPickerModal
        visible={jobPickerVisible}
        title="Select a job"
        items={clientJobCards}
        getKey={(j) => j.id}
        getLabel={(j) => j.title}
        onSelect={setJobCard}
        onClose={() => setJobPickerVisible(false)}
      />
      <ThemedPickerModal
        visible={templatePickerVisible}
        title="Select template"
        items={templates ?? []}
        getKey={(t) => t.id}
        getLabel={(t) => t.name}
        onSelect={(t) => setLineItems(t.default_line_items.map((item, index) => normalizeLineItem(item, index)))}
        onClose={() => setTemplatePickerVisible(false)}
      />
      <ThemedPickerModal
        visible={referralPartnerPickerVisible}
        title="Select referral source"
        items={referralPartners ?? []}
        getKey={(p) => p.id}
        getLabel={(p) => partnerDisplayName(p)}
        onSelect={setReferralPartner}
        onClose={() => setReferralPartnerPickerVisible(false)}
      />
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    sectionTitle: {
      fontSize: font.label,
      fontWeight: "700" as const,
      color: tokens.accent,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      marginTop: 16,
      marginBottom: 6,
      ...mono,
    },
    fieldSpacing: { marginTop: 16 },
    multiline: { minHeight: 70, textAlignVertical: "top" as const },
    pickerField: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, backgroundColor: tokens.background },
    pickerFieldText: { fontSize: font.body, color: tokens.textPrimary, ...mono },
    pickerFieldPlaceholder: { fontSize: font.body, color: tokens.textMuted, ...mono },
    templateButton: { marginTop: 12, alignSelf: "flex-start" as const },
    templateButtonText: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    error: { color: tokens.danger, marginTop: 12, ...mono },
    submitButtonWrap: { marginTop: 20 },
  };
}

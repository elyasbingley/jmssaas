import { useState } from "react";
import { Pressable, Text } from "react-native";
import type { LeadSource, ReferralPartner } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useIsOnline } from "../lib/connectivity";
import { useSupabaseFetch } from "../lib/use-supabase-fetch";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { ThemedPickerModal } from "./theme/ThemedPickerModal";
import { partnerDisplayName } from "../app/b2b-referrals/index";

// "Where did this job come from?" for the New Job forms: the lead source,
// then - only for the referral source - who referred it. The same pair and
// rule as desktop's New Job form and the job screen's Lead source row: a
// referral partner is only ever kept alongside the referral lead source.
//
// lead_sources and referral_partners aren't PowerSync tables, so the
// options load while online. Offline the job can still be created; the
// lead source can be added from the job screen later.

export interface LeadSourceValue {
  leadSource: LeadSource | null;
  referralPartner: ReferralPartner | null;
}
export const EMPTY_LEAD_SOURCE: LeadSourceValue = { leadSource: null, referralPartner: null };

// The two job_cards columns, shaped for createJobCardSchema (unset rather
// than null, as its fields are optional).
export function leadSourceColumns(v: LeadSourceValue): { lead_source_id?: string; referral_partner_id?: string } {
  return {
    lead_source_id: v.leadSource?.id,
    referral_partner_id: v.leadSource?.is_referral_source ? v.referralPartner?.id : undefined,
  };
}

export function LeadSourceFields({ value, onChange }: { value: LeadSourceValue; onChange: (v: LeadSourceValue) => void }) {
  const styles = useThemedStyles(createStyles);
  const isOnline = useIsOnline();
  const [sourcePicker, setSourcePicker] = useState(false);
  const [partnerPicker, setPartnerPicker] = useState(false);

  const { data: leadSources } = useSupabaseFetch<LeadSource[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("lead_sources").select("*").order("sort_order");
    if (error) throw error;
    return data as LeadSource[];
  }, [isOnline]);
  const { data: partners } = useSupabaseFetch<ReferralPartner[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("referral_partners").select("*").eq("status", "active").order("contact_first_name");
    if (error) throw error;
    return data as ReferralPartner[];
  }, [isOnline]);

  const { leadSource, referralPartner } = value;
  return (
    <>
      <Pressable style={styles.field} onPress={() => isOnline && setSourcePicker(true)} accessibilityRole="button" accessibilityLabel="Lead source">
        <Text style={styles.label}>Lead source (optional)</Text>
        <Text style={leadSource ? styles.text : styles.placeholder}>
          {leadSource?.name ?? (isOnline ? "Where did this job come from?" : "Offline - add it on the job later")}
        </Text>
      </Pressable>

      {leadSource?.is_referral_source ? (
        <Pressable style={styles.field} onPress={() => setPartnerPicker(true)} accessibilityRole="button" accessibilityLabel="Referral partner">
          <Text style={styles.label}>Referral partner</Text>
          <Text style={referralPartner ? styles.text : styles.placeholder}>{referralPartner ? partnerDisplayName(referralPartner) : "Who referred it?"}</Text>
        </Pressable>
      ) : null}

      <ThemedPickerModal
        visible={sourcePicker}
        title="Where did this job come from?"
        items={[null, ...(leadSources ?? [])]}
        getKey={(s) => s?.id ?? "none"}
        getLabel={(s) => (s ? s.name : "None")}
        onSelect={(s) => {
          onChange({ leadSource: s, referralPartner: s?.is_referral_source ? referralPartner : null });
          // Straight on to "who referred it?" once this picker has closed
          // (two modals can't animate at once), as on the job screen.
          if (s?.is_referral_source && !referralPartner) setTimeout(() => setPartnerPicker(true), 400);
        }}
        onClose={() => setSourcePicker(false)}
      />
      <ThemedPickerModal
        visible={partnerPicker}
        title="Who referred this job?"
        items={[null, ...(partners ?? [])]}
        getKey={(p) => p?.id ?? "none"}
        getLabel={(p) => (p ? partnerDisplayName(p) : "None")}
        onSelect={(p) => onChange({ leadSource, referralPartner: p })}
        onClose={() => setPartnerPicker(false)}
      />
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    field: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, backgroundColor: tokens.background, gap: 4 },
    label: { fontSize: font.label, fontWeight: "700" as const, color: tokens.textMuted, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    text: { fontSize: font.body, color: tokens.textPrimary, ...mono },
    placeholder: { fontSize: font.body, color: tokens.textMuted, ...mono },
  };
}

import { useState } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  updatePropertyContactSchema,
  updatePropertyDetailsSchema,
  type Agency,
  type Property,
  type PropertyManager,
  type PropertyType,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useIsOnline } from "../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../lib/errors";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";
import { ThemedModal } from "../../components/theme/ThemedModal";
import { ThemedFormField } from "../../components/theme/ThemedFormField";
import { ThemedPickerModal } from "../../components/theme/ThemedPickerModal";
import { ThemedButton } from "../../components/theme/ThemedButton";

// Mobile port of apps/desktop/src/pages/PropertyDetail.tsx's Access &
// Contacts tab + "Edit property details" action - Asset Register and Job
// & Compliance History aren't ported here (lower field value, larger
// scope; can follow later if actually needed day to day).

const PROPERTY_TYPE_OPTIONS: { value: PropertyType; label: string }[] = [
  { value: "residential", label: "Residential" },
  { value: "commercial", label: "Commercial" },
  { value: "strata_common_property", label: "Strata Common Property" },
  { value: "strata_lot", label: "Strata Lot" },
];

export default function PropertyDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

  const { data: property, refetch: refetchProperty } = useSupabaseFetch<Property | null>(async () => {
    if (!isOnline) return null;
    const { data, error } = await supabase.from("properties").select("*").eq("id", id).single();
    if (error) throw error;
    return data as Property;
  }, [isOnline, id]);
  useRefetchOnFocus(refetchProperty);

  const { data: agency } = useSupabaseFetch<Agency | null>(async () => {
    if (!isOnline || !property?.agency_id) return null;
    const { data, error } = await supabase.from("agencies").select("*").eq("id", property.agency_id).single();
    if (error) throw error;
    return data as Agency;
  }, [isOnline, property?.agency_id]);
  const { data: propertyManager } = useSupabaseFetch<PropertyManager | null>(async () => {
    if (!isOnline || !property?.property_manager_id) return null;
    const { data, error } = await supabase.from("property_managers").select("*").eq("id", property.property_manager_id).single();
    if (error) throw error;
    return data as PropertyManager;
  }, [isOnline, property?.property_manager_id]);
  const { data: allAgencies } = useSupabaseFetch<Agency[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("agencies").select("*").order("name");
    if (error) throw error;
    return data as Agency[];
  }, [isOnline]);
  const { data: allPropertyManagers } = useSupabaseFetch<PropertyManager[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("property_managers").select("*").order("first_name");
    if (error) throw error;
    return data as PropertyManager[];
  }, [isOnline]);

  // --- Edit Access & Contacts ---
  const [contactModalVisible, setContactModalVisible] = useState(false);
  const [ownerName, setOwnerName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [tenantPhone, setTenantPhone] = useState("");
  const [tenantEmail, setTenantEmail] = useState("");
  const [keyTagNumber, setKeyTagNumber] = useState("");
  const [accessNotes, setAccessNotes] = useState("");
  const [contactError, setContactError] = useState<string | null>(null);

  const openEditContact = () => {
    if (!property) return;
    setOwnerName(property.owner_landlord_name ?? "");
    setOwnerPhone(property.owner_landlord_phone ?? "");
    setOwnerEmail(property.owner_landlord_email ?? "");
    setTenantName(property.tenant_name ?? "");
    setTenantPhone(property.tenant_phone ?? "");
    setTenantEmail(property.tenant_email ?? "");
    setKeyTagNumber(property.key_tag_number ?? "");
    setAccessNotes(property.access_notes ?? "");
    setContactError(null);
    setContactModalVisible(true);
  };

  const handleSaveContact = async () => {
    const result = updatePropertyContactSchema.safeParse({
      owner_landlord_name: ownerName,
      owner_landlord_phone: ownerPhone,
      owner_landlord_email: ownerEmail,
      tenant_name: tenantName,
      tenant_phone: tenantPhone,
      tenant_email: tenantEmail,
      access_notes: accessNotes,
      key_tag_number: keyTagNumber,
    });
    if (!result.success) {
      setContactError(result.error.issues[0]?.message ?? "Invalid details");
      return;
    }
    const { error } = await supabase
      .from("properties")
      .update({
        owner_landlord_name: result.data.owner_landlord_name || null,
        owner_landlord_phone: result.data.owner_landlord_phone || null,
        owner_landlord_email: result.data.owner_landlord_email || null,
        tenant_name: result.data.tenant_name || null,
        tenant_phone: result.data.tenant_phone || null,
        tenant_email: result.data.tenant_email || null,
        access_notes: result.data.access_notes || null,
        key_tag_number: result.data.key_tag_number || null,
      })
      .eq("id", id);
    if (error) {
      setContactError(getErrorMessage(error, "Failed to save details"));
      return;
    }
    setContactModalVisible(false);
    refetchProperty();
  };

  // --- Edit property details (address/agency/PM/type) ---
  const [detailsModalVisible, setDetailsModalVisible] = useState(false);
  const [detailsAgencyId, setDetailsAgencyId] = useState<string | null>(null);
  const [detailsAgencyPickerVisible, setDetailsAgencyPickerVisible] = useState(false);
  const [detailsPmId, setDetailsPmId] = useState<string | null>(null);
  const [detailsPmPickerVisible, setDetailsPmPickerVisible] = useState(false);
  const [detailsAddress, setDetailsAddress] = useState("");
  const [detailsSuburb, setDetailsSuburb] = useState("");
  const [detailsState, setDetailsState] = useState("");
  const [detailsPostcode, setDetailsPostcode] = useState("");
  const [detailsPropertyType, setDetailsPropertyType] = useState<PropertyType>("residential");
  const [detailsTypePickerVisible, setDetailsTypePickerVisible] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const openEditDetails = () => {
    if (!property) return;
    setDetailsAgencyId(property.agency_id);
    setDetailsPmId(property.property_manager_id);
    setDetailsAddress(property.address_line1);
    setDetailsSuburb(property.suburb);
    setDetailsState(property.state);
    setDetailsPostcode(property.postcode);
    setDetailsPropertyType(property.property_type);
    setDetailsError(null);
    setDetailsModalVisible(true);
  };

  const handleSaveDetails = async () => {
    const result = updatePropertyDetailsSchema.safeParse({
      agency_id: detailsAgencyId,
      property_manager_id: detailsPmId,
      address_line1: detailsAddress,
      suburb: detailsSuburb,
      state: detailsState,
      postcode: detailsPostcode,
      property_type: detailsPropertyType,
    });
    if (!result.success) {
      setDetailsError(result.error.issues[0]?.message ?? "Invalid details");
      return;
    }
    const { error } = await supabase
      .from("properties")
      .update({
        agency_id: result.data.agency_id,
        property_manager_id: result.data.property_manager_id || null,
        address_line1: result.data.address_line1,
        suburb: result.data.suburb,
        state: result.data.state,
        postcode: result.data.postcode,
        property_type: result.data.property_type,
      })
      .eq("id", id);
    if (error) {
      setDetailsError(getErrorMessage(error, "Failed to save property details"));
      return;
    }
    setDetailsModalVisible(false);
    refetchProperty();
  };

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Text style={styles.link}>‹ Back</Text>
      </Pressable>
      <Text style={styles.headerTitle}>Property</Text>
    </View>
  );

  if (!isOnline) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
          {header}
          <ThemedRequiresConnectionNotice label="Property" />
        </SafeAreaView>
      </>
    );
  }

  if (!property) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
          {header}
          <Text style={styles.empty}>Loading...</Text>
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        {header}
        <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{property.address_line1}</Text>
              <Text style={styles.subtitle}>
                {property.suburb} {property.state} {property.postcode}
              </Text>
              <View style={styles.badgeRow}>
                {agency ? <Text style={styles.badge}>{agency.name}</Text> : null}
                {propertyManager ? (
                  <Text style={[styles.badge, styles.badgeAccent]}>
                    PM: {propertyManager.first_name} {propertyManager.last_name}
                  </Text>
                ) : null}
                {property.key_tag_number ? <Text style={[styles.badge, styles.badgeWarning]}>🔑 {property.key_tag_number}</Text> : null}
              </View>
            </View>
            <Pressable onPress={openEditDetails}>
              <Text style={styles.link}>Edit property</Text>
            </Pressable>
          </View>

          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Access & Contacts</Text>
            <Pressable onPress={openEditContact}>
              <Text style={styles.link}>Edit</Text>
            </Pressable>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Landlord / Owner</Text>
            {property.owner_landlord_name ? <Text style={styles.cardName}>{property.owner_landlord_name}</Text> : null}
            {property.owner_landlord_phone ? (
              <Pressable onPress={() => Linking.openURL(`tel:${property.owner_landlord_phone}`)}>
                <Text style={styles.cardMeta}>{property.owner_landlord_phone}</Text>
              </Pressable>
            ) : null}
            {property.owner_landlord_email ? <Text style={styles.cardMeta}>{property.owner_landlord_email}</Text> : null}
            {!property.owner_landlord_name && !property.owner_landlord_phone && !property.owner_landlord_email ? (
              <Text style={styles.emptySmall}>Not on file</Text>
            ) : null}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Tenant Contact</Text>
            {property.tenant_name ? <Text style={styles.cardName}>{property.tenant_name}</Text> : null}
            {property.tenant_phone ? (
              <Pressable onPress={() => Linking.openURL(`tel:${property.tenant_phone}`)}>
                <Text style={styles.cardMeta}>{property.tenant_phone}</Text>
              </Pressable>
            ) : null}
            {property.tenant_email ? <Text style={styles.cardMeta}>{property.tenant_email}</Text> : null}
            {!property.tenant_phone && !property.tenant_email ? <Text style={styles.emptySmall}>Not on file</Text> : null}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Access Notes</Text>
            <Text style={styles.cardMeta}>{property.access_notes || "No access notes on file."}</Text>
          </View>
        </ScrollView>
      </SafeAreaView>

      <ThemedModal visible={contactModalVisible} onClose={() => setContactModalVisible(false)}>
        <Text style={styles.modalTitle}>Edit Access & Contacts</Text>
        <ThemedFormField label="Owner / landlord name" value={ownerName} onChangeText={setOwnerName} />
        <ThemedFormField label="Landlord mobile" value={ownerPhone} onChangeText={setOwnerPhone} keyboardType="phone-pad" />
        <ThemedFormField label="Landlord email" value={ownerEmail} onChangeText={setOwnerEmail} keyboardType="email-address" autoCapitalize="none" />
        <ThemedFormField label="Tenant name" value={tenantName} onChangeText={setTenantName} />
        <ThemedFormField label="Tenant mobile" value={tenantPhone} onChangeText={setTenantPhone} keyboardType="phone-pad" />
        <ThemedFormField label="Tenant email" value={tenantEmail} onChangeText={setTenantEmail} keyboardType="email-address" autoCapitalize="none" />
        <ThemedFormField label="Key tag number" placeholder="e.g. Key #42" value={keyTagNumber} onChangeText={setKeyTagNumber} />
        <ThemedFormField
          label="Access notes"
          placeholder="Gate codes, alarm codes, pet warnings, parking..."
          value={accessNotes}
          onChangeText={setAccessNotes}
          multiline
          style={styles.multiline}
        />
        {contactError ? <Text style={styles.error}>{contactError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setContactModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label="Save" onPress={handleSaveContact} />
        </View>
      </ThemedModal>

      <ThemedModal visible={detailsModalVisible} onClose={() => setDetailsModalVisible(false)}>
        <Text style={styles.modalTitle}>Edit Property Details</Text>
        <Text style={styles.fieldLabel}>Agency</Text>
        <Pressable style={styles.pickerField} onPress={() => setDetailsAgencyPickerVisible(true)}>
          <Text style={styles.pickerFieldText}>{(allAgencies ?? []).find((a) => a.id === detailsAgencyId)?.name ?? "Select agency"}</Text>
        </Pressable>
        <Text style={styles.fieldLabel}>Property manager</Text>
        <Pressable style={styles.pickerField} onPress={() => setDetailsPmPickerVisible(true)}>
          <Text style={detailsPmId ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
            {(() => {
              const pm = (allPropertyManagers ?? []).find((p) => p.id === detailsPmId);
              return pm ? `${pm.first_name} ${pm.last_name}` : "Unassigned";
            })()}
          </Text>
        </Pressable>
        <ThemedFormField label="Address line 1" value={detailsAddress} onChangeText={setDetailsAddress} />
        <ThemedFormField label="Suburb" value={detailsSuburb} onChangeText={setDetailsSuburb} />
        <View style={styles.addressRow}>
          <View style={styles.addressRowItemSmall}>
            <ThemedFormField label="State" value={detailsState} onChangeText={setDetailsState} autoCapitalize="characters" />
          </View>
          <View style={styles.addressRowItemSmall}>
            <ThemedFormField label="Postcode" value={detailsPostcode} onChangeText={setDetailsPostcode} keyboardType="number-pad" />
          </View>
        </View>
        <Text style={styles.fieldLabel}>Property type</Text>
        <Pressable style={styles.pickerField} onPress={() => setDetailsTypePickerVisible(true)}>
          <Text style={styles.pickerFieldText}>{PROPERTY_TYPE_OPTIONS.find((o) => o.value === detailsPropertyType)?.label}</Text>
        </Pressable>
        {detailsError ? <Text style={styles.error}>{detailsError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setDetailsModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label="Save" onPress={handleSaveDetails} />
        </View>
      </ThemedModal>
      <ThemedPickerModal
        visible={detailsAgencyPickerVisible}
        title="Select agency"
        items={allAgencies ?? []}
        getKey={(a) => a.id}
        getLabel={(a) => a.name}
        onSelect={(a) => {
          setDetailsAgencyId(a.id);
          setDetailsPmId(null);
        }}
        onClose={() => setDetailsAgencyPickerVisible(false)}
      />
      <ThemedPickerModal
        visible={detailsPmPickerVisible}
        title="Select property manager"
        items={(allPropertyManagers ?? []).filter((pm) => pm.agency_id === detailsAgencyId)}
        getKey={(pm) => pm.id}
        getLabel={(pm) => `${pm.first_name} ${pm.last_name}`}
        onSelect={(pm) => setDetailsPmId(pm.id)}
        onClose={() => setDetailsPmPickerVisible(false)}
      />
      <ThemedPickerModal
        visible={detailsTypePickerVisible}
        title="Select type"
        items={PROPERTY_TYPE_OPTIONS}
        getKey={(o) => o.value}
        getLabel={(o) => o.label}
        onSelect={(o) => setDetailsPropertyType(o.value)}
        onClose={() => setDetailsTypePickerVisible(false)}
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
    headerTitle: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 24, ...mono },
    emptySmall: { color: tokens.textMuted, fontSize: font.label, ...mono },
    headerRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 12, marginBottom: 16 },
    title: { fontSize: font.title - 1, fontWeight: "700" as const, color: tokens.accent, letterSpacing: 1, ...mono },
    subtitle: { color: tokens.textMuted, marginTop: 2, fontSize: font.body - 1, ...mono },
    badgeRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginTop: 8 },
    badge: { fontSize: font.label - 1, fontWeight: "700" as const, color: tokens.textMuted, borderWidth: 1, borderColor: tokens.border, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 3, ...mono },
    badgeAccent: { color: tokens.accent, borderColor: tokens.accent, backgroundColor: tokens.accentGlow },
    badgeWarning: { color: tokens.warning, borderColor: tokens.warning },
    sectionHeaderRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, marginBottom: 8 },
    sectionTitle: { fontSize: font.label, fontWeight: "700" as const, color: tokens.accent, textTransform: "uppercase" as const, letterSpacing: 1.5, ...mono },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    card: { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border, borderRadius: 4, padding: 14, marginBottom: 10, gap: 2 },
    cardTitle: { fontSize: font.label - 1, fontWeight: "700" as const, color: tokens.textMuted, textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 4, ...mono },
    cardName: { fontSize: font.body - 1, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    cardMeta: { fontSize: font.label, color: tokens.textMuted, ...mono },
    modalTitle: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      marginBottom: 4,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    fieldLabel: {
      fontSize: font.label,
      fontWeight: "700" as const,
      color: tokens.textMuted,
      marginBottom: 4,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      ...mono,
    },
    pickerField: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, marginBottom: 12, backgroundColor: tokens.background },
    pickerFieldText: { fontSize: font.body - 1, color: tokens.textPrimary, ...mono },
    pickerFieldPlaceholder: { fontSize: font.body - 1, color: tokens.textMuted, ...mono },
    addressRow: { flexDirection: "row" as const, gap: 8 },
    addressRowItemSmall: { flex: 1 },
    multiline: { minHeight: 70, textAlignVertical: "top" as const },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 20, marginTop: 8 },
    error: { color: tokens.danger, ...mono },
  };
}

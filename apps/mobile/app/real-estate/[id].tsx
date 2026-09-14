import { useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
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
import { RequiresConnectionNotice } from "../../components/RequiresConnectionNotice";
import { CenteredModal } from "../../components/CenteredModal";
import { PickerModal } from "../../components/PickerModal";
import { FormField } from "../../components/FormField";

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
  const isOnline = useIsOnline();

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

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Property" />
      </View>
    );
  }

  if (!property) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  return (
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
              <Text style={[styles.badge, styles.badgeBlue]}>
                PM: {propertyManager.first_name} {propertyManager.last_name}
              </Text>
            ) : null}
            {property.key_tag_number ? <Text style={[styles.badge, styles.badgeYellow]}>🔑 {property.key_tag_number}</Text> : null}
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

      <CenteredModal visible={contactModalVisible} onClose={() => setContactModalVisible(false)}>
        <Text style={styles.modalTitle}>Edit access & contacts</Text>
        <FormField label="Owner / landlord name" value={ownerName} onChangeText={setOwnerName} />
        <FormField label="Landlord mobile" value={ownerPhone} onChangeText={setOwnerPhone} keyboardType="phone-pad" />
        <FormField label="Landlord email" value={ownerEmail} onChangeText={setOwnerEmail} keyboardType="email-address" autoCapitalize="none" />
        <FormField label="Tenant name" value={tenantName} onChangeText={setTenantName} />
        <FormField label="Tenant mobile" value={tenantPhone} onChangeText={setTenantPhone} keyboardType="phone-pad" />
        <FormField label="Tenant email" value={tenantEmail} onChangeText={setTenantEmail} keyboardType="email-address" autoCapitalize="none" />
        <FormField label="Key tag number" placeholder="e.g. Key #42" value={keyTagNumber} onChangeText={setKeyTagNumber} />
        <FormField
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
          <Pressable style={styles.button} onPress={handleSaveContact}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <CenteredModal visible={detailsModalVisible} onClose={() => setDetailsModalVisible(false)}>
        <Text style={styles.modalTitle}>Edit property details</Text>
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
        <FormField label="Address line 1" value={detailsAddress} onChangeText={setDetailsAddress} />
        <FormField label="Suburb" value={detailsSuburb} onChangeText={setDetailsSuburb} />
        <View style={styles.addressRow}>
          <View style={styles.addressRowItemSmall}>
            <FormField label="State" value={detailsState} onChangeText={setDetailsState} autoCapitalize="characters" />
          </View>
          <View style={styles.addressRowItemSmall}>
            <FormField label="Postcode" value={detailsPostcode} onChangeText={setDetailsPostcode} keyboardType="number-pad" />
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
          <Pressable style={styles.button} onPress={handleSaveDetails}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>
      <PickerModal
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
      <PickerModal
        visible={detailsPmPickerVisible}
        title="Select property manager"
        items={(allPropertyManagers ?? []).filter((pm) => pm.agency_id === detailsAgencyId)}
        getKey={(pm) => pm.id}
        getLabel={(pm) => `${pm.first_name} ${pm.last_name}`}
        onSelect={(pm) => setDetailsPmId(pm.id)}
        onClose={() => setDetailsPmPickerVisible(false)}
      />
      <PickerModal
        visible={detailsTypePickerVisible}
        title="Select type"
        items={PROPERTY_TYPE_OPTIONS}
        getKey={(o) => o.value}
        getLabel={(o) => o.label}
        onSelect={(o) => setDetailsPropertyType(o.value)}
        onClose={() => setDetailsTypePickerVisible(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
  emptySmall: { color: "#9ca3af", fontSize: 13 },
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 16 },
  title: { fontSize: 20, fontWeight: "700", color: "#111827" },
  subtitle: { color: "#6b7280", marginTop: 2 },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  badge: { fontSize: 11, fontWeight: "700", color: "#374151", backgroundColor: "#f3f4f6", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  badgeBlue: { color: "#1e40af", backgroundColor: "#dbeafe" },
  badgeYellow: { color: "#854d0e", backgroundColor: "#fef9c3" },
  sectionHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "700", color: "#6b7280", textTransform: "uppercase" },
  link: { color: "#1d4ed8", fontWeight: "600" },
  card: { backgroundColor: "#f9fafb", borderRadius: 8, padding: 14, marginBottom: 10, gap: 2 },
  cardTitle: { fontSize: 11, fontWeight: "700", color: "#6b7280", textTransform: "uppercase", marginBottom: 4 },
  cardName: { fontSize: 15, fontWeight: "700", color: "#111827" },
  cardMeta: { fontSize: 13, color: "#374151" },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: "#374151", marginBottom: 4 },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, marginBottom: 12 },
  pickerFieldText: { fontSize: 15, color: "#111827" },
  pickerFieldPlaceholder: { fontSize: 15, color: "#9ca3af" },
  addressRow: { flexDirection: "row", gap: 8 },
  addressRowItemSmall: { flex: 1 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#dc2626" },
});

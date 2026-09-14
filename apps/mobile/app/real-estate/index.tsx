import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  createAgencySchema,
  createPropertyManagerSchema,
  createPropertySchema,
  type Agency,
  type AgencyType,
  type Property,
  type PropertyManager,
  type PropertyType,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useIsOnline } from "../../lib/connectivity";
import { useAuth } from "../../lib/auth-context";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../lib/errors";
import { RequiresConnectionNotice } from "../../components/RequiresConnectionNotice";
import { CenteredModal } from "../../components/CenteredModal";
import { PickerModal } from "../../components/PickerModal";
import { FormField } from "../../components/FormField";

// Mobile port of apps/desktop/src/pages/RealEstate.tsx's Directory tab -
// agencies/property managers/properties are Supabase-direct/office-side
// data (not PowerSync tables, same as quotes/invoices), so this uses the
// same useSupabaseFetch pattern those screens do. Key Management and
// Recurring Maintenance dashboards from the desktop version aren't
// ported here - the field-relevant slice of key tracking (pickup/in-van/
// return per job) already exists on jobs/[id].tsx; a tenant-wide
// dashboard view of it is an office/admin screen with much lower value
// in the field, left desktop-only for now.

const AGENCY_TYPE_OPTIONS: { value: AgencyType; label: string }[] = [
  { value: "real_estate", label: "Real Estate" },
  { value: "strata", label: "Strata" },
];
const PROPERTY_TYPE_OPTIONS: { value: PropertyType; label: string }[] = [
  { value: "residential", label: "Residential" },
  { value: "commercial", label: "Commercial" },
  { value: "strata_common_property", label: "Strata Common Property" },
  { value: "strata_lot", label: "Strata Lot" },
];

export default function RealEstateDirectoryScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();

  const { data: agencies, refetch: refetchAgencies } = useSupabaseFetch<Agency[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("agencies").select("*").order("name");
    if (error) throw error;
    return data as Agency[];
  }, [isOnline]);
  const { data: propertyManagers, refetch: refetchPms } = useSupabaseFetch<PropertyManager[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("property_managers").select("*").order("first_name");
    if (error) throw error;
    return data as PropertyManager[];
  }, [isOnline]);
  const { data: properties, refetch: refetchProperties } = useSupabaseFetch<Property[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("properties").select("*").order("suburb");
    if (error) throw error;
    return data as Property[];
  }, [isOnline]);

  useRefetchOnFocus(async () => {
    await Promise.all([refetchAgencies(), refetchPms(), refetchProperties()]);
  });

  const [expandedAgencyIds, setExpandedAgencyIds] = useState<Set<string>>(new Set());
  const toggleAgency = (id: string) => {
    setExpandedAgencyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pmsForAgency = (agencyId: string) => (propertyManagers ?? []).filter((pm) => pm.agency_id === agencyId);
  const propertiesForPm = (pmId: string) =>
    (properties ?? []).filter((p) => p.property_manager_id === pmId).sort((a, b) => a.suburb.localeCompare(b.suburb));

  // --- New agency ---
  const [agencyModalVisible, setAgencyModalVisible] = useState(false);
  const [agencyName, setAgencyName] = useState("");
  const [agencyType, setAgencyType] = useState<AgencyType>("real_estate");
  const [agencyRequireWorkOrder, setAgencyRequireWorkOrder] = useState(true);
  const [agencyError, setAgencyError] = useState<string | null>(null);
  const [agencyTypePickerVisible, setAgencyTypePickerVisible] = useState(false);

  const openNewAgency = () => {
    setAgencyName("");
    setAgencyType("real_estate");
    setAgencyRequireWorkOrder(true);
    setAgencyError(null);
    setAgencyModalVisible(true);
  };

  const handleSaveAgency = async () => {
    const result = createAgencySchema.safeParse({ name: agencyName, type: agencyType, require_work_order_num: agencyRequireWorkOrder });
    if (!result.success) {
      setAgencyError(result.error.issues[0]?.message ?? "Invalid agency");
      return;
    }
    if (!profile) return;
    const { error } = await supabase.from("agencies").insert({
      tenant_id: profile.tenant_id,
      name: result.data.name,
      type: result.data.type,
      require_work_order_num: result.data.require_work_order_num,
      payment_terms_days: result.data.payment_terms_days,
    });
    if (error) {
      setAgencyError(getErrorMessage(error, "Failed to save agency"));
      return;
    }
    setAgencyModalVisible(false);
    refetchAgencies();
  };

  // --- New property manager ---
  const [pmModalVisible, setPmModalVisible] = useState(false);
  const [pmAgencyId, setPmAgencyId] = useState<string | null>(null);
  const [pmAgencyPickerVisible, setPmAgencyPickerVisible] = useState(false);
  const [pmFirstName, setPmFirstName] = useState("");
  const [pmLastName, setPmLastName] = useState("");
  const [pmEmail, setPmEmail] = useState("");
  const [pmMobile, setPmMobile] = useState("");
  const [pmError, setPmError] = useState<string | null>(null);

  const openNewPm = (agencyId?: string) => {
    setPmAgencyId(agencyId ?? null);
    setPmFirstName("");
    setPmLastName("");
    setPmEmail("");
    setPmMobile("");
    setPmError(null);
    setPmModalVisible(true);
  };

  const handleSavePm = async () => {
    const result = createPropertyManagerSchema.safeParse({
      agency_id: pmAgencyId,
      first_name: pmFirstName,
      last_name: pmLastName,
      email: pmEmail,
      mobile: pmMobile,
    });
    if (!result.success) {
      setPmError(result.error.issues[0]?.message ?? "Invalid property manager");
      return;
    }
    if (!profile) return;
    const { error } = await supabase.from("property_managers").insert({
      tenant_id: profile.tenant_id,
      agency_id: result.data.agency_id,
      first_name: result.data.first_name,
      last_name: result.data.last_name,
      email: result.data.email || null,
      mobile: result.data.mobile || null,
    });
    if (error) {
      setPmError(getErrorMessage(error, "Failed to save property manager"));
      return;
    }
    setPmModalVisible(false);
    refetchPms();
  };

  // --- New property ---
  const [propertyModalVisible, setPropertyModalVisible] = useState(false);
  const [propAgencyId, setPropAgencyId] = useState<string | null>(null);
  const [propAgencyPickerVisible, setPropAgencyPickerVisible] = useState(false);
  const [propPmId, setPropPmId] = useState<string | null>(null);
  const [propPmPickerVisible, setPropPmPickerVisible] = useState(false);
  const [propAddress, setPropAddress] = useState("");
  const [propSuburb, setPropSuburb] = useState("");
  const [propState, setPropState] = useState("");
  const [propPostcode, setPropPostcode] = useState("");
  const [propType, setPropType] = useState<PropertyType>("residential");
  const [propTypePickerVisible, setPropTypePickerVisible] = useState(false);
  const [propError, setPropError] = useState<string | null>(null);

  const openNewProperty = (agencyId?: string, pmId?: string) => {
    setPropAgencyId(agencyId ?? null);
    setPropPmId(pmId ?? null);
    setPropAddress("");
    setPropSuburb("");
    setPropState("");
    setPropPostcode("");
    setPropType("residential");
    setPropError(null);
    setPropertyModalVisible(true);
  };

  const handleSaveProperty = async () => {
    const result = createPropertySchema.safeParse({
      agency_id: propAgencyId,
      property_manager_id: propPmId,
      address_line1: propAddress,
      suburb: propSuburb,
      state: propState,
      postcode: propPostcode,
      property_type: propType,
    });
    if (!result.success) {
      setPropError(result.error.issues[0]?.message ?? "Invalid property");
      return;
    }
    if (!profile) return;
    const { error } = await supabase.from("properties").insert({
      tenant_id: profile.tenant_id,
      agency_id: result.data.agency_id,
      property_manager_id: result.data.property_manager_id || null,
      address_line1: result.data.address_line1,
      suburb: result.data.suburb,
      state: result.data.state,
      postcode: result.data.postcode,
      property_type: result.data.property_type,
    });
    if (error) {
      setPropError(getErrorMessage(error, "Failed to save property"));
      return;
    }
    setPropertyModalVisible(false);
    refetchProperties();
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Real Estate & Strata" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <View style={styles.actionsRow}>
        <Pressable style={styles.actionButton} onPress={openNewAgency}>
          <Text style={styles.actionButtonText}>+ Agency</Text>
        </Pressable>
        <Pressable style={[styles.actionButton, styles.actionButtonSecondary]} onPress={() => openNewPm()}>
          <Text style={[styles.actionButtonText, styles.actionButtonSecondaryText]}>+ Property manager</Text>
        </Pressable>
        <Pressable style={[styles.actionButton, styles.actionButtonSecondary]} onPress={() => openNewProperty()}>
          <Text style={[styles.actionButtonText, styles.actionButtonSecondaryText]}>+ Property</Text>
        </Pressable>
      </View>

      {(agencies ?? []).length === 0 ? (
        <Text style={styles.empty}>No agencies yet.</Text>
      ) : (
        (agencies ?? []).map((agency) => {
          const expanded = expandedAgencyIds.has(agency.id);
          const pms = pmsForAgency(agency.id);
          return (
            <View key={agency.id} style={styles.agencyCard}>
              <Pressable style={styles.agencyHeader} onPress={() => toggleAgency(agency.id)}>
                <Text style={styles.agencyChevron}>{expanded ? "▾" : "▸"}</Text>
                <Text style={styles.agencyName}>{agency.name}</Text>
                <Text style={styles.agencyTypeBadge}>{agency.type === "strata" ? "Strata" : "Real Estate"}</Text>
              </Pressable>
              {expanded ? (
                <View style={styles.agencyBody}>
                  {pms.length === 0 ? (
                    <Text style={styles.emptySmall}>No property managers yet for this agency.</Text>
                  ) : (
                    pms.map((pm) => (
                      <View key={pm.id} style={styles.pmBlock}>
                        <Text style={styles.pmName}>
                          {pm.first_name} {pm.last_name}
                        </Text>
                        {propertiesForPm(pm.id).length === 0 ? (
                          <Text style={styles.emptySmall}>No managed properties yet.</Text>
                        ) : (
                          propertiesForPm(pm.id).map((property) => (
                            <Pressable
                              key={property.id}
                              style={styles.propertyRow}
                              onPress={() => router.push(`/real-estate/${property.id}`)}
                            >
                              <Text style={styles.propertyRowText} numberOfLines={1}>
                                {property.address_line1}
                              </Text>
                              <Text style={styles.propertyRowMeta}>{property.suburb}</Text>
                            </Pressable>
                          ))
                        )}
                        <Pressable onPress={() => openNewProperty(agency.id, pm.id)}>
                          <Text style={styles.link}>+ Add property for this PM</Text>
                        </Pressable>
                      </View>
                    ))
                  )}
                  <Pressable onPress={() => openNewPm(agency.id)}>
                    <Text style={styles.link}>+ Add property manager to {agency.name}</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          );
        })
      )}

      <CenteredModal visible={agencyModalVisible} onClose={() => setAgencyModalVisible(false)}>
        <Text style={styles.modalTitle}>New agency</Text>
        <FormField label="Name" placeholder="e.g. McGrath Estate Agents" value={agencyName} onChangeText={setAgencyName} />
        <Text style={styles.fieldLabel}>Type</Text>
        <Pressable style={styles.pickerField} onPress={() => setAgencyTypePickerVisible(true)}>
          <Text style={styles.pickerFieldText}>{AGENCY_TYPE_OPTIONS.find((o) => o.value === agencyType)?.label}</Text>
        </Pressable>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Require a work order number on every invoice</Text>
          <Pressable
            style={[styles.checkbox, agencyRequireWorkOrder && styles.checkboxChecked]}
            onPress={() => setAgencyRequireWorkOrder((v) => !v)}
          >
            {agencyRequireWorkOrder ? <Text style={styles.checkboxTick}>✓</Text> : null}
          </Pressable>
        </View>
        {agencyError ? <Text style={styles.error}>{agencyError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setAgencyModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleSaveAgency}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>
      <PickerModal
        visible={agencyTypePickerVisible}
        title="Select type"
        items={AGENCY_TYPE_OPTIONS}
        getKey={(o) => o.value}
        getLabel={(o) => o.label}
        onSelect={(o) => setAgencyType(o.value)}
        onClose={() => setAgencyTypePickerVisible(false)}
      />

      <CenteredModal visible={pmModalVisible} onClose={() => setPmModalVisible(false)}>
        <Text style={styles.modalTitle}>New property manager</Text>
        <Text style={styles.fieldLabel}>Agency</Text>
        <Pressable style={styles.pickerField} onPress={() => setPmAgencyPickerVisible(true)}>
          <Text style={pmAgencyId ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
            {(agencies ?? []).find((a) => a.id === pmAgencyId)?.name ?? "Select agency"}
          </Text>
        </Pressable>
        <FormField label="First name" value={pmFirstName} onChangeText={setPmFirstName} />
        <FormField label="Last name" value={pmLastName} onChangeText={setPmLastName} />
        <FormField label="Email" value={pmEmail} onChangeText={setPmEmail} keyboardType="email-address" autoCapitalize="none" />
        <FormField label="Mobile" value={pmMobile} onChangeText={setPmMobile} keyboardType="phone-pad" />
        {pmError ? <Text style={styles.error}>{pmError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setPmModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleSavePm}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>
      <PickerModal
        visible={pmAgencyPickerVisible}
        title="Select agency"
        items={agencies ?? []}
        getKey={(a) => a.id}
        getLabel={(a) => a.name}
        onSelect={(a) => setPmAgencyId(a.id)}
        onClose={() => setPmAgencyPickerVisible(false)}
      />

      <CenteredModal visible={propertyModalVisible} onClose={() => setPropertyModalVisible(false)}>
        <Text style={styles.modalTitle}>New managed property</Text>
        <Text style={styles.fieldLabel}>Agency</Text>
        <Pressable
          style={styles.pickerField}
          onPress={() => setPropAgencyPickerVisible(true)}
        >
          <Text style={propAgencyId ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
            {(agencies ?? []).find((a) => a.id === propAgencyId)?.name ?? "Select agency"}
          </Text>
        </Pressable>
        <Text style={styles.fieldLabel}>Property manager</Text>
        <Pressable style={styles.pickerField} onPress={() => propAgencyId && setPropPmPickerVisible(true)} disabled={!propAgencyId}>
          <Text style={propPmId ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
            {(() => {
              const pm = (propertyManagers ?? []).find((p) => p.id === propPmId);
              return pm ? `${pm.first_name} ${pm.last_name}` : propAgencyId ? "Select property manager" : "Pick an agency first";
            })()}
          </Text>
        </Pressable>
        <FormField label="Address line 1" value={propAddress} onChangeText={setPropAddress} />
        <FormField label="Suburb" value={propSuburb} onChangeText={setPropSuburb} />
        <View style={styles.addressRow}>
          <View style={styles.addressRowItemSmall}>
            <FormField label="State" placeholder="e.g. NSW" value={propState} onChangeText={setPropState} autoCapitalize="characters" />
          </View>
          <View style={styles.addressRowItemSmall}>
            <FormField label="Postcode" placeholder="e.g. 2000" value={propPostcode} onChangeText={setPropPostcode} keyboardType="number-pad" />
          </View>
        </View>
        <Text style={styles.fieldLabel}>Property type</Text>
        <Pressable style={styles.pickerField} onPress={() => setPropTypePickerVisible(true)}>
          <Text style={styles.pickerFieldText}>{PROPERTY_TYPE_OPTIONS.find((o) => o.value === propType)?.label}</Text>
        </Pressable>
        {propError ? <Text style={styles.error}>{propError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setPropertyModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleSaveProperty}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>
      <PickerModal
        visible={propAgencyPickerVisible}
        title="Select agency"
        items={agencies ?? []}
        getKey={(a) => a.id}
        getLabel={(a) => a.name}
        onSelect={(a) => {
          setPropAgencyId(a.id);
          setPropPmId(null);
        }}
        onClose={() => setPropAgencyPickerVisible(false)}
      />
      <PickerModal
        visible={propPmPickerVisible}
        title="Select property manager"
        items={(propertyManagers ?? []).filter((pm) => pm.agency_id === propAgencyId)}
        getKey={(pm) => pm.id}
        getLabel={(pm) => `${pm.first_name} ${pm.last_name}`}
        onSelect={(pm) => setPropPmId(pm.id)}
        onClose={() => setPropPmPickerVisible(false)}
      />
      <PickerModal
        visible={propTypePickerVisible}
        title="Select type"
        items={PROPERTY_TYPE_OPTIONS}
        getKey={(o) => o.value}
        getLabel={(o) => o.label}
        onSelect={(o) => setPropType(o.value)}
        onClose={() => setPropTypePickerVisible(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  actionsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  actionButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  actionButtonSecondary: { backgroundColor: "#f3f4f6" },
  actionButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  actionButtonSecondaryText: { color: "#1d4ed8" },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
  emptySmall: { color: "#9ca3af", fontSize: 13, paddingVertical: 4 },
  agencyCard: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, marginBottom: 10, overflow: "hidden" },
  agencyHeader: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14 },
  agencyChevron: { color: "#9ca3af" },
  agencyName: { flex: 1, fontSize: 16, fontWeight: "700", color: "#111827" },
  agencyTypeBadge: { fontSize: 11, fontWeight: "700", color: "#6b7280", backgroundColor: "#f3f4f6", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  agencyBody: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#d1d5db", padding: 14, gap: 6 },
  pmBlock: { marginBottom: 10, gap: 2 },
  pmName: { fontSize: 14, fontWeight: "700", color: "#111827" },
  propertyRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, paddingLeft: 8, gap: 8 },
  // flex: 1 so the (potentially long, free-text) address is what shrinks
  // and truncates when space is tight, not the suburb - suburb is short
  // and important to always see in full at a glance, so it stays
  // unconstrained and never gets clipped.
  propertyRowText: { flex: 1, color: "#1d4ed8", fontSize: 13 },
  propertyRowMeta: { flexShrink: 0, color: "#6b7280", fontSize: 13 },
  link: { color: "#1d4ed8", fontWeight: "600", fontSize: 13, marginTop: 4 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: "#374151", marginBottom: 4 },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, marginBottom: 12 },
  pickerFieldText: { fontSize: 15, color: "#111827" },
  pickerFieldPlaceholder: { fontSize: 15, color: "#9ca3af" },
  addressRow: { flexDirection: "row", gap: 8 },
  addressRowItemSmall: { flex: 1 },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4, marginBottom: 8, gap: 12 },
  switchLabel: { fontSize: 14, fontWeight: "600", color: "#374151", flex: 1 },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: "#ccc", alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: "#1d4ed8", borderColor: "#1d4ed8" },
  checkboxTick: { color: "#fff", fontWeight: "700" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#dc2626" },
});

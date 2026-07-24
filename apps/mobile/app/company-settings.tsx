import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { updateCompanySettingsSchema, type Tenant } from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { useIsOnline } from "../lib/connectivity";
import { useSupabaseFetch } from "../lib/use-supabase-fetch";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { RequiresConnectionNotice } from "../components/RequiresConnectionNotice";
import { FormField } from "../components/FormField";

// Minimal, single-screen settings - just the fields the Phase 5 PDF export
// needs (company name, ABN, business address, license number, bank
// details). A real Settings tab/section is deliberately not built yet
// (see docs/SETUP.md known-gaps) - this screen is reached via a small
// admin-only link on Home rather than its own tab.
export default function CompanySettingsScreen() {
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";

  const { data: tenant, refetch } = useSupabaseFetch<Tenant>(async () => {
    const { data, error } = await supabase.from("tenants").select("*").eq("id", profile?.tenant_id).single();
    if (error) throw error;
    return data as Tenant;
  }, [profile?.tenant_id, isOnline]);

  const [name, setName] = useState("");
  const [abn, setAbn] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [suburb, setSuburb] = useState("");
  const [state, setState] = useState("");
  const [postcode, setPostcode] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [bankAccountName, setBankAccountName] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [bankBsb, setBankBsb] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (tenant) {
      setName(tenant.name);
      setAbn(tenant.abn ?? "");
      setAddressLine1(tenant.business_address_line1 ?? "");
      setAddressLine2(tenant.business_address_line2 ?? "");
      setSuburb(tenant.business_suburb ?? "");
      setState(tenant.business_state ?? "");
      setPostcode(tenant.business_postcode ?? "");
      setLicenseNumber(tenant.license_number ?? "");
      setBankAccountName(tenant.bank_account_name ?? "");
      setBankAccountNumber(tenant.bank_account_number ?? "");
      setBankBsb(tenant.bank_bsb ?? "");
    }
  }, [tenant]);

  const handleSave = async () => {
    const result = updateCompanySettingsSchema.safeParse({
      name,
      abn,
      business_address_line1: addressLine1,
      business_address_line2: addressLine2,
      business_suburb: suburb,
      business_state: state,
      business_postcode: postcode,
      license_number: licenseNumber,
      bank_account_name: bankAccountName,
      bank_account_number: bankAccountNumber,
      bank_bsb: bankBsb,
    });
    if (!result.success) {
      setSaveError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const { error } = await supabase
        .from("tenants")
        .update({
          name: result.data.name,
          abn: result.data.abn || null,
          business_address_line1: result.data.business_address_line1 || null,
          business_address_line2: result.data.business_address_line2 || null,
          business_suburb: result.data.business_suburb || null,
          business_state: result.data.business_state || null,
          business_postcode: result.data.business_postcode || null,
          license_number: result.data.license_number || null,
          bank_account_name: result.data.bank_account_name || null,
          bank_account_number: result.data.bank_account_number || null,
          bank_bsb: result.data.bank_bsb || null,
        })
        .eq("id", profile?.tenant_id);
      if (error) throw error;
      refetch();
    } catch (e) {
      console.error("[CompanySettings] Failed to save", e);
      setSaveError(getErrorMessage(e, "Failed to save (see console for details)"));
    } finally {
      setSaving(false);
    }
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Company settings" />
      </View>
    );
  }

  if (!isAdmin) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Only admins can view company settings.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Text style={styles.subtitle}>Used on exported quote/invoice PDFs.</Text>

      <FormField label="Company name" value={name} onChangeText={setName} />
      <View style={styles.fieldSpacing}>
        <FormField label="ABN" placeholder="e.g. 12 345 678 901" value={abn} onChangeText={setAbn} />
      </View>

      <Text style={styles.sectionTitle}>Business address</Text>
      <FormField label="Address line 1" value={addressLine1} onChangeText={setAddressLine1} />
      <View style={styles.fieldSpacing}>
        <FormField label="Address line 2 (optional)" value={addressLine2} onChangeText={setAddressLine2} />
      </View>
      <View style={styles.addressRow}>
        <View style={styles.addressRowItem}>
          <FormField label="Suburb" value={suburb} onChangeText={setSuburb} />
        </View>
        <View style={styles.addressRowItemSmall}>
          <FormField label="State" value={state} onChangeText={setState} autoCapitalize="characters" />
        </View>
        <View style={styles.addressRowItemSmall}>
          <FormField label="Postcode" value={postcode} onChangeText={setPostcode} keyboardType="number-pad" />
        </View>
      </View>

      <View style={styles.fieldSpacing}>
        <FormField label="License number" value={licenseNumber} onChangeText={setLicenseNumber} />
      </View>

      <Text style={styles.sectionTitle}>Bank details</Text>
      <FormField label="Account name" value={bankAccountName} onChangeText={setBankAccountName} />
      <View style={styles.fieldSpacing}>
        <FormField label="Account number" value={bankAccountNumber} onChangeText={setBankAccountNumber} keyboardType="number-pad" />
      </View>
      <View style={styles.fieldSpacing}>
        <FormField label="BSB" value={bankBsb} onChangeText={setBankBsb} keyboardType="number-pad" />
      </View>

      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}

      <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
        <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save changes"}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  subtitle: { color: "#6b7280", marginTop: 2, marginBottom: 16 },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginTop: 24, marginBottom: 6 },
  fieldSpacing: { marginTop: 16 },
  addressRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  addressRowItem: { flex: 2 },
  addressRowItemSmall: { flex: 1 },
  error: { color: "#dc2626", marginTop: 12 },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 24 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
});

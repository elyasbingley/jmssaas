import { useEffect, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { updateCompanySettingsSchema, type Tenant } from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { useIsOnline } from "../lib/connectivity";
import { useSupabaseFetch } from "../lib/use-supabase-fetch";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { RequiresConnectionNotice } from "../components/RequiresConnectionNotice";
import { FormField } from "../components/FormField";

const LOGO_BUCKET = "company-logos";

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
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
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
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  useEffect(() => {
    if (tenant) {
      setName(tenant.name);
      setAbn(tenant.abn ?? "");
      setEmail(tenant.email ?? "");
      setWebsite(tenant.website ?? "");
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

  // Logo upload is a separate, immediate write (not part of the Save
  // changes form below) - same pattern as job/task photo attachments:
  // pick, upload, persist the resulting URL straight away. Each upload uses
  // a fresh filename rather than upserting a fixed one so the new public
  // URL can't be served stale from a CDN/image cache under the old one.
  const pickLogo = async () => {
    if (!profile) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Enable photo access in Settings to choose a logo.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      base64: true,
      quality: 0.9,
      allowsEditing: true,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset?.base64) return;

    setUploadingLogo(true);
    setLogoError(null);
    try {
      const extension = asset.mimeType?.includes("png") ? "png" : "jpg";
      const path = `${profile.tenant_id}/logo-${Date.now()}.${extension}`;
      const { error: uploadError } = await supabase.storage
        .from(LOGO_BUCKET)
        .upload(path, decodeBase64(asset.base64), {
          contentType: asset.mimeType ?? "image/jpeg",
          upsert: true,
        });
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(path);
      const { error: updateError } = await supabase
        .from("tenants")
        .update({ logo_url: publicUrlData.publicUrl })
        .eq("id", profile.tenant_id);
      if (updateError) throw updateError;

      refetch();
    } catch (e) {
      console.error("[CompanySettings] Failed to upload logo", e);
      setLogoError(getErrorMessage(e, "Failed to upload logo (see console for details)"));
    } finally {
      setUploadingLogo(false);
    }
  };

  const removeLogo = async () => {
    if (!profile) return;
    setLogoError(null);
    try {
      const { error } = await supabase.from("tenants").update({ logo_url: null }).eq("id", profile.tenant_id);
      if (error) throw error;
      refetch();
    } catch (e) {
      setLogoError(getErrorMessage(e, "Failed to remove logo"));
    }
  };

  const handleSave = async () => {
    const result = updateCompanySettingsSchema.safeParse({
      name,
      abn,
      email,
      website,
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
          email: result.data.email || null,
          website: result.data.website || null,
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

      <Text style={styles.sectionTitle}>Logo</Text>
      {tenant?.logo_url ? (
        <Image source={{ uri: tenant.logo_url }} style={styles.logoPreview} resizeMode="contain" />
      ) : (
        <View style={styles.logoPlaceholder}>
          <Text style={styles.logoPlaceholderText}>No logo uploaded</Text>
        </View>
      )}
      <View style={styles.logoActions}>
        <Pressable style={styles.logoButton} onPress={pickLogo} disabled={uploadingLogo}>
          <Text style={styles.logoButtonText}>{uploadingLogo ? "Uploading..." : tenant?.logo_url ? "Change logo" : "Upload logo"}</Text>
        </Pressable>
        {tenant?.logo_url ? (
          <Pressable onPress={removeLogo} disabled={uploadingLogo}>
            <Text style={styles.link}>Remove</Text>
          </Pressable>
        ) : null}
      </View>
      {logoError ? <Text style={styles.error}>{logoError}</Text> : null}

      <View style={styles.fieldSpacing}>
        <FormField label="Company name" value={name} onChangeText={setName} />
      </View>
      <View style={styles.fieldSpacing}>
        <FormField label="ABN" placeholder="e.g. 12 345 678 901" value={abn} onChangeText={setAbn} />
      </View>
      <View style={styles.fieldSpacing}>
        <FormField label="Email" placeholder="info@yourcompany.com.au" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
      </View>
      <View style={styles.fieldSpacing}>
        <FormField label="Website" placeholder="yourcompany.com.au" value={website} onChangeText={setWebsite} autoCapitalize="none" />
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
  logoPreview: { width: "100%", height: 100, backgroundColor: "#f9fafb", borderRadius: 8 },
  logoPlaceholder: { width: "100%", height: 100, backgroundColor: "#f3f4f6", borderRadius: 8, alignItems: "center", justifyContent: "center" },
  logoPlaceholderText: { color: "#9ca3af" },
  logoActions: { flexDirection: "row", alignItems: "center", gap: 20, marginTop: 10 },
  logoButton: { backgroundColor: "#f3f4f6", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  logoButtonText: { color: "#1d4ed8", fontWeight: "600" },
  link: { color: "#dc2626", fontWeight: "600" },
});

import { useEffect, useState } from "react";
import { Alert, Image, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { updateCompanySettingsSchema, updateSmsPhoneNumberSchema, updateWhatsappPhoneNumberSchema, type Tenant } from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { useIsOnline } from "../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../lib/use-supabase-fetch";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../components/theme/ThemedRequiresConnectionNotice";
import { ThemedFormField } from "../components/theme/ThemedFormField";
import { ThemedButton } from "../components/theme/ThemedButton";

const LOGO_BUCKET = "company-logos";

interface XeroStatus {
  connected: boolean;
  org_name?: string;
  connected_at?: string;
}

interface FacebookStatus {
  connected: boolean;
  page_name?: string;
  connected_at?: string;
}

// Minimal, single-screen settings - just the fields the Phase 5 PDF export
// needs (company name, ABN, business address, license number, bank
// details), plus channel connections (SMS/WhatsApp/Messenger/Instagram),
// Xero and the Inbox address. Reached via Settings > Company Details.
export default function CompanySettingsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  const { data: tenant, refetch } = useSupabaseFetch<Tenant>(async () => {
    const { data, error } = await supabase.from("tenants").select("*").eq("id", profile?.tenant_id).single();
    if (error) throw error;
    return data as Tenant;
  }, [profile?.tenant_id, isOnline]);

  // Xero connection status - RPC rather than a synced table (xero_
  // connections has zero PowerSync grants by design, service-role only).
  // Connecting opens the OAuth flow in the device browser (Linking,
  // there's no in-app webview flow here) - the callback always redirects
  // to the desktop app's own Settings page (server-side configured, not
  // platform-aware - see xero-oauth-callback), so a mobile-initiated
  // connect finishes visibly in the phone's browser on the web app, not
  // back in this native screen. Since it's one Xero connection per
  // tenant either way, refetching on focus (returning to this screen
  // after finishing in the browser) is enough to pick up the result here
  // too, without needing a custom URL scheme/deep link back into the app.
  const { data: xeroStatus, refetch: refetchXeroStatus } = useSupabaseFetch<XeroStatus>(async () => {
    const { data, error } = await supabase.rpc("get_xero_connection_status");
    if (error) throw error;
    return data as XeroStatus;
  }, [profile?.tenant_id, isOnline]);
  useRefetchOnFocus(refetchXeroStatus);
  const [xeroConnecting, setXeroConnecting] = useState(false);
  const [xeroDisconnecting, setXeroDisconnecting] = useState(false);
  const [xeroConnectError, setXeroConnectError] = useState<string | null>(null);
  const [xeroSalesAccountCode, setXeroSalesAccountCode] = useState("");

  const [name, setName] = useState("");
  const [abn, setAbn] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
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
  const [smsPhoneNumberInput, setSmsPhoneNumberInput] = useState("");
  const [savingSms, setSavingSms] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [smsSaved, setSmsSaved] = useState(false);
  const [whatsappPhoneNumberInput, setWhatsappPhoneNumberInput] = useState("");
  const [savingWhatsapp, setSavingWhatsapp] = useState(false);
  const [whatsappError, setWhatsappError] = useState<string | null>(null);
  const [whatsappSaved, setWhatsappSaved] = useState(false);

  useEffect(() => {
    if (tenant) {
      setName(tenant.name);
      setSmsPhoneNumberInput(tenant.sms_phone_number ?? "");
      setWhatsappPhoneNumberInput(tenant.whatsapp_phone_number ?? "");
      setAbn(tenant.abn ?? "");
      setEmail(tenant.email ?? "");
      setPhone(tenant.phone ?? "");
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
      setXeroSalesAccountCode(tenant.xero_sales_account_code ?? "200");
    }
  }, [tenant]);

  const connectXero = async () => {
    setXeroConnecting(true);
    setXeroConnectError(null);
    try {
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!supabaseUrl || !token) throw new Error("Not signed in");
      const res = await fetch(`${supabaseUrl}/functions/v1/xero-oauth-start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const resBody = await res.json();
      if (!res.ok || resBody.error || !resBody.url) throw new Error(resBody.error || "Failed to start Xero connection");
      await Linking.openURL(resBody.url as string);
    } catch (e) {
      setXeroConnectError(getErrorMessage(e, "Failed to start Xero connection"));
    } finally {
      setXeroConnecting(false);
    }
  };

  const disconnectXero = async () => {
    setXeroDisconnecting(true);
    setXeroConnectError(null);
    try {
      const { error } = await supabase.rpc("disconnect_xero");
      if (error) throw error;
      refetchXeroStatus();
    } catch (e) {
      setXeroConnectError(getErrorMessage(e, "Failed to disconnect"));
    } finally {
      setXeroDisconnecting(false);
    }
  };

  // Facebook Messenger connection status - same "RPC + refetch on focus"
  // shape as Xero's above (facebook_connections is service-role only, no
  // PowerSync grants), and connecting opens the OAuth flow in the device
  // browser the same way.
  const { data: facebookStatus, refetch: refetchFacebookStatus } = useSupabaseFetch<FacebookStatus>(async () => {
    const { data, error } = await supabase.rpc("get_facebook_connection_status");
    if (error) throw error;
    return data as FacebookStatus;
  }, [profile?.tenant_id, isOnline]);
  useRefetchOnFocus(refetchFacebookStatus);
  const [facebookConnecting, setFacebookConnecting] = useState(false);
  const [facebookDisconnecting, setFacebookDisconnecting] = useState(false);
  const [facebookConnectError, setFacebookConnectError] = useState<string | null>(null);

  const connectFacebook = async () => {
    setFacebookConnecting(true);
    setFacebookConnectError(null);
    try {
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!supabaseUrl || !token) throw new Error("Not signed in");
      const res = await fetch(`${supabaseUrl}/functions/v1/facebook-oauth-start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const resBody = await res.json();
      if (!res.ok || resBody.error || !resBody.url) throw new Error(resBody.error || "Failed to start Facebook connection");
      await Linking.openURL(resBody.url as string);
    } catch (e) {
      setFacebookConnectError(getErrorMessage(e, "Failed to start Facebook connection"));
    } finally {
      setFacebookConnecting(false);
    }
  };

  const disconnectFacebook = async () => {
    setFacebookDisconnecting(true);
    setFacebookConnectError(null);
    try {
      const { error } = await supabase.rpc("disconnect_facebook");
      if (error) throw error;
      refetchFacebookStatus();
    } catch (e) {
      setFacebookConnectError(getErrorMessage(e, "Failed to disconnect"));
    } finally {
      setFacebookDisconnecting(false);
    }
  };

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

  const saveSmsPhoneNumber = async () => {
    if (!profile) return;
    setSavingSms(true);
    setSmsError(null);
    try {
      const result = updateSmsPhoneNumberSchema.safeParse({ sms_phone_number: smsPhoneNumberInput });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid phone number");
      const { error } = await supabase.from("tenants").update({ sms_phone_number: result.data.sms_phone_number }).eq("id", profile.tenant_id);
      if (error) throw error;
      refetch();
      setSmsSaved(true);
      setTimeout(() => setSmsSaved(false), 3000);
    } catch (e) {
      setSmsError(getErrorMessage(e, "Failed to save phone number"));
    } finally {
      setSavingSms(false);
    }
  };

  const saveWhatsappPhoneNumber = async () => {
    if (!profile) return;
    setSavingWhatsapp(true);
    setWhatsappError(null);
    try {
      const result = updateWhatsappPhoneNumberSchema.safeParse({ whatsapp_phone_number: whatsappPhoneNumberInput });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid phone number");
      const { error } = await supabase.from("tenants").update({ whatsapp_phone_number: result.data.whatsapp_phone_number }).eq("id", profile.tenant_id);
      if (error) throw error;
      refetch();
      setWhatsappSaved(true);
      setTimeout(() => setWhatsappSaved(false), 3000);
    } catch (e) {
      setWhatsappError(getErrorMessage(e, "Failed to save phone number"));
    } finally {
      setSavingWhatsapp(false);
    }
  };

  const handleSave = async () => {
    const result = updateCompanySettingsSchema.safeParse({
      name,
      abn,
      email,
      phone,
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
      xero_sales_account_code: xeroSalesAccountCode,
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
          phone: result.data.phone || null,
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
          xero_sales_account_code: result.data.xero_sales_account_code || "200",
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

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Company Details</Text>
        </View>

        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Company settings" />
        ) : !isAdmin ? (
          <Text style={styles.empty}>Only admins can view company settings.</Text>
        ) : (
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
                  <Text style={styles.deleteLink}>Remove</Text>
                </Pressable>
              ) : null}
            </View>
            {logoError ? <Text style={styles.error}>{logoError}</Text> : null}

            <Text style={styles.sectionTitle}>Inbox</Text>
            {tenant?.inbox_local_part && process.env.EXPO_PUBLIC_INBOX_DOMAIN ? (
              <View style={styles.inboxCard}>
                <Text style={styles.inboxCardHint}>
                  Forward quote requests and job files to this address - see the Inbox screen to attach them to a job or
                  review an AI-drafted job.
                </Text>
                <Text style={styles.inboxAddress} selectable>
                  {tenant.inbox_local_part}@{process.env.EXPO_PUBLIC_INBOX_DOMAIN}
                </Text>
              </View>
            ) : (
              <Text style={styles.logoPlaceholderText}>
                Not configured yet - set EXPO_PUBLIC_INBOX_DOMAIN to your verified Resend inbound domain (see
                docs/SETUP.md's Inbox section).
              </Text>
            )}

            <Text style={styles.sectionTitle}>Channels</Text>
            <View style={styles.inboxCard}>
              <View style={styles.channelHeaderRow}>
                <Text style={styles.channelLabel}>💬 SMS</Text>
                <View style={[styles.channelBadge, tenant?.sms_phone_number ? styles.channelBadgeConnected : styles.channelBadgeNotConnected]}>
                  <Text style={tenant?.sms_phone_number ? styles.channelBadgeTextConnected : styles.channelBadgeTextNotConnected}>
                    {tenant?.sms_phone_number ? "Connected" : "Not connected"}
                  </Text>
                </View>
              </View>
              <Text style={styles.inboxCardHint}>
                The phone number you bought/ported in the platform's Twilio account (see docs/SETUP.md's Channels
                section) - E.164 or local format both work, e.g. 0491 570 156.
              </Text>
              <ThemedFormField label="Phone number" placeholder="0491 570 156" value={smsPhoneNumberInput} onChangeText={setSmsPhoneNumberInput} keyboardType="phone-pad" />
              <Pressable style={styles.logoButton} onPress={saveSmsPhoneNumber} disabled={savingSms}>
                <Text style={styles.logoButtonText}>{savingSms ? "Saving..." : smsSaved ? "Saved!" : "Save"}</Text>
              </Pressable>
              {smsError ? <Text style={styles.error}>{smsError}</Text> : null}
            </View>

            <View style={styles.inboxCard}>
              <View style={styles.channelHeaderRow}>
                <Text style={styles.channelLabel}>🟢 WhatsApp</Text>
                <View style={[styles.channelBadge, tenant?.whatsapp_phone_number ? styles.channelBadgeConnected : styles.channelBadgeNotConnected]}>
                  <Text style={tenant?.whatsapp_phone_number ? styles.channelBadgeTextConnected : styles.channelBadgeTextNotConnected}>
                    {tenant?.whatsapp_phone_number ? "Connected" : "Not connected"}
                  </Text>
                </View>
              </View>
              <Text style={styles.inboxCardHint}>
                A Twilio Sandbox number works for testing right now with no Meta approval needed - a permanent number for
                messaging real clients first needs Meta Business verification and an approved template. See
                docs/SETUP.md's Channels section.
              </Text>
              <ThemedFormField label="Phone number" placeholder="0491 570 156" value={whatsappPhoneNumberInput} onChangeText={setWhatsappPhoneNumberInput} keyboardType="phone-pad" />
              <Pressable style={styles.logoButton} onPress={saveWhatsappPhoneNumber} disabled={savingWhatsapp}>
                <Text style={styles.logoButtonText}>{savingWhatsapp ? "Saving..." : whatsappSaved ? "Saved!" : "Save"}</Text>
              </Pressable>
              {whatsappError ? <Text style={styles.error}>{whatsappError}</Text> : null}
            </View>

            <View style={styles.inboxCard}>
              <View style={styles.channelHeaderRow}>
                <Text style={styles.channelLabel}>🔵 Messenger</Text>
                <View style={[styles.channelBadge, facebookStatus?.connected ? styles.channelBadgeConnected : styles.channelBadgeNotConnected]}>
                  <Text style={facebookStatus?.connected ? styles.channelBadgeTextConnected : styles.channelBadgeTextNotConnected}>
                    {facebookStatus?.connected ? "Connected" : "Not connected"}
                  </Text>
                </View>
              </View>
              {facebookStatus?.connected ? (
                <>
                  <Text style={styles.meta}>
                    Connected to {facebookStatus.page_name || "your Facebook Page"}
                    {facebookStatus.connected_at ? ` since ${new Date(facebookStatus.connected_at).toLocaleDateString("en-AU")}` : ""}.
                  </Text>
                  <Pressable onPress={disconnectFacebook} disabled={facebookDisconnecting} style={{ marginTop: 8 }}>
                    <Text style={styles.deleteLink}>{facebookDisconnecting ? "Disconnecting..." : "Disconnect Messenger"}</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={styles.inboxCardHint}>
                    Connect your Facebook Page to send and receive Messenger conversations here - works right away for a
                    Page you personally admin, wider client Pages need Meta App Review first. See docs/SETUP.md's Channels
                    section.
                  </Text>
                  <View style={styles.connectButtonWrap}>
                    <ThemedButton label={facebookConnecting ? "Opening Facebook..." : "Connect to Facebook"} onPress={connectFacebook} disabled={facebookConnecting} />
                  </View>
                </>
              )}
              {facebookConnectError ? <Text style={styles.error}>{facebookConnectError}</Text> : null}
            </View>

            {[
              { icon: "📷", label: "Instagram", note: "Needs Meta App Review before this app can message through your Instagram account - see docs/SETUP.md." },
            ].map((channel) => (
              <View key={channel.label} style={styles.inboxCard}>
                <View style={styles.channelHeaderRow}>
                  <Text style={styles.channelLabel}>
                    {channel.icon} {channel.label}
                  </Text>
                  <View style={[styles.channelBadge, styles.channelBadgeNotConnected]}>
                    <Text style={styles.channelBadgeTextNotConnected}>Not connected</Text>
                  </View>
                </View>
                <Text style={styles.inboxCardHint}>{channel.note}</Text>
              </View>
            ))}

            <View style={styles.fieldSpacing}>
              <ThemedFormField label="Company name" value={name} onChangeText={setName} />
            </View>
            <View style={styles.fieldSpacing}>
              <ThemedFormField label="ABN" placeholder="e.g. 12 345 678 901" value={abn} onChangeText={setAbn} />
            </View>
            <View style={styles.fieldSpacing}>
              <ThemedFormField label="Email" placeholder="info@yourcompany.com.au" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
            </View>
            <View style={styles.fieldSpacing}>
              <ThemedFormField label="Phone" placeholder="e.g. 0400 000 000" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            </View>
            <View style={styles.fieldSpacing}>
              <ThemedFormField label="Website" placeholder="yourcompany.com.au" value={website} onChangeText={setWebsite} autoCapitalize="none" />
            </View>

            <Text style={styles.sectionTitle}>Business Address</Text>
            <ThemedFormField label="Address line 1" value={addressLine1} onChangeText={setAddressLine1} />
            <View style={styles.fieldSpacing}>
              <ThemedFormField label="Address line 2 (optional)" value={addressLine2} onChangeText={setAddressLine2} />
            </View>
            <View style={styles.addressRow}>
              <View style={styles.addressRowItem}>
                <ThemedFormField label="Suburb" value={suburb} onChangeText={setSuburb} />
              </View>
              <View style={styles.addressRowItemSmall}>
                <ThemedFormField label="State" value={state} onChangeText={setState} autoCapitalize="characters" />
              </View>
              <View style={styles.addressRowItemSmall}>
                <ThemedFormField label="Postcode" value={postcode} onChangeText={setPostcode} keyboardType="number-pad" />
              </View>
            </View>

            <View style={styles.fieldSpacing}>
              <ThemedFormField label="License number" value={licenseNumber} onChangeText={setLicenseNumber} />
            </View>

            <Text style={styles.sectionTitle}>Bank Details</Text>
            <ThemedFormField label="Account name" value={bankAccountName} onChangeText={setBankAccountName} />
            <View style={styles.fieldSpacing}>
              <ThemedFormField label="Account number" value={bankAccountNumber} onChangeText={setBankAccountNumber} keyboardType="number-pad" />
            </View>
            <View style={styles.fieldSpacing}>
              <ThemedFormField label="BSB" value={bankBsb} onChangeText={setBankBsb} keyboardType="number-pad" />
            </View>

            {saveError ? <Text style={styles.error}>{saveError}</Text> : null}

            <View style={styles.saveButtonWrap}>
              <ThemedButton label={saving ? "Saving..." : "Save Changes"} onPress={handleSave} disabled={saving} />
            </View>

            <Text style={styles.sectionTitle}>Xero</Text>
            <View style={styles.xeroCard}>
              {xeroStatus?.connected ? (
                <>
                  <Text style={styles.connectedText}>Connected to {xeroStatus.org_name || "Xero"}</Text>
                  {xeroStatus.connected_at ? (
                    <Text style={styles.meta}>Since {new Date(xeroStatus.connected_at).toLocaleDateString("en-AU")}</Text>
                  ) : null}
                  <Pressable onPress={disconnectXero} disabled={xeroDisconnecting} style={{ marginTop: 8 }}>
                    <Text style={styles.deleteLink}>{xeroDisconnecting ? "Disconnecting..." : "Disconnect Xero"}</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={styles.meta}>
                    Connect Xero to push invoices (as they're sent/accepted) straight into your accounting - each invoice gets a "Sync to
                    Xero" button once connected.
                  </Text>
                  <View style={styles.connectButtonWrap}>
                    <ThemedButton label={xeroConnecting ? "Opening Xero..." : "Connect to Xero"} onPress={connectXero} disabled={xeroConnecting} />
                  </View>
                </>
              )}
              {xeroConnectError ? <Text style={styles.error}>{xeroConnectError}</Text> : null}
            </View>

            {xeroStatus?.connected ? (
              <View style={styles.fieldSpacing}>
                <ThemedFormField
                  label="Xero sales account code"
                  placeholder="200"
                  value={xeroSalesAccountCode}
                  onChangeText={setXeroSalesAccountCode}
                  keyboardType="number-pad"
                />
                <Text style={styles.meta}>
                  The chart-of-accounts code invoice line items post against in Xero (Save changes above to update this). "200" is Xero's
                  default "Sales" code.
                </Text>
              </View>
            ) : null}
          </ScrollView>
        )}
      </SafeAreaView>
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
    subtitle: { color: tokens.textMuted, marginTop: 2, marginBottom: 16, fontSize: font.body - 1, ...mono },
    sectionTitle: {
      fontSize: font.label,
      fontWeight: "700" as const,
      color: tokens.accent,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      marginTop: 24,
      marginBottom: 8,
      ...mono,
    },
    fieldSpacing: { marginTop: 16 },
    addressRow: { flexDirection: "row" as const, gap: 8, marginTop: 16 },
    addressRowItem: { flex: 2 },
    addressRowItemSmall: { flex: 1 },
    error: { color: tokens.danger, marginTop: 12, ...mono },
    saveButtonWrap: { marginTop: 24 },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 24, ...mono },
    logoPreview: { width: "100%" as const, height: 100, backgroundColor: tokens.surface, borderRadius: 4, borderWidth: 1, borderColor: tokens.border },
    logoPlaceholder: {
      width: "100%" as const,
      height: 100,
      backgroundColor: tokens.surface,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: tokens.border,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    logoPlaceholderText: { color: tokens.textMuted, ...mono },
    logoActions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 20, marginTop: 10 },
    logoButton: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: tokens.surface, alignSelf: "flex-start" as const, marginTop: 8 },
    logoButtonText: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    deleteLink: { color: tokens.danger, fontWeight: "600" as const, ...mono },
    meta: { fontSize: font.body - 2, color: tokens.textMuted, ...mono },
    connectedText: { fontSize: font.body - 1, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    connectButtonWrap: { alignSelf: "flex-start" as const, marginTop: 8 },
    xeroCard: { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border, borderRadius: 4, padding: 14, gap: 4, boxShadow: `0 0 10px ${tokens.accentGlow}` },
    inboxCard: { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border, borderRadius: 4, padding: 14, gap: 8, marginBottom: 8, boxShadow: `0 0 10px ${tokens.accentGlow}` },
    inboxCardHint: { fontSize: font.body - 2, color: tokens.textMuted, ...mono },
    inboxAddress: { fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    channelHeaderRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, marginBottom: 4 },
    channelLabel: { fontSize: font.body - 1, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    channelBadge: { borderRadius: 3, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
    channelBadgeConnected: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    channelBadgeNotConnected: { backgroundColor: "transparent", borderColor: tokens.border },
    channelBadgeTextConnected: { fontSize: font.label - 1, fontWeight: "700" as const, color: tokens.accent, ...mono },
    channelBadgeTextNotConnected: { fontSize: font.label - 1, fontWeight: "700" as const, color: tokens.textMuted, ...mono },
  };
}

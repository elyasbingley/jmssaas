import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  updateCompanySettingsSchema,
  updateSmsPhoneNumberSchema,
  updateWhatsappPhoneNumberSchema,
  DEFAULT_CALENDAR_CATEGORY_COLORS,
  type CalendarCategoryColors,
  type CalendarEventCategory,
  type Tenant,
  type GoogleCalendarConnectionStatus,
  type GoogleCalendarConnectionListItem,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedFormField } from "../components/theme/ThemedFormField";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedBadge } from "../components/theme/ThemedBadge";

const LOGO_BUCKET = "company-logos";

async function fetchTenant(tenantId: string): Promise<Tenant> {
  const { data, error } = await supabase.from("tenants").select("*").eq("id", tenantId).single();
  if (error) throw error;
  return data as Tenant;
}

interface XeroStatus {
  connected: boolean;
  org_name?: string;
  connected_at?: string;
}

async function fetchXeroStatus(): Promise<XeroStatus> {
  const { data, error } = await supabase.rpc("get_xero_connection_status");
  if (error) throw error;
  return data as XeroStatus;
}

interface FacebookStatus {
  connected: boolean;
  page_name?: string;
  connected_at?: string;
}

async function fetchFacebookStatus(): Promise<FacebookStatus> {
  const { data, error } = await supabase.rpc("get_facebook_connection_status");
  if (error) throw error;
  return data as FacebookStatus;
}

async function fetchGoogleCalendarStatus(): Promise<GoogleCalendarConnectionStatus> {
  const { data, error } = await supabase.rpc("get_google_calendar_connection_status");
  if (error) throw error;
  return data as GoogleCalendarConnectionStatus;
}

async function fetchGoogleCalendarConnections(): Promise<GoogleCalendarConnectionListItem[]> {
  const { data, error } = await supabase.rpc("list_google_calendar_connections");
  if (error) throw error;
  return (data as GoogleCalendarConnectionListItem[]) ?? [];
}

export default function SettingsPage() {
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const { data: tenant } = useQuery({
    queryKey: ["tenant", profile?.tenant_id],
    queryFn: () => fetchTenant(profile!.tenant_id),
    enabled: !!profile,
  });
  const { data: xeroStatus } = useQuery({ queryKey: ["xero-status"], queryFn: fetchXeroStatus, enabled: !!profile });
  const { data: facebookStatus } = useQuery({ queryKey: ["facebook-status"], queryFn: fetchFacebookStatus, enabled: !!profile });
  const { data: googleStatus } = useQuery({
    queryKey: ["google-calendar-status"],
    queryFn: fetchGoogleCalendarStatus,
    enabled: !!profile,
  });
  const { data: googleConnections } = useQuery({
    queryKey: ["google-calendar-connections"],
    queryFn: fetchGoogleCalendarConnections,
    enabled: !!profile && isAdmin,
  });

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
  const [xeroSalesAccountCode, setXeroSalesAccountCode] = useState("");
  const [categoryColors, setCategoryColors] = useState<CalendarCategoryColors>(DEFAULT_CALENDAR_CATEGORY_COLORS);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [inboxAddressCopied, setInboxAddressCopied] = useState(false);
  const [smsPhoneNumberInput, setSmsPhoneNumberInput] = useState("");
  const [smsError, setSmsError] = useState<string | null>(null);
  const [smsSaved, setSmsSaved] = useState(false);
  const [whatsappPhoneNumberInput, setWhatsappPhoneNumberInput] = useState("");
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
      setCategoryColors(tenant.calendar_category_colors ?? DEFAULT_CALENDAR_CATEGORY_COLORS);
    }
  }, [tenant]);

  const invalidateTenant = () => queryClient.invalidateQueries({ queryKey: ["tenant", profile?.tenant_id] });

  // Xero connect/disconnect - see xero-oauth-start's own comment for why
  // this needs a bearer-token POST (to build the authorize URL server-side
  // and record a CSRF-protection state row) rather than just a static link.
  const [searchParams, setSearchParams] = useSearchParams();
  const [xeroConnectError, setXeroConnectError] = useState<string | null>(null);
  const [xeroConnecting, setXeroConnecting] = useState(false);

  useEffect(() => {
    const xeroResult = searchParams.get("xero");
    if (!xeroResult) return;
    if (xeroResult === "error") {
      setXeroConnectError(searchParams.get("xero_message") || "Failed to connect to Xero");
    } else if (xeroResult === "connected") {
      queryClient.invalidateQueries({ queryKey: ["xero-status"] });
    }
    setSearchParams((params) => {
      params.delete("xero");
      params.delete("xero_message");
      return params;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const connectXero = async () => {
    setXeroConnecting(true);
    setXeroConnectError(null);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!supabaseUrl || !token) throw new Error("Not signed in");
      const res = await fetch(`${supabaseUrl}/functions/v1/xero-oauth-start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const resBody = await res.json();
      if (!res.ok || resBody.error || !resBody.url) throw new Error(resBody.error || "Failed to start Xero connection");
      window.location.href = resBody.url as string;
    } catch (e) {
      setXeroConnectError(getErrorMessage(e, "Failed to start Xero connection"));
      setXeroConnecting(false);
    }
  };

  const disconnectXero = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("disconnect_xero");
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["xero-status"] }),
    onError: (e) => setXeroConnectError(getErrorMessage(e, "Failed to disconnect")),
  });

  // Facebook Messenger connect/disconnect - same shape as Xero's above,
  // see facebook-oauth-start's own comment for why this needs a
  // bearer-token POST rather than a static link.
  const [facebookConnectError, setFacebookConnectError] = useState<string | null>(null);
  const [facebookConnecting, setFacebookConnecting] = useState(false);

  useEffect(() => {
    const facebookResult = searchParams.get("facebook");
    if (!facebookResult) return;
    if (facebookResult === "error") {
      setFacebookConnectError(searchParams.get("facebook_message") || "Failed to connect to Facebook");
    } else if (facebookResult === "connected") {
      queryClient.invalidateQueries({ queryKey: ["facebook-status"] });
    }
    setSearchParams((params) => {
      params.delete("facebook");
      params.delete("facebook_message");
      return params;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const connectFacebook = async () => {
    setFacebookConnecting(true);
    setFacebookConnectError(null);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!supabaseUrl || !token) throw new Error("Not signed in");
      const res = await fetch(`${supabaseUrl}/functions/v1/facebook-oauth-start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const resBody = await res.json();
      if (!res.ok || resBody.error || !resBody.url) throw new Error(resBody.error || "Failed to start Facebook connection");
      window.location.href = resBody.url as string;
    } catch (e) {
      setFacebookConnectError(getErrorMessage(e, "Failed to start Facebook connection"));
      setFacebookConnecting(false);
    }
  };

  const disconnectFacebook = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("disconnect_facebook");
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["facebook-status"] }),
    onError: (e) => setFacebookConnectError(getErrorMessage(e, "Failed to disconnect")),
  });

  // Membership Stripe Connect - unlike Xero/Google's OAuth redirect (a
  // code exchange the callback function completes server-side before
  // redirecting back here), Stripe's own Express onboarding flow just
  // drops the tenant back at return_url once they're done, with no
  // account status attached - so the return leg here re-calls the SAME
  // stripe-connect-onboard function, which already has an "account
  // exists, check its current state" branch (see that function's own
  // comment) rather than needing a second, separate function just to
  // re-check status.
  const [stripeConnectError, setStripeConnectError] = useState<string | null>(null);
  const [stripeConnecting, setStripeConnecting] = useState(false);

  const connectStripeMembership = async () => {
    setStripeConnecting(true);
    setStripeConnectError(null);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!supabaseUrl || !token) throw new Error("Not signed in");
      const returnUrl = `${window.location.origin}${window.location.pathname}?stripe_connect=return`;
      const res = await fetch(`${supabaseUrl}/functions/v1/stripe-connect-onboard`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ return_url: returnUrl, refresh_url: returnUrl }),
      });
      const resBody = await res.json();
      if (!res.ok || resBody.error) throw new Error(resBody.detail || resBody.error || "Failed to start Stripe connection");
      if (resBody.already_onboarded) {
        invalidateTenant();
        setStripeConnecting(false);
        return;
      }
      if (!resBody.onboarding_url) throw new Error("Failed to start Stripe connection");
      window.location.href = resBody.onboarding_url as string;
    } catch (e) {
      setStripeConnectError(getErrorMessage(e, "Failed to start Stripe connection"));
      setStripeConnecting(false);
    }
  };

  useEffect(() => {
    if (searchParams.get("stripe_connect") !== "return") return;
    setSearchParams((params) => {
      params.delete("stripe_connect");
      return params;
    });
    connectStripeMembership();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Google Calendar connect/disconnect - every profile connects their own
  // account (not admin-gated, unlike Xero), same bearer-token-POST shape
  // as Xero's flow since the authorize URL/CSRF state also has to be built
  // server-side. Admins additionally see and can disconnect anyone on the
  // team's connection (googleConnections above, admin-gated at the RPC).
  const [googleConnectError, setGoogleConnectError] = useState<string | null>(null);
  const [googleConnecting, setGoogleConnecting] = useState(false);

  useEffect(() => {
    const googleResult = searchParams.get("google_calendar");
    if (!googleResult) return;
    if (googleResult === "error") {
      setGoogleConnectError(searchParams.get("google_calendar_message") || "Failed to connect Google Calendar");
    } else if (googleResult === "connected") {
      queryClient.invalidateQueries({ queryKey: ["google-calendar-status"] });
      queryClient.invalidateQueries({ queryKey: ["google-calendar-connections"] });
    }
    setSearchParams((params) => {
      params.delete("google_calendar");
      params.delete("google_calendar_message");
      return params;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const connectGoogleCalendar = async () => {
    setGoogleConnecting(true);
    setGoogleConnectError(null);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!supabaseUrl || !token) throw new Error("Not signed in");
      const res = await fetch(`${supabaseUrl}/functions/v1/google-oauth-start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const resBody = await res.json();
      if (!res.ok || resBody.error || !resBody.url) throw new Error(resBody.error || "Failed to start Google Calendar connection");
      window.location.href = resBody.url as string;
    } catch (e) {
      setGoogleConnectError(getErrorMessage(e, "Failed to start Google Calendar connection"));
      setGoogleConnecting(false);
    }
  };

  const disconnectGoogleCalendar = useMutation({
    mutationFn: async (targetProfileId?: string) => {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!supabaseUrl || !token) throw new Error("Not signed in");
      const res = await fetch(`${supabaseUrl}/functions/v1/google-calendar-disconnect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(targetProfileId ? { profileId: targetProfileId } : {}),
      });
      const resBody = await res.json();
      if (!res.ok || resBody.error) throw new Error(resBody.error || "Failed to disconnect Google Calendar");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["google-calendar-status"] });
      queryClient.invalidateQueries({ queryKey: ["google-calendar-connections"] });
    },
    onError: (e) => setGoogleConnectError(getErrorMessage(e, "Failed to disconnect Google Calendar")),
  });

  // Logo upload is a separate, immediate write (not part of Save changes
  // below) - same pattern as mobile. Each upload uses a fresh filename so
  // the new public URL can't be served stale from a CDN/image cache under
  // the old one.
  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      if (!profile) throw new Error("Not signed in");
      const extension = file.type.includes("png") ? "png" : "jpg";
      const path = `${profile.tenant_id}/logo-${Date.now()}.${extension}`;
      const { error: uploadError } = await supabase.storage
        .from(LOGO_BUCKET)
        .upload(path, file, { contentType: file.type || "image/jpeg", upsert: true });
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(path);
      const { error: updateError } = await supabase
        .from("tenants")
        .update({ logo_url: publicUrlData.publicUrl })
        .eq("id", profile.tenant_id);
      if (updateError) throw updateError;
    },
    onSuccess: () => {
      invalidateTenant();
      setLogoError(null);
    },
    onError: (e) => setLogoError(getErrorMessage(e, "Failed to upload logo")),
  });

  const removeLogo = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const { error } = await supabase.from("tenants").update({ logo_url: null }).eq("id", profile.tenant_id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateTenant();
      setLogoError(null);
    },
    onError: (e) => setLogoError(getErrorMessage(e, "Failed to remove logo")),
  });

  const saveSmsPhoneNumber = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const result = updateSmsPhoneNumberSchema.safeParse({ sms_phone_number: smsPhoneNumberInput });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid phone number");
      const { error } = await supabase.from("tenants").update({ sms_phone_number: result.data.sms_phone_number }).eq("id", profile.tenant_id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateTenant();
      setSmsError(null);
      setSmsSaved(true);
      setTimeout(() => setSmsSaved(false), 3000);
    },
    onError: (e) => setSmsError(getErrorMessage(e, "Failed to save phone number")),
  });

  const saveWhatsappPhoneNumber = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const result = updateWhatsappPhoneNumberSchema.safeParse({ whatsapp_phone_number: whatsappPhoneNumberInput });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid phone number");
      const { error } = await supabase.from("tenants").update({ whatsapp_phone_number: result.data.whatsapp_phone_number }).eq("id", profile.tenant_id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateTenant();
      setWhatsappError(null);
      setWhatsappSaved(true);
      setTimeout(() => setWhatsappSaved(false), 3000);
    },
    onError: (e) => setWhatsappError(getErrorMessage(e, "Failed to save phone number")),
  });

  const save = useMutation({
    mutationFn: async () => {
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
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");
      if (!profile) throw new Error("Not signed in");

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
          calendar_category_colors: categoryColors,
        })
        .eq("id", profile.tenant_id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateTenant();
      queryClient.invalidateQueries({ queryKey: ["calendar-category-colors", profile?.tenant_id] });
      setSaveError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save")),
  });

  return (
    <div className="mx-auto max-w-2xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings" className="mb-4 inline-block text-sm hover:underline" style={{ color: "var(--jms-accent)" }}>
        &larr; Back to Settings
      </Link>
      <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Company Settings
      </h1>
      <p className="mb-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Used on exported quote/invoice PDFs.
      </p>

      <h2 className="mb-2 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Logo
      </h2>
      {tenant?.logo_url ? (
        <img
          src={tenant.logo_url}
          alt="Company logo"
          className="mb-2 h-24 w-full rounded-md object-contain"
          style={{ backgroundColor: "var(--jms-bg)" }}
        />
      ) : (
        <div
          className="mb-2 flex h-24 w-full items-center justify-center rounded-md"
          style={{ backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
        >
          No logo uploaded
        </div>
      )}
      <div className="mb-2 flex items-center gap-4">
        <label
          className="cursor-pointer rounded-md px-4 py-2 font-semibold"
          style={{ backgroundColor: "var(--jms-bg)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
        >
          {uploadLogo.isPending ? "Uploading..." : tenant?.logo_url ? "Change logo" : "Upload logo"}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={uploadLogo.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadLogo.mutate(file);
              e.target.value = "";
            }}
          />
        </label>
        {tenant?.logo_url ? (
          <button
            onClick={() => removeLogo.mutate()}
            className="font-semibold"
            style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}
          >
            Remove
          </button>
        ) : null}
      </div>
      {logoError ? (
        <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {logoError}
        </p>
      ) : null}

      <h2 className="mb-2 mt-6 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Inbox
      </h2>
      {tenant?.inbox_local_part && import.meta.env.VITE_INBOX_DOMAIN ? (
        <div className="mb-6 rounded-md p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <p className="mb-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Forward quote requests and job files to this address - see the Inbox screen to attach them to a job or
            review an AI-drafted job.
          </p>
          <div className="flex items-center gap-3">
            <code
              className="rounded px-2 py-1 font-semibold"
              style={{ backgroundColor: "var(--jms-bg)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
            >
              {tenant.inbox_local_part}@{import.meta.env.VITE_INBOX_DOMAIN}
            </code>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(`${tenant.inbox_local_part}@${import.meta.env.VITE_INBOX_DOMAIN}`);
                setInboxAddressCopied(true);
                setTimeout(() => setInboxAddressCopied(false), 2000);
              }}
              className="font-semibold hover:underline"
              style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
            >
              {inboxAddressCopied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      ) : (
        <p className="mb-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          Not configured yet - set <code>VITE_INBOX_DOMAIN</code> to your verified Resend inbound domain (see
          docs/SETUP.md's Inbox section).
        </p>
      )}

      <h2 className="mb-2 mt-6 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Channels
      </h2>
      <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
        Connect a phone number/account for each channel - see the Channels screen to view and reply to
        conversations, or create a job/task from one.
      </p>
      <div className="mb-3 rounded-md p-4" style={{ border: "1px solid var(--jms-border)" }}>
        <div className="mb-2 flex items-center justify-between">
          <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            💬 SMS
          </p>
          {tenant?.sms_phone_number ? (
            <ThemedBadge label="Connected" color="var(--jms-accent)" />
          ) : (
            <ThemedBadge label="Not connected" color="var(--jms-text-muted)" />
          )}
        </div>
        <p className="mb-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          The phone number you bought/ported in the platform's Twilio account (see docs/SETUP.md's Channels
          section) - E.164 or local format both work, e.g. 0491 570 156.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="tel"
            value={smsPhoneNumberInput}
            onChange={(e) => setSmsPhoneNumberInput(e.target.value)}
            placeholder="0491 570 156"
            className="flex-1 rounded-md border px-3 py-2 focus:outline-none"
            style={{
              backgroundColor: "var(--jms-bg)",
              borderColor: "var(--jms-border)",
              color: "var(--jms-text)",
              fontFamily: "var(--jms-font)",
              fontSize: "var(--jms-font-body)",
            }}
          />
          <ThemedButton onClick={() => saveSmsPhoneNumber.mutate()} disabled={saveSmsPhoneNumber.isPending}>
            {saveSmsPhoneNumber.isPending ? "Saving..." : smsSaved ? "Saved!" : "Save"}
          </ThemedButton>
        </div>
        {smsError ? (
          <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {smsError}
          </p>
        ) : null}
      </div>

      <div className="mb-3 rounded-md p-4" style={{ border: "1px solid var(--jms-border)" }}>
        <div className="mb-2 flex items-center justify-between">
          <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            🟢 WhatsApp
          </p>
          {tenant?.whatsapp_phone_number ? (
            <ThemedBadge label="Connected" color="var(--jms-accent)" />
          ) : (
            <ThemedBadge label="Not connected" color="var(--jms-text-muted)" />
          )}
        </div>
        <p className="mb-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          A Twilio Sandbox number works for testing right now with no Meta approval needed - a permanent number for
          messaging real clients first needs Meta Business verification and an approved template. See
          docs/SETUP.md's Channels section.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="tel"
            value={whatsappPhoneNumberInput}
            onChange={(e) => setWhatsappPhoneNumberInput(e.target.value)}
            placeholder="0491 570 156"
            className="flex-1 rounded-md border px-3 py-2 focus:outline-none"
            style={{
              backgroundColor: "var(--jms-bg)",
              borderColor: "var(--jms-border)",
              color: "var(--jms-text)",
              fontFamily: "var(--jms-font)",
              fontSize: "var(--jms-font-body)",
            }}
          />
          <ThemedButton onClick={() => saveWhatsappPhoneNumber.mutate()} disabled={saveWhatsappPhoneNumber.isPending}>
            {saveWhatsappPhoneNumber.isPending ? "Saving..." : whatsappSaved ? "Saved!" : "Save"}
          </ThemedButton>
        </div>
        {whatsappError ? (
          <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {whatsappError}
          </p>
        ) : null}
      </div>

      <div className="mb-3 rounded-md p-4" style={{ border: "1px solid var(--jms-border)" }}>
        <div className="mb-2 flex items-center justify-between">
          <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            🔵 Messenger
          </p>
          {facebookStatus?.connected ? (
            <ThemedBadge label="Connected" color="var(--jms-accent)" />
          ) : (
            <ThemedBadge label="Not connected" color="var(--jms-text-muted)" />
          )}
        </div>
        {facebookStatus?.connected ? (
          <>
            <p className="mb-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              Connected to {facebookStatus.page_name || "your Facebook Page"}
              {facebookStatus.connected_at ? ` since ${new Date(facebookStatus.connected_at).toLocaleDateString("en-AU")}` : ""}.
            </p>
            <button
              onClick={() => disconnectFacebook.mutate()}
              disabled={disconnectFacebook.isPending}
              className="font-semibold"
              style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}
            >
              {disconnectFacebook.isPending ? "Disconnecting..." : "Disconnect Messenger"}
            </button>
          </>
        ) : (
          <>
            <p className="mb-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              Connect your Facebook Page to send and receive Messenger conversations here - works right away for a
              Page you personally admin, wider client Pages need Meta App Review first. See docs/SETUP.md's Channels
              section.
            </p>
            <ThemedButton onClick={connectFacebook} disabled={facebookConnecting}>
              {facebookConnecting ? "Redirecting to Facebook..." : "Connect to Facebook"}
            </ThemedButton>
          </>
        )}
        {facebookConnectError ? (
          <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {facebookConnectError}
          </p>
        ) : null}
      </div>

      {(
        [
          { icon: "📷", label: "Instagram", note: "Needs Meta App Review before this app can message through your Instagram account - see docs/SETUP.md." },
        ] as const
      ).map((channel) => (
        <div key={channel.label} className="mb-3 rounded-md p-4" style={{ border: "1px solid var(--jms-border)" }}>
          <div className="mb-1 flex items-center justify-between">
            <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
              {channel.icon} {channel.label}
            </p>
            <ThemedBadge label="Not connected" color="var(--jms-text-muted)" />
          </div>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>{channel.note}</p>
        </div>
      ))}

      <ThemedFormField label="Company name" value={name} onChange={(e) => setName(e.target.value)} />
      <ThemedFormField label="ABN" value={abn} onChange={(e) => setAbn(e.target.value)} placeholder="e.g. 12 345 678 901" />
      <ThemedFormField label="Email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="info@yourcompany.com.au" />
      <ThemedFormField label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 0400 000 000" />
      <ThemedFormField label="Website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="yourcompany.com.au" />

      <h2 className="mb-2 mt-6 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Business address
      </h2>
      <ThemedFormField label="Address line 1" value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} />
      <ThemedFormField label="Address line 2 (optional)" value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} />
      <div className="grid grid-cols-3 gap-3">
        <ThemedFormField label="Suburb" value={suburb} onChange={(e) => setSuburb(e.target.value)} />
        <ThemedFormField label="State" value={state} onChange={(e) => setState(e.target.value)} />
        <ThemedFormField label="Postcode" value={postcode} onChange={(e) => setPostcode(e.target.value)} />
      </div>

      <ThemedFormField label="License number" value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} />

      <h2 className="mb-2 mt-6 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Bank details
      </h2>
      <ThemedFormField label="Account name" value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} />
      <ThemedFormField label="Account number" value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} />
      <ThemedFormField label="BSB" value={bankBsb} onChange={(e) => setBankBsb(e.target.value)} />

      {saveError ? (
        <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {saveError}
        </p>
      ) : null}
      {saved ? (
        <p className="mb-2" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
          Saved.
        </p>
      ) : null}

      <ThemedButton onClick={() => save.mutate()} disabled={save.isPending} style={{ marginTop: 8, paddingBlock: 12, paddingInline: 24 }}>
        {save.isPending ? "Saving..." : "Save changes"}
      </ThemedButton>

      <h2 className="mb-2 mt-8 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Xero
      </h2>
      <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {xeroStatus?.connected ? (
          <div>
            <p className="flex items-center font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
              Connected to {xeroStatus.org_name || "Xero"}
              <span className="ml-2">
                <ThemedBadge label="Connected" color="var(--jms-accent)" />
              </span>
            </p>
            {xeroStatus.connected_at ? (
              <p className="mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                Since {new Date(xeroStatus.connected_at).toLocaleDateString("en-AU")}
              </p>
            ) : null}
            {isAdmin ? (
              <button
                onClick={() => disconnectXero.mutate()}
                disabled={disconnectXero.isPending}
                className="mt-3 font-semibold hover:underline disabled:opacity-60"
                style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}
              >
                {disconnectXero.isPending ? "Disconnecting..." : "Disconnect Xero"}
              </button>
            ) : null}
          </div>
        ) : (
          <div>
            <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              Connect Xero to push invoices (as they're sent/accepted) straight into your accounting - each invoice gets a "Sync to
              Xero" button once connected.
            </p>
            {isAdmin ? (
              <ThemedButton onClick={connectXero} disabled={xeroConnecting}>
                {xeroConnecting ? "Redirecting to Xero..." : "Connect to Xero"}
              </ThemedButton>
            ) : (
              <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Only an admin can connect Xero.</p>
            )}
          </div>
        )}
        {xeroConnectError ? (
          <p className="mt-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {xeroConnectError}
          </p>
        ) : null}
      </div>
      {xeroStatus?.connected ? (
        <div className="mt-3">
          <ThemedFormField
            label="Xero sales account code"
            value={xeroSalesAccountCode}
            onChange={(e) => setXeroSalesAccountCode(e.target.value)}
            placeholder="200"
          />
          <p className="-mt-3 mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            The chart-of-accounts code invoice line items post against in Xero (Save changes above to update this). "200" is Xero's
            default "Sales" code - check Xero's Chart of Accounts if yours differs.
          </p>
        </div>
      ) : null}

      <h2 className="mb-2 mt-8 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Membership - Stripe Connect
      </h2>
      <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {tenant?.stripe_connect_onboarded ? (
          <p className="flex items-center font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            Connected
            <span className="ml-2">
              <ThemedBadge label="Ready to accept payments" color="var(--jms-accent)" />
            </span>
          </p>
        ) : (
          <div>
            <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              Connect Stripe to accept membership payments - each membership payment settles directly into your own bank account, not a
              shared account. Required before you can enrol any client in the Membership page.
            </p>
            {isAdmin ? (
              <ThemedButton onClick={connectStripeMembership} disabled={stripeConnecting}>
                {stripeConnecting
                  ? "Redirecting to Stripe..."
                  : tenant?.stripe_connect_account_id
                    ? "Finish Stripe setup"
                    : "Connect Stripe"}
              </ThemedButton>
            ) : (
              <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Only an admin can connect Stripe.</p>
            )}
          </div>
        )}
        {stripeConnectError ? (
          <p className="mt-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {stripeConnectError}
          </p>
        ) : null}
      </div>

      <h2 className="mb-2 mt-8 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Google Calendar
      </h2>
      <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {googleStatus?.connected ? (
          <div>
            <p className="flex items-center font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
              Connected as {googleStatus.email || "your Google account"}
              <span className="ml-2">
                <ThemedBadge label="Connected" color="var(--jms-accent)" />
              </span>
            </p>
            {googleStatus.connected_at ? (
              <p className="mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                Since {new Date(googleStatus.connected_at).toLocaleDateString("en-AU")}
              </p>
            ) : null}
            <button
              onClick={() => disconnectGoogleCalendar.mutate(undefined)}
              disabled={disconnectGoogleCalendar.isPending}
              className="mt-3 font-semibold hover:underline disabled:opacity-60"
              style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}
            >
              {disconnectGoogleCalendar.isPending ? "Disconnecting..." : "Disconnect Google Calendar"}
            </button>
          </div>
        ) : (
          <div>
            <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              Connect your Google Calendar to sync jobs both ways - scheduled jobs show up on your phone, and any change you make there
              (or in the app) updates the other side automatically. Your own personal Google events show up here as "Busy" blocks so
              scheduling avoids clashes; only you can see their real details.
            </p>
            <ThemedButton onClick={connectGoogleCalendar} disabled={googleConnecting}>
              {googleConnecting ? "Redirecting to Google..." : "Connect Google Calendar"}
            </ThemedButton>
          </div>
        )}
        {googleConnectError ? (
          <p className="mt-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {googleConnectError}
          </p>
        ) : null}
      </div>

      {isAdmin && googleConnections && googleConnections.length > 0 ? (
        <div className="mt-3 rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <h3 className="mb-2 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Team Google Calendar connections
          </h3>
          <ul>
            {googleConnections.map((c, i) => (
              <li
                key={c.profile_id}
                className="flex items-center justify-between py-2"
                style={i > 0 ? { borderTop: "1px solid var(--jms-border)" } : undefined}
              >
                <div>
                  <p className="font-medium" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                    {c.full_name || c.email}
                  </p>
                  {c.google_account_email ? (
                    <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                      Connected as {c.google_account_email}
                      {c.connected_at ? ` · since ${new Date(c.connected_at).toLocaleDateString("en-AU")}` : ""}
                    </p>
                  ) : (
                    <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>Not connected</p>
                  )}
                </div>
                {c.google_account_email ? (
                  <button
                    onClick={() => disconnectGoogleCalendar.mutate(c.profile_id)}
                    disabled={disconnectGoogleCalendar.isPending}
                    className="font-semibold hover:underline disabled:opacity-60"
                    style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}
                  >
                    Disconnect
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <h2 className="mb-2 mt-8 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Calendar colors
      </h2>
      <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          Every calendar event is colored automatically by what it's linked to - pick the color for each category (Save changes
          below to apply).
        </p>
        <div className="flex flex-col gap-3">
          {(
            [
              { key: "job", label: "Job-linked events" },
              { key: "task", label: "Task-linked events" },
              { key: "personal", label: "Personal Google Calendar events" },
              { key: "general", label: "General events (no job/task link)" },
            ] as { key: CalendarEventCategory; label: string }[]
          ).map((row) => (
            <div key={row.key} className="flex items-center gap-3">
              <input
                type="color"
                value={categoryColors[row.key]}
                onChange={(e) => setCategoryColors((prev) => ({ ...prev, [row.key]: e.target.value }))}
                className="h-8 w-10 cursor-pointer rounded border"
                style={{ borderColor: "var(--jms-border)" }}
              />
              <span style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>{row.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

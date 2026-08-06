import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { updateCompanySettingsSchema, type Tenant } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { FormField } from "../components/FormField";

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

export default function SettingsPage() {
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const { data: tenant } = useQuery({
    queryKey: ["tenant", profile?.tenant_id],
    queryFn: () => fetchTenant(profile!.tenant_id),
    enabled: !!profile,
  });
  const { data: xeroStatus } = useQuery({ queryKey: ["xero-status"], queryFn: fetchXeroStatus, enabled: !!profile });

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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  useEffect(() => {
    if (tenant) {
      setName(tenant.name);
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
        })
        .eq("id", profile.tenant_id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateTenant();
      setSaveError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save")),
  });

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-bold text-gray-900">Company Settings</h1>
      <p className="mb-6 text-sm text-gray-500">Used on exported quote/invoice PDFs.</p>

      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-gray-500">Logo</h2>
      {tenant?.logo_url ? (
        <img src={tenant.logo_url} alt="Company logo" className="mb-2 h-24 w-full rounded-md bg-gray-50 object-contain" />
      ) : (
        <div className="mb-2 flex h-24 w-full items-center justify-center rounded-md bg-gray-100 text-sm text-gray-400">
          No logo uploaded
        </div>
      )}
      <div className="mb-2 flex items-center gap-4">
        <label className="cursor-pointer rounded-md bg-gray-100 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-gray-200">
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
          <button onClick={() => removeLogo.mutate()} className="text-sm font-semibold text-red-600">
            Remove
          </button>
        ) : null}
      </div>
      {logoError ? <p className="mb-4 text-sm text-red-600">{logoError}</p> : null}

      <FormField label="Company name" value={name} onChange={(e) => setName(e.target.value)} />
      <FormField label="ABN" value={abn} onChange={(e) => setAbn(e.target.value)} placeholder="e.g. 12 345 678 901" />
      <FormField label="Email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="info@yourcompany.com.au" />
      <FormField label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 0400 000 000" />
      <FormField label="Website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="yourcompany.com.au" />

      <h2 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-gray-500">Business address</h2>
      <FormField label="Address line 1" value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} />
      <FormField label="Address line 2 (optional)" value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} />
      <div className="grid grid-cols-3 gap-3">
        <FormField label="Suburb" value={suburb} onChange={(e) => setSuburb(e.target.value)} />
        <FormField label="State" value={state} onChange={(e) => setState(e.target.value)} />
        <FormField label="Postcode" value={postcode} onChange={(e) => setPostcode(e.target.value)} />
      </div>

      <FormField label="License number" value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} />

      <h2 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-gray-500">Bank details</h2>
      <FormField label="Account name" value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} />
      <FormField label="Account number" value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} />
      <FormField label="BSB" value={bankBsb} onChange={(e) => setBankBsb(e.target.value)} />

      {saveError ? <p className="mb-2 text-sm text-red-600">{saveError}</p> : null}
      {saved ? <p className="mb-2 text-sm text-green-700">Saved.</p> : null}

      <button
        onClick={() => save.mutate()}
        disabled={save.isPending}
        className="mt-2 rounded-md bg-blue-700 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
      >
        {save.isPending ? "Saving..." : "Save changes"}
      </button>

      <h2 className="mb-2 mt-8 text-sm font-bold uppercase tracking-wide text-gray-500">Xero</h2>
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        {xeroStatus?.connected ? (
          <div>
            <p className="text-sm font-semibold text-gray-900">
              Connected to {xeroStatus.org_name || "Xero"}
              <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700">Connected</span>
            </p>
            {xeroStatus.connected_at ? (
              <p className="mt-1 text-xs text-gray-500">Since {new Date(xeroStatus.connected_at).toLocaleDateString("en-AU")}</p>
            ) : null}
            {isAdmin ? (
              <button
                onClick={() => disconnectXero.mutate()}
                disabled={disconnectXero.isPending}
                className="mt-3 text-sm font-semibold text-red-600 hover:underline disabled:opacity-60"
              >
                {disconnectXero.isPending ? "Disconnecting..." : "Disconnect Xero"}
              </button>
            ) : null}
          </div>
        ) : (
          <div>
            <p className="mb-3 text-sm text-gray-600">
              Connect Xero to push invoices (as they're sent/accepted) straight into your accounting - each invoice gets a "Sync to
              Xero" button once connected.
            </p>
            {isAdmin ? (
              <button
                onClick={connectXero}
                disabled={xeroConnecting}
                className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
              >
                {xeroConnecting ? "Redirecting to Xero..." : "Connect to Xero"}
              </button>
            ) : (
              <p className="text-sm text-gray-400">Only an admin can connect Xero.</p>
            )}
          </div>
        )}
        {xeroConnectError ? <p className="mt-3 text-sm text-red-600">{xeroConnectError}</p> : null}
      </div>
      {xeroStatus?.connected ? (
        <div className="mt-3">
          <FormField
            label="Xero sales account code"
            value={xeroSalesAccountCode}
            onChange={(e) => setXeroSalesAccountCode(e.target.value)}
            placeholder="200"
          />
          <p className="-mt-3 mb-4 text-xs text-gray-400">
            The chart-of-accounts code invoice line items post against in Xero (Save changes above to update this). "200" is Xero's
            default "Sales" code - check Xero's Chart of Accounts if yours differs.
          </p>
        </div>
      ) : null}
    </div>
  );
}

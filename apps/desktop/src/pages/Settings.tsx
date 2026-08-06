import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export default function SettingsPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data: tenant } = useQuery({
    queryKey: ["tenant", profile?.tenant_id],
    queryFn: () => fetchTenant(profile!.tenant_id),
    enabled: !!profile,
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
    }
  }, [tenant]);

  const invalidateTenant = () => queryClient.invalidateQueries({ queryKey: ["tenant", profile?.tenant_id] });

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
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  createPropertyAssetSchema,
  formatCentsAsAud,
  updatePropertyContactSchema,
  type Agency,
  type Invoice,
  type JobCard,
  type Property,
  type PropertyAsset,
  type PropertyAssetAttributes,
  type PropertyAssetCategory,
  type PropertyManager,
  type Quote,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField, SelectField, TextAreaField } from "../components/FormField";

async function fetchProperty(id: string): Promise<Property> {
  const { data, error } = await supabase.from("properties").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Property;
}
async function fetchAgency(agencyId: string): Promise<Agency> {
  const { data, error } = await supabase.from("agencies").select("*").eq("id", agencyId).single();
  if (error) throw error;
  return data as Agency;
}
async function fetchPropertyManager(id: string): Promise<PropertyManager> {
  const { data, error } = await supabase.from("property_managers").select("*").eq("id", id).single();
  if (error) throw error;
  return data as PropertyManager;
}
async function fetchAssets(propertyId: string): Promise<PropertyAsset[]> {
  const { data, error } = await supabase.from("property_assets").select("*").eq("property_id", propertyId).order("category").order("asset_name");
  if (error) throw error;
  return data as PropertyAsset[];
}
async function fetchJobs(propertyId: string): Promise<JobCard[]> {
  const { data, error } = await supabase
    .from("job_cards")
    .select("*")
    .eq("property_id", propertyId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobCard[];
}
async function fetchQuotes(jobIds: string[]): Promise<Quote[]> {
  if (jobIds.length === 0) return [];
  const { data, error } = await supabase.from("quotes").select("*").in("job_card_id", jobIds);
  if (error) throw error;
  return data as Quote[];
}
async function fetchInvoices(jobIds: string[]): Promise<Invoice[]> {
  if (jobIds.length === 0) return [];
  const { data, error } = await supabase.from("invoices").select("*").in("job_card_id", jobIds);
  if (error) throw error;
  return data as Invoice[];
}

const ASSET_CATEGORY_OPTIONS: { value: PropertyAssetCategory; label: string }[] = [
  { value: "plumbing", label: "Plumbing" },
  { value: "roofing", label: "Roofing" },
  { value: "hvac", label: "HVAC" },
  { value: "general", label: "General" },
];

const CATEGORY_ICON: Record<PropertyAssetCategory, string> = {
  plumbing: "🚰",
  roofing: "🏠",
  hvac: "❄️",
  general: "🔧",
};

function isWarrantyActive(warrantyExpiryDate?: string): boolean {
  if (!warrantyExpiryDate) return false;
  return new Date(warrantyExpiryDate).getTime() > Date.now();
}

type ProfileTab = "access" | "assets" | "history";

export default function PropertyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: property } = useQuery({ queryKey: ["property", id], queryFn: () => fetchProperty(id!), enabled: !!id });
  const { data: agency } = useQuery({
    queryKey: ["agency", property?.agency_id],
    queryFn: () => fetchAgency(property!.agency_id),
    enabled: !!property,
  });
  const { data: propertyManager } = useQuery({
    queryKey: ["property-manager", property?.property_manager_id],
    queryFn: () => fetchPropertyManager(property!.property_manager_id!),
    enabled: !!property?.property_manager_id,
  });
  const { data: assets } = useQuery({ queryKey: ["property-assets", id], queryFn: () => fetchAssets(id!), enabled: !!id });
  const { data: jobs } = useQuery({ queryKey: ["property-jobs", id], queryFn: () => fetchJobs(id!), enabled: !!id });
  const jobIds = (jobs ?? []).map((j) => j.id);
  const { data: quotes } = useQuery({
    queryKey: ["property-quotes", jobIds.join(",")],
    queryFn: () => fetchQuotes(jobIds),
    enabled: !!jobs,
  });
  const { data: invoices } = useQuery({
    queryKey: ["property-invoices", jobIds.join(",")],
    queryFn: () => fetchInvoices(jobIds),
    enabled: !!jobs,
  });

  const [tab, setTab] = useState<ProfileTab>("access");

  // --- Edit Access & Contacts (landlord/tenant contact, access notes, key tag) ---
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const [ownerName, setOwnerName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [tenantPhone, setTenantPhone] = useState("");
  const [tenantEmail, setTenantEmail] = useState("");
  const [accessNotes, setAccessNotes] = useState("");
  const [keyTagNumber, setKeyTagNumber] = useState("");
  const [contactError, setContactError] = useState<string | null>(null);

  const openEditContact = () => {
    if (!property) return;
    setOwnerName(property.owner_landlord_name ?? "");
    setOwnerPhone(property.owner_landlord_phone ?? "");
    setOwnerEmail(property.owner_landlord_email ?? "");
    setTenantName(property.tenant_name ?? "");
    setTenantPhone(property.tenant_phone ?? "");
    setTenantEmail(property.tenant_email ?? "");
    setAccessNotes(property.access_notes ?? "");
    setKeyTagNumber(property.key_tag_number ?? "");
    setContactError(null);
    setContactModalOpen(true);
  };

  const saveContact = useMutation({
    mutationFn: async () => {
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
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid details");

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
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["property", id] });
      setContactModalOpen(false);
    },
    onError: (e) => setContactError(getErrorMessage(e, "Failed to save details")),
  });

  // --- Asset create/edit ---
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<PropertyAsset | null>(null);
  const [assetCategory, setAssetCategory] = useState<PropertyAssetCategory | "">("plumbing");
  const [assetName, setAssetName] = useState("");
  const [attrs, setAttrs] = useState<PropertyAssetAttributes>({});
  const [assetError, setAssetError] = useState<string | null>(null);

  const openNewAsset = () => {
    setEditingAsset(null);
    setAssetCategory("plumbing");
    setAssetName("");
    setAttrs({});
    setAssetError(null);
    setAssetModalOpen(true);
  };
  const openEditAsset = (asset: PropertyAsset) => {
    setEditingAsset(asset);
    setAssetCategory(asset.category);
    setAssetName(asset.asset_name);
    setAttrs(asset.attributes);
    setAssetError(null);
    setAssetModalOpen(true);
  };

  const saveAsset = useMutation({
    mutationFn: async () => {
      const result = createPropertyAssetSchema.safeParse({
        property_id: id,
        category: assetCategory || "general",
        asset_name: assetName,
        attributes: attrs,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid asset");
      if (!profile) throw new Error("Not signed in");

      if (editingAsset) {
        const { error } = await supabase
          .from("property_assets")
          .update({ category: result.data.category, asset_name: result.data.asset_name, attributes: result.data.attributes })
          .eq("id", editingAsset.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("property_assets").insert({
          tenant_id: profile.tenant_id,
          property_id: result.data.property_id,
          category: result.data.category,
          asset_name: result.data.asset_name,
          attributes: result.data.attributes,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["property-assets", id] });
      setAssetModalOpen(false);
    },
    onError: (e) => setAssetError(getErrorMessage(e, "Failed to save asset")),
  });

  const deleteAsset = useMutation({
    mutationFn: async (asset: PropertyAsset) => {
      const { error } = await supabase.from("property_assets").delete().eq("id", asset.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["property-assets", id] }),
  });

  if (!property) {
    return <div className="p-8 text-sm text-gray-500">Loading...</div>;
  }

  const quotesByJob = new Map<string, Quote[]>();
  for (const q of quotes ?? []) {
    if (!q.job_card_id) continue;
    quotesByJob.set(q.job_card_id, [...(quotesByJob.get(q.job_card_id) ?? []), q]);
  }
  const invoicesByJob = new Map<string, Invoice[]>();
  for (const inv of invoices ?? []) {
    if (!inv.job_card_id) continue;
    invoicesByJob.set(inv.job_card_id, [...(invoicesByJob.get(inv.job_card_id) ?? []), inv]);
  }

  return (
    <div className="p-8">
      <Link to="/real-estate" className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to Real Estate & Strata
      </Link>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900">{property.address_line1}</h1>
          <span className="text-sm text-gray-500">
            {property.suburb} {property.state} {property.postcode}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {agency ? (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">{agency.name}</span>
          ) : null}
          {propertyManager ? (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
              PM: {propertyManager.first_name} {propertyManager.last_name}
            </span>
          ) : null}
          {property.key_tag_number ? (
            <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-semibold text-yellow-800">
              🔑 {property.key_tag_number}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mb-6 flex gap-1 border-b border-gray-200">
        {(
          [
            { key: "access", label: "Access & Contacts" },
            { key: "assets", label: "Asset Register" },
            { key: "history", label: "Job & Compliance History" },
          ] as { key: ProfileTab; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`border-b-2 px-4 py-2 text-sm font-semibold ${
              tab === t.key ? "border-blue-700 text-blue-700" : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "access" ? (
        <div>
          <div className="mb-4 flex justify-end">
            <button
              onClick={openEditContact}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Edit
            </button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg border border-gray-200 bg-white p-6">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Landlord / Owner</h2>
              {property.owner_landlord_name ? <p className="text-sm font-semibold text-gray-900">{property.owner_landlord_name}</p> : null}
              <div className="mt-1 flex flex-col gap-1 text-sm">
                {property.owner_landlord_phone ? (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-700">{property.owner_landlord_phone}</span>
                    <a href={`tel:${property.owner_landlord_phone}`} className="text-xs font-semibold text-blue-700 hover:underline">
                      Call
                    </a>
                    <a href={`sms:${property.owner_landlord_phone}`} className="text-xs font-semibold text-blue-700 hover:underline">
                      SMS
                    </a>
                  </div>
                ) : null}
                {property.owner_landlord_email ? (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-700">{property.owner_landlord_email}</span>
                    <a href={`mailto:${property.owner_landlord_email}`} className="text-xs font-semibold text-blue-700 hover:underline">
                      Email
                    </a>
                  </div>
                ) : null}
                {!property.owner_landlord_name && !property.owner_landlord_phone && !property.owner_landlord_email ? (
                  <p className="text-gray-500">Not on file</p>
                ) : null}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-6">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Tenant Contact</h2>
              {property.tenant_name ? <p className="text-sm font-semibold text-gray-900">{property.tenant_name}</p> : null}
              <div className="mt-1 flex flex-col gap-1 text-sm">
                {property.tenant_phone ? (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-700">{property.tenant_phone}</span>
                    <a href={`tel:${property.tenant_phone}`} className="text-xs font-semibold text-blue-700 hover:underline">
                      Call
                    </a>
                    <a href={`sms:${property.tenant_phone}`} className="text-xs font-semibold text-blue-700 hover:underline">
                      SMS
                    </a>
                  </div>
                ) : null}
                {property.tenant_email ? (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-700">{property.tenant_email}</span>
                    <a href={`mailto:${property.tenant_email}`} className="text-xs font-semibold text-blue-700 hover:underline">
                      Email
                    </a>
                  </div>
                ) : null}
                {!property.tenant_phone && !property.tenant_email ? <p className="text-gray-500">Not on file</p> : null}
              </div>
            </div>
            <div className="col-span-2 rounded-lg border border-gray-200 bg-white p-6">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Access Notes</h2>
              <p className="whitespace-pre-wrap text-sm text-gray-700">{property.access_notes || "No access notes on file."}</p>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "assets" ? (
        <div>
          <div className="mb-4 flex justify-end">
            <button
              onClick={openNewAsset}
              className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"
            >
              + Add Asset
            </button>
          </div>
          {!assets || assets.length === 0 ? (
            <p className="text-sm text-gray-500">No assets recorded for this property yet.</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              {assets.map((asset) => (
                <button
                  key={asset.id}
                  onClick={() => openEditAsset(asset)}
                  className="rounded-lg border border-gray-200 bg-white p-4 text-left hover:border-blue-300"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-xl">{CATEGORY_ICON[asset.category]}</span>
                    <span className="font-bold text-gray-900">{asset.asset_name}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {asset.attributes.warranty_expiry_date ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          isWarrantyActive(asset.attributes.warranty_expiry_date)
                            ? "bg-green-100 text-green-800"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {isWarrantyActive(asset.attributes.warranty_expiry_date) ? "Under warranty" : "Warranty expired"}
                      </span>
                    ) : null}
                    {asset.attributes.roof_type ? (
                      <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-800">
                        {asset.attributes.roof_type}
                      </span>
                    ) : null}
                    {asset.attributes.gutter_clean_interval_months ? (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
                        Gutter clean every {asset.attributes.gutter_clean_interval_months}mo
                      </span>
                    ) : null}
                    {asset.attributes.fuel_type ? (
                      <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-800">
                        {asset.attributes.fuel_type}
                      </span>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {tab === "history" ? (
        <div>
          {!jobs || jobs.length === 0 ? (
            <p className="text-sm text-gray-500">No jobs recorded for this property yet.</p>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => (
                <div key={job.id} className="rounded-lg border border-gray-200 bg-white p-4">
                  <div className="flex items-center justify-between">
                    <Link to={`/jobs/${job.id}`} className="font-semibold text-blue-700 hover:underline">
                      {job.number ?? "Pending"} - {job.title}
                    </Link>
                    <span className="text-xs text-gray-400">{new Date(job.created_at).toLocaleDateString("en-AU")}</span>
                  </div>
                  {(quotesByJob.get(job.id) ?? []).length > 0 || (invoicesByJob.get(job.id) ?? []).length > 0 ? (
                    <div className="mt-2 space-y-1 text-sm">
                      {(quotesByJob.get(job.id) ?? []).map((q) => (
                        <Link key={q.id} to={`/quotes/${q.id}`} className="flex justify-between hover:underline">
                          <span className="text-gray-700">Quote {q.quote_number}</span>
                          <span className="text-gray-500">{formatCentsAsAud(q.total_cents)}</span>
                        </Link>
                      ))}
                      {(invoicesByJob.get(job.id) ?? []).map((inv) => (
                        <Link key={inv.id} to={`/invoices/${inv.id}`} className="flex justify-between hover:underline">
                          <span className="text-gray-700">Invoice {inv.invoice_number}</span>
                          <span className="text-gray-500">{formatCentsAsAud(inv.total_cents)}</span>
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <Modal open={assetModalOpen} onClose={() => setAssetModalOpen(false)} title={editingAsset ? "Edit asset" : "New asset"}>
        <SelectField label="Category" value={assetCategory} onChange={setAssetCategory} options={ASSET_CATEGORY_OPTIONS} placeholder="Select category" />
        <FormField label="Asset name" value={assetName} onChange={(e) => setAssetName(e.target.value)} placeholder="e.g. Main Hot Water Unit" />

        {assetCategory === "plumbing" ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Brand" value={attrs.brand ?? ""} onChange={(e) => setAttrs({ ...attrs, brand: e.target.value })} />
              <FormField label="Model" value={attrs.model ?? ""} onChange={(e) => setAttrs({ ...attrs, model: e.target.value })} />
            </div>
            <FormField
              label="Serial number"
              value={attrs.serial_number ?? ""}
              onChange={(e) => setAttrs({ ...attrs, serial_number: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label="Fuel type"
                value={attrs.fuel_type ?? ""}
                onChange={(v) => setAttrs({ ...attrs, fuel_type: v || undefined })}
                options={[
                  { value: "gas", label: "Gas" },
                  { value: "electric", label: "Electric" },
                  { value: "solar", label: "Solar" },
                ]}
              />
              <FormField
                label="Capacity (litres)"
                type="number"
                value={attrs.capacity_litres ?? ""}
                onChange={(e) => setAttrs({ ...attrs, capacity_litres: e.target.value ? Number(e.target.value) : undefined })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField
                label="Installation date"
                type="date"
                value={attrs.installation_date ?? ""}
                onChange={(e) => setAttrs({ ...attrs, installation_date: e.target.value || undefined })}
              />
              <FormField
                label="Warranty expiry"
                type="date"
                value={attrs.warranty_expiry_date ?? ""}
                onChange={(e) => setAttrs({ ...attrs, warranty_expiry_date: e.target.value || undefined })}
              />
            </div>
          </>
        ) : null}

        {assetCategory === "roofing" ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label="Roof type"
                value={attrs.roof_type ?? ""}
                onChange={(v) => setAttrs({ ...attrs, roof_type: v || undefined })}
                options={[
                  { value: "colorbond", label: "Colorbond" },
                  { value: "tile", label: "Tile" },
                  { value: "slate", label: "Slate" },
                ]}
              />
              <FormField
                label="Roof age (years)"
                type="number"
                value={attrs.roof_age_years ?? ""}
                onChange={(e) => setAttrs({ ...attrs, roof_age_years: e.target.value ? Number(e.target.value) : undefined })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField
                label="Last gutter clean"
                type="date"
                value={attrs.last_gutter_clean_date ?? ""}
                onChange={(e) => setAttrs({ ...attrs, last_gutter_clean_date: e.target.value || undefined })}
              />
              <FormField
                label="Clean interval (months)"
                type="number"
                value={attrs.gutter_clean_interval_months ?? ""}
                onChange={(e) =>
                  setAttrs({ ...attrs, gutter_clean_interval_months: e.target.value ? Number(e.target.value) : undefined })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField
                label="Screw condition"
                value={attrs.screw_condition ?? ""}
                onChange={(e) => setAttrs({ ...attrs, screw_condition: e.target.value || undefined })}
              />
              <FormField
                label="Ridge condition"
                value={attrs.ridge_condition ?? ""}
                onChange={(e) => setAttrs({ ...attrs, ridge_condition: e.target.value || undefined })}
              />
            </div>
          </>
        ) : null}

        {assetCategory === "hvac" || assetCategory === "general" ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Brand" value={attrs.brand ?? ""} onChange={(e) => setAttrs({ ...attrs, brand: e.target.value })} />
              <FormField label="Model" value={attrs.model ?? ""} onChange={(e) => setAttrs({ ...attrs, model: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField
                label="Installation date"
                type="date"
                value={attrs.installation_date ?? ""}
                onChange={(e) => setAttrs({ ...attrs, installation_date: e.target.value || undefined })}
              />
              <FormField
                label="Warranty expiry"
                type="date"
                value={attrs.warranty_expiry_date ?? ""}
                onChange={(e) => setAttrs({ ...attrs, warranty_expiry_date: e.target.value || undefined })}
              />
            </div>
          </>
        ) : null}

        {assetError ? <p className="mb-4 text-sm text-red-600">{assetError}</p> : null}
        <div className="flex items-center justify-between gap-3">
          {editingAsset ? (
            <button
              onClick={() => {
                if (window.confirm(`Delete "${editingAsset.asset_name}"?`)) {
                  deleteAsset.mutate(editingAsset);
                  setAssetModalOpen(false);
                }
              }}
              className="text-sm font-semibold text-red-600 hover:underline"
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-3">
            <button onClick={() => setAssetModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
              Cancel
            </button>
            <button
              onClick={() => saveAsset.mutate()}
              disabled={saveAsset.isPending || !assetName.trim()}
              className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {saveAsset.isPending ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={contactModalOpen} onClose={() => setContactModalOpen(false)} title="Edit access & contacts">
        <FormField label="Owner / landlord name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Landlord mobile" value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} />
          <FormField label="Landlord email" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
        </div>
        <FormField label="Tenant name" value={tenantName} onChange={(e) => setTenantName(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Tenant mobile" value={tenantPhone} onChange={(e) => setTenantPhone(e.target.value)} />
          <FormField label="Tenant email" type="email" value={tenantEmail} onChange={(e) => setTenantEmail(e.target.value)} />
        </div>
        <FormField label="Key tag number" value={keyTagNumber} onChange={(e) => setKeyTagNumber(e.target.value)} placeholder="e.g. Key #42" />
        <TextAreaField label="Access notes" value={accessNotes} onChange={(e) => setAccessNotes(e.target.value)} placeholder="Gate codes, alarm codes, pet warnings, parking..." />

        {contactError ? <p className="mb-4 text-sm text-red-600">{contactError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setContactModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveContact.mutate()}
            disabled={saveContact.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveContact.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

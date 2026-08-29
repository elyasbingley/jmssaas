import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  createJobCardSchema,
  createPropertyAssetSchema,
  createPropertyTenantSchema,
  formatCentsAsAud,
  updatePropertyContactSchema,
  updatePropertyDetailsSchema,
  type Agency,
  type Client,
  type Invoice,
  type JobCard,
  type Property,
  type PropertyAsset,
  type PropertyAssetAttributes,
  type PropertyAssetCategory,
  type PropertyManager,
  type PropertyTenant,
  type PropertyType,
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
async function fetchAllAgencies(): Promise<Agency[]> {
  const { data, error } = await supabase.from("agencies").select("*").order("name");
  if (error) throw error;
  return data as Agency[];
}
async function fetchAllPropertyManagers(): Promise<PropertyManager[]> {
  const { data, error } = await supabase.from("property_managers").select("*").order("first_name");
  if (error) throw error;
  return data as PropertyManager[];
}
async function fetchAllClients(): Promise<Client[]> {
  const { data, error } = await supabase.from("clients").select("*").order("name");
  if (error) throw error;
  return data as Client[];
}
async function fetchPropertyTenants(propertyId: string): Promise<PropertyTenant[]> {
  const { data, error } = await supabase.from("property_tenants").select("*").eq("property_id", propertyId).order("name");
  if (error) throw error;
  return data as PropertyTenant[];
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

const PROPERTY_TYPE_OPTIONS: { value: PropertyType; label: string }[] = [
  { value: "residential", label: "Residential" },
  { value: "commercial", label: "Commercial" },
  { value: "strata_common_property", label: "Strata Common Property" },
  { value: "strata_lot", label: "Strata Lot" },
];

function isWarrantyActive(warrantyExpiryDate?: string): boolean {
  if (!warrantyExpiryDate) return false;
  return new Date(warrantyExpiryDate).getTime() > Date.now();
}

type ProfileTab = "access" | "assets" | "history";

export default function PropertyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
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
  const { data: allAgencies } = useQuery({ queryKey: ["agencies"], queryFn: fetchAllAgencies });
  const { data: allPropertyManagers } = useQuery({ queryKey: ["property-managers"], queryFn: fetchAllPropertyManagers });
  const { data: allClients } = useQuery({ queryKey: ["clients"], queryFn: fetchAllClients });
  const { data: assets } = useQuery({ queryKey: ["property-assets", id], queryFn: () => fetchAssets(id!), enabled: !!id });
  const { data: additionalTenants } = useQuery({
    queryKey: ["property-tenants", id],
    queryFn: () => fetchPropertyTenants(id!),
    enabled: !!id,
  });
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

  // --- Additional tenants (beyond the single tenant_name/phone/email above -
  // for share houses / multi-occupant properties) ---
  const [tenantModalOpen, setTenantModalOpen] = useState(false);
  const [editingTenantId, setEditingTenantId] = useState<string | null>(null);
  const [tenantForm, setTenantForm] = useState({ name: "", phone: "", email: "" });
  const [tenantError, setTenantError] = useState<string | null>(null);

  const openNewTenant = () => {
    setEditingTenantId(null);
    setTenantForm({ name: "", phone: "", email: "" });
    setTenantError(null);
    setTenantModalOpen(true);
  };
  const openEditTenant = (tenant: PropertyTenant) => {
    setEditingTenantId(tenant.id);
    setTenantForm({ name: tenant.name, phone: tenant.phone ?? "", email: tenant.email ?? "" });
    setTenantError(null);
    setTenantModalOpen(true);
  };

  const saveTenant = useMutation({
    mutationFn: async () => {
      const result = createPropertyTenantSchema.safeParse({ ...tenantForm, property_id: id });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid tenant");
      if (!profile) throw new Error("Not signed in");
      const payload = { name: result.data.name, phone: result.data.phone || null, email: result.data.email || null };
      if (editingTenantId) {
        const { error } = await supabase.from("property_tenants").update(payload).eq("id", editingTenantId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("property_tenants").insert({ tenant_id: profile.tenant_id, property_id: id, ...payload });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["property-tenants", id] });
      setTenantModalOpen(false);
      setEditingTenantId(null);
    },
    onError: (e) => setTenantError(getErrorMessage(e, "Failed to save tenant")),
  });

  const deleteTenant = useMutation({
    mutationFn: async (tenantId: string) => {
      const { error } = await supabase.from("property_tenants").delete().eq("id", tenantId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["property-tenants", id] }),
  });

  // --- Edit Property Details (address/agency/PM/type) - previously only
  // ever settable once, at creation, in RealEstate.tsx's "New managed
  // property" form. ---
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);
  const [detailsAgencyId, setDetailsAgencyId] = useState("");
  const [detailsPmId, setDetailsPmId] = useState("");
  const [detailsAddress, setDetailsAddress] = useState("");
  const [detailsSuburb, setDetailsSuburb] = useState("");
  const [detailsState, setDetailsState] = useState("");
  const [detailsPostcode, setDetailsPostcode] = useState("");
  const [detailsPropertyType, setDetailsPropertyType] = useState<PropertyType | "">("residential");
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const openEditDetails = () => {
    if (!property) return;
    setDetailsAgencyId(property.agency_id);
    setDetailsPmId(property.property_manager_id ?? "");
    setDetailsAddress(property.address_line1);
    setDetailsSuburb(property.suburb);
    setDetailsState(property.state);
    setDetailsPostcode(property.postcode);
    setDetailsPropertyType(property.property_type);
    setDetailsError(null);
    setDetailsModalOpen(true);
  };

  const saveDetails = useMutation({
    mutationFn: async () => {
      const result = updatePropertyDetailsSchema.safeParse({
        agency_id: detailsAgencyId,
        property_manager_id: detailsPmId,
        address_line1: detailsAddress,
        suburb: detailsSuburb,
        state: detailsState,
        postcode: detailsPostcode,
        property_type: detailsPropertyType || "residential",
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid details");

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
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["property", id] });
      queryClient.invalidateQueries({ queryKey: ["properties"] });
      setDetailsModalOpen(false);
    },
    onError: (e) => setDetailsError(getErrorMessage(e, "Failed to save property details")),
  });

  const detailsPmsForAgency = (agencyId: string) => (allPropertyManagers ?? []).filter((pm) => pm.agency_id === agencyId);

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

  // --- New job, started from the property itself instead of Jobs.tsx -
  // property/agency/PM are locked to this property, and client_id is
  // derived from the agency's linked billing client automatically (falling
  // back to a manual pick only if that agency has no linked client yet).
  // This is the other half of removing the "create a client card, then
  // separately create the same thing again in Real Estate" double handling.
  const [newJobModalOpen, setNewJobModalOpen] = useState(false);
  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [jobWorkOrderNumber, setJobWorkOrderNumber] = useState("");
  const [jobManualClientId, setJobManualClientId] = useState("");
  const [jobError, setJobError] = useState<string | null>(null);

  const openNewJob = () => {
    setJobTitle("");
    setJobDescription("");
    setJobWorkOrderNumber("");
    setJobManualClientId("");
    setJobError(null);
    setNewJobModalOpen(true);
  };

  const createJob = useMutation({
    mutationFn: async () => {
      if (!property) throw new Error("Property not loaded");
      const clientId = agency?.client_id || jobManualClientId;
      if (!clientId) throw new Error("Pick a client to bill this job against");
      const result = createJobCardSchema.safeParse({
        client_id: clientId,
        title: jobTitle,
        description: jobDescription,
        is_real_estate_job: true,
        agency_id: property.agency_id,
        property_manager_id: property.property_manager_id ?? undefined,
        property_id: property.id,
        work_order_number: jobWorkOrderNumber || undefined,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid job");
      if (!profile) throw new Error("Not signed in");

      const { data, error } = await supabase
        .from("job_cards")
        .insert({
          tenant_id: profile.tenant_id,
          client_id: result.data.client_id,
          title: result.data.title,
          description: result.data.description || null,
          is_real_estate_job: true,
          agency_id: result.data.agency_id,
          property_manager_id: result.data.property_manager_id ?? null,
          property_id: result.data.property_id,
          work_order_number: result.data.work_order_number ?? null,
          created_by: profile.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data as JobCard;
    },
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ["property-jobs", id] });
      navigate(`/jobs/${job.id}`);
    },
    onError: (e) => setJobError(getErrorMessage(e, "Failed to create job")),
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

      <div className="mb-6 rounded-lg border border-gray-300 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
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
          <button
            onClick={openEditDetails}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Edit property
          </button>
        </div>
      </div>

      <div className="mb-6 flex gap-1 border-b border-gray-300">
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
            <div className="rounded-lg border border-gray-300 bg-white p-6">
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
            <div className="rounded-lg border border-gray-300 bg-white p-6">
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
            <div className="col-span-2 rounded-lg border border-gray-300 bg-white p-6">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Additional Tenants</h2>
                <button onClick={openNewTenant} className="text-xs font-semibold text-blue-700 hover:underline">
                  + Add tenant
                </button>
              </div>
              {!additionalTenants || additionalTenants.length === 0 ? (
                <p className="text-sm text-gray-500">No additional tenants on file.</p>
              ) : (
                <div className="space-y-2">
                  {additionalTenants.map((tenant) => (
                    <div key={tenant.id} className="flex items-start justify-between rounded-md bg-gray-50 p-2">
                      <div className="text-sm">
                        <p className="font-semibold text-gray-900">{tenant.name}</p>
                        {tenant.phone ? <p className="text-xs text-gray-600">{tenant.phone}</p> : null}
                        {tenant.email ? <p className="text-xs text-gray-600">{tenant.email}</p> : null}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button onClick={() => openEditTenant(tenant)} className="text-xs font-semibold text-blue-700 hover:underline">
                          Edit
                        </button>
                        <button onClick={() => deleteTenant.mutate(tenant.id)} className="text-xs font-semibold text-red-600 hover:underline">
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="col-span-2 rounded-lg border border-gray-300 bg-white p-6">
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
                  className="rounded-lg border border-gray-300 bg-white p-4 text-left hover:border-blue-300"
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
          <div className="mb-4 flex justify-end">
            <button
              onClick={openNewJob}
              className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"
            >
              + New Job
            </button>
          </div>
          {!jobs || jobs.length === 0 ? (
            <p className="text-sm text-gray-500">No jobs recorded for this property yet.</p>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => (
                <div key={job.id} className="rounded-lg border border-gray-300 bg-white p-4">
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

      <Modal open={newJobModalOpen} onClose={() => setNewJobModalOpen(false)} title="New job for this property">
        <div className="mb-4 rounded-md bg-gray-50 p-3 text-sm">
          <p className="font-semibold text-gray-900">{property.address_line1}</p>
          <p className="text-gray-600">
            {agency?.name}
            {propertyManager ? ` - ${propertyManager.first_name} ${propertyManager.last_name}` : ""}
          </p>
        </div>
        {agency?.client_id ? (
          <p className="-mt-2 mb-4 text-xs text-gray-500">This job will bill against {agency.name}'s linked client automatically.</p>
        ) : (
          <SelectField
            label="Client to bill (this agency has no linked client yet)"
            value={jobManualClientId}
            onChange={setJobManualClientId}
            options={(allClients ?? []).map((c) => ({ value: c.id, label: c.company_name || c.name }))}
            placeholder="Select a client"
          />
        )}
        <FormField label="Title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
        <TextAreaField label="Description" rows={3} value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} />
        {agency?.require_work_order_num ? (
          <FormField label="Work order number" value={jobWorkOrderNumber} onChange={(e) => setJobWorkOrderNumber(e.target.value)} />
        ) : null}
        {jobError ? <p className="mb-4 text-sm text-red-600">{jobError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setNewJobModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createJob.mutate()}
            disabled={createJob.isPending || !jobTitle.trim() || (!agency?.client_id && !jobManualClientId)}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createJob.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal
        open={tenantModalOpen}
        onClose={() => {
          setTenantModalOpen(false);
          setEditingTenantId(null);
        }}
        title={editingTenantId ? "Edit tenant" : "Add tenant"}
      >
        <FormField label="Name" value={tenantForm.name} onChange={(e) => setTenantForm({ ...tenantForm, name: e.target.value })} />
        <FormField label="Phone" value={tenantForm.phone} onChange={(e) => setTenantForm({ ...tenantForm, phone: e.target.value })} />
        <FormField
          label="Email"
          type="email"
          value={tenantForm.email}
          onChange={(e) => setTenantForm({ ...tenantForm, email: e.target.value })}
        />
        {tenantError ? <p className="mb-4 text-sm text-red-600">{tenantError}</p> : null}
        <div className="flex justify-end gap-3">
          <button
            onClick={() => {
              setTenantModalOpen(false);
              setEditingTenantId(null);
            }}
            className="px-4 py-2 text-sm font-semibold text-gray-600"
          >
            Cancel
          </button>
          <button
            onClick={() => saveTenant.mutate()}
            disabled={saveTenant.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveTenant.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal open={detailsModalOpen} onClose={() => setDetailsModalOpen(false)} title="Edit property details">
        <SelectField
          label="Agency"
          value={detailsAgencyId}
          onChange={(v) => {
            setDetailsAgencyId(v);
            setDetailsPmId("");
          }}
          options={(allAgencies ?? []).map((a) => ({ value: a.id, label: a.name }))}
          placeholder="Select agency"
        />
        <SelectField
          label="Property manager"
          value={detailsPmId}
          onChange={setDetailsPmId}
          options={detailsPmsForAgency(detailsAgencyId).map((pm) => ({ value: pm.id, label: `${pm.first_name} ${pm.last_name}` }))}
          placeholder="Unassigned"
        />
        <FormField label="Address line 1" value={detailsAddress} onChange={(e) => setDetailsAddress(e.target.value)} />
        <div className="grid grid-cols-3 gap-3">
          <FormField label="Suburb" value={detailsSuburb} onChange={(e) => setDetailsSuburb(e.target.value)} />
          <FormField label="State" value={detailsState} onChange={(e) => setDetailsState(e.target.value)} />
          <FormField label="Postcode" value={detailsPostcode} onChange={(e) => setDetailsPostcode(e.target.value)} />
        </div>
        <SelectField
          label="Property type"
          value={detailsPropertyType}
          onChange={setDetailsPropertyType}
          options={PROPERTY_TYPE_OPTIONS}
          placeholder="Select type"
        />

        {detailsError ? <p className="mb-4 text-sm text-red-600">{detailsError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setDetailsModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveDetails.mutate()}
            disabled={saveDetails.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveDetails.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

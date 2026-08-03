import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
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
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField, SelectField } from "../components/FormField";
import { KeyManagementDashboard } from "../components/KeyManagementDashboard";

// The four sub-tabs from the spec live under a single sidebar destination
// (/real-estate) rather than as four separate sidebar links - Directory and
// Key Management are in-page tabs here (Recurring Maintenance Engine is a
// third, added in a later batch); Property Profile & Asset Register isn't a
// list-type tab at all (the spec's own wording is "when a property is
// selected") so it's a drill-down route instead, same relationship Jobs/
// JobDetail or Quotes/QuoteDetail already have.

async function fetchAgencies(): Promise<Agency[]> {
  const { data, error } = await supabase.from("agencies").select("*").order("name");
  if (error) throw error;
  return data as Agency[];
}
async function fetchPropertyManagers(): Promise<PropertyManager[]> {
  const { data, error } = await supabase.from("property_managers").select("*").order("first_name");
  if (error) throw error;
  return data as PropertyManager[];
}
async function fetchProperties(): Promise<Property[]> {
  const { data, error } = await supabase.from("properties").select("*").order("suburb").order("address_line1");
  if (error) throw error;
  return data as Property[];
}

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

type SubTab = "directory" | "keys";

export default function RealEstatePage() {
  const [tab, setTab] = useState<SubTab>("directory");

  return (
    <div className="p-8">
      <h1 className="mb-1 text-xl font-bold text-gray-900">Real Estate & Strata</h1>
      <p className="mb-6 text-sm text-gray-500">Agencies, property managers, managed properties, and key tracking.</p>

      <div className="mb-6 flex gap-1 border-b border-gray-200">
        {(
          [
            { key: "directory", label: "Directory" },
            { key: "keys", label: "Key Management" },
          ] as { key: SubTab; label: string }[]
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

      {tab === "directory" ? <DirectoryTab /> : <KeyManagementDashboard />}
    </div>
  );
}

function DirectoryTab() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: agencies } = useQuery({ queryKey: ["agencies"], queryFn: fetchAgencies });
  const { data: propertyManagers } = useQuery({ queryKey: ["property-managers"], queryFn: fetchPropertyManagers });
  const { data: properties } = useQuery({ queryKey: ["properties"], queryFn: fetchProperties });

  const [expandedAgencyIds, setExpandedAgencyIds] = useState<Set<string>>(new Set());
  const [selectedPmId, setSelectedPmId] = useState<string | null>(null);
  const toggleAgency = (id: string) => {
    setExpandedAgencyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // --- Add Agency ---
  const [agencyModalOpen, setAgencyModalOpen] = useState(false);
  const [agencyName, setAgencyName] = useState("");
  const [agencyType, setAgencyType] = useState<AgencyType | "">("real_estate");
  const [agencyBillingEmail, setAgencyBillingEmail] = useState("");
  const [agencyPhone, setAgencyPhone] = useState("");
  const [agencyRequireWorkOrder, setAgencyRequireWorkOrder] = useState(true);
  const [agencyError, setAgencyError] = useState<string | null>(null);

  const openNewAgency = () => {
    setAgencyName("");
    setAgencyType("real_estate");
    setAgencyBillingEmail("");
    setAgencyPhone("");
    setAgencyRequireWorkOrder(true);
    setAgencyError(null);
    setAgencyModalOpen(true);
  };

  const createAgency = useMutation({
    mutationFn: async () => {
      const result = createAgencySchema.safeParse({
        name: agencyName,
        type: agencyType || "real_estate",
        billing_email: agencyBillingEmail,
        phone: agencyPhone,
        require_work_order_num: agencyRequireWorkOrder,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid agency");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("agencies").insert({
        tenant_id: profile.tenant_id,
        name: result.data.name,
        type: result.data.type,
        billing_email: result.data.billing_email || null,
        phone: result.data.phone || null,
        payment_terms_days: result.data.payment_terms_days,
        require_work_order_num: result.data.require_work_order_num,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agencies"] });
      setAgencyModalOpen(false);
    },
    onError: (e) => setAgencyError(getErrorMessage(e, "Failed to create agency")),
  });

  // --- Add Property Manager ---
  const [pmModalOpen, setPmModalOpen] = useState(false);
  const [pmAgencyId, setPmAgencyId] = useState("");
  const [pmFirstName, setPmFirstName] = useState("");
  const [pmLastName, setPmLastName] = useState("");
  const [pmEmail, setPmEmail] = useState("");
  const [pmMobile, setPmMobile] = useState("");
  const [pmError, setPmError] = useState<string | null>(null);

  const openNewPm = (agencyId?: string) => {
    setPmAgencyId(agencyId ?? "");
    setPmFirstName("");
    setPmLastName("");
    setPmEmail("");
    setPmMobile("");
    setPmError(null);
    setPmModalOpen(true);
  };

  const createPm = useMutation({
    mutationFn: async () => {
      const result = createPropertyManagerSchema.safeParse({
        agency_id: pmAgencyId,
        first_name: pmFirstName,
        last_name: pmLastName,
        email: pmEmail,
        mobile: pmMobile,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid property manager");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("property_managers").insert({
        tenant_id: profile.tenant_id,
        agency_id: result.data.agency_id,
        first_name: result.data.first_name,
        last_name: result.data.last_name,
        email: result.data.email || null,
        mobile: result.data.mobile || null,
        work_phone: result.data.work_phone || null,
        notes: result.data.notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["property-managers"] });
      setPmModalOpen(false);
    },
    onError: (e) => setPmError(getErrorMessage(e, "Failed to create property manager")),
  });

  // --- Add Managed Property ---
  const [propertyModalOpen, setPropertyModalOpen] = useState(false);
  const [propAgencyId, setPropAgencyId] = useState("");
  const [propPmId, setPropPmId] = useState("");
  const [propAddress, setPropAddress] = useState("");
  const [propSuburb, setPropSuburb] = useState("");
  const [propState, setPropState] = useState("");
  const [propPostcode, setPropPostcode] = useState("");
  const [propType, setPropType] = useState<PropertyType | "">("residential");
  const [propOwnerName, setPropOwnerName] = useState("");
  const [propKeyTag, setPropKeyTag] = useState("");
  const [propError, setPropError] = useState<string | null>(null);

  const openNewProperty = (agencyId?: string, pmId?: string) => {
    setPropAgencyId(agencyId ?? "");
    setPropPmId(pmId ?? "");
    setPropAddress("");
    setPropSuburb("");
    setPropState("");
    setPropPostcode("");
    setPropType("residential");
    setPropOwnerName("");
    setPropKeyTag("");
    setPropError(null);
    setPropertyModalOpen(true);
  };

  const createProperty = useMutation({
    mutationFn: async () => {
      const result = createPropertySchema.safeParse({
        agency_id: propAgencyId,
        property_manager_id: propPmId,
        address_line1: propAddress,
        suburb: propSuburb,
        state: propState,
        postcode: propPostcode,
        property_type: propType || "residential",
        owner_landlord_name: propOwnerName,
        key_tag_number: propKeyTag,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid property");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("properties").insert({
        tenant_id: profile.tenant_id,
        agency_id: result.data.agency_id,
        property_manager_id: result.data.property_manager_id || null,
        address_line1: result.data.address_line1,
        suburb: result.data.suburb,
        state: result.data.state,
        postcode: result.data.postcode,
        property_type: result.data.property_type,
        owner_landlord_name: result.data.owner_landlord_name || null,
        key_tag_number: result.data.key_tag_number || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["properties"] });
      setPropertyModalOpen(false);
    },
    onError: (e) => setPropError(getErrorMessage(e, "Failed to create property")),
  });

  const pmsByAgency = (agencyId: string) => (propertyManagers ?? []).filter((pm) => pm.agency_id === agencyId);
  const propertiesByPm = (pmId: string) =>
    (properties ?? []).filter((p) => p.property_manager_id === pmId).sort((a, b) => a.suburb.localeCompare(b.suburb));

  return (
    <div>
      <div className="mb-4 flex justify-end gap-2">
        <button
          onClick={() => openNewProperty()}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          + Add Managed Property
        </button>
        <button
          onClick={() => openNewPm()}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          + Add Property Manager
        </button>
        <button
          onClick={openNewAgency}
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + Add Agency
        </button>
      </div>

      {!agencies || agencies.length === 0 ? (
        <p className="text-sm text-gray-500">No agencies yet.</p>
      ) : (
        <div className="space-y-3">
          {agencies.map((agency) => {
            const expanded = expandedAgencyIds.has(agency.id);
            const pms = pmsByAgency(agency.id);
            return (
              <div key={agency.id} className="rounded-lg border border-gray-200 bg-white">
                <button
                  onClick={() => toggleAgency(agency.id)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-400">{expanded ? "▾" : "▸"}</span>
                    <span className="font-bold text-gray-900">{agency.name}</span>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                      {agency.type === "strata" ? "Strata" : "Real Estate"}
                    </span>
                  </div>
                  <span className="text-xs text-gray-400">
                    {pms.length} PM{pms.length === 1 ? "" : "s"}
                  </span>
                </button>
                {expanded ? (
                  <div className="border-t border-gray-100 px-4 py-3">
                    {pms.length === 0 ? (
                      <p className="text-sm text-gray-500">No property managers yet for this agency.</p>
                    ) : (
                      <div className="space-y-1">
                        {pms.map((pm) => (
                          <div key={pm.id}>
                            <button
                              onClick={() => setSelectedPmId(selectedPmId === pm.id ? null : pm.id)}
                              className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${
                                selectedPmId === pm.id ? "bg-blue-50" : "hover:bg-gray-50"
                              }`}
                            >
                              <span className="font-medium text-gray-900">
                                {pm.first_name} {pm.last_name}
                              </span>
                              <span className="text-xs text-gray-500">{pm.email ?? pm.mobile ?? ""}</span>
                            </button>
                            {selectedPmId === pm.id ? (
                              <div className="ml-6 mb-2 mt-1 space-y-1 border-l border-gray-100 pl-4">
                                {propertiesByPm(pm.id).length === 0 ? (
                                  <p className="py-1 text-xs text-gray-500">No managed properties for this PM yet.</p>
                                ) : (
                                  propertiesByPm(pm.id).map((property) => (
                                    <Link
                                      key={property.id}
                                      to={`/real-estate/properties/${property.id}`}
                                      className="flex justify-between rounded-md px-2 py-1 text-sm hover:bg-gray-50"
                                    >
                                      <span className="text-blue-700">{property.address_line1}</span>
                                      <span className="text-gray-500">{property.suburb}</span>
                                    </Link>
                                  ))
                                )}
                                <button
                                  onClick={() => openNewProperty(agency.id, pm.id)}
                                  className="mt-1 text-xs font-semibold text-blue-700 hover:underline"
                                >
                                  + Add property for this PM
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => openNewPm(agency.id)}
                      className="mt-2 text-xs font-semibold text-blue-700 hover:underline"
                    >
                      + Add property manager to {agency.name}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <Modal open={agencyModalOpen} onClose={() => setAgencyModalOpen(false)} title="New agency">
        <FormField label="Name" value={agencyName} onChange={(e) => setAgencyName(e.target.value)} placeholder="e.g. McGrath Estate Agents" />
        <SelectField label="Type" value={agencyType} onChange={setAgencyType} options={AGENCY_TYPE_OPTIONS} placeholder="Select type" />
        <FormField label="Billing email" type="email" value={agencyBillingEmail} onChange={(e) => setAgencyBillingEmail(e.target.value)} />
        <FormField label="Phone" value={agencyPhone} onChange={(e) => setAgencyPhone(e.target.value)} />
        <label className="mb-4 flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={agencyRequireWorkOrder}
            onChange={(e) => setAgencyRequireWorkOrder(e.target.checked)}
          />
          Require a work order number on every invoice
        </label>
        {agencyError ? <p className="mb-4 text-sm text-red-600">{agencyError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setAgencyModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createAgency.mutate()}
            disabled={createAgency.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createAgency.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal open={pmModalOpen} onClose={() => setPmModalOpen(false)} title="New property manager">
        <SelectField
          label="Agency"
          value={pmAgencyId}
          onChange={setPmAgencyId}
          options={(agencies ?? []).map((a) => ({ value: a.id, label: a.name }))}
          placeholder="Select agency"
        />
        <FormField label="First name" value={pmFirstName} onChange={(e) => setPmFirstName(e.target.value)} />
        <FormField label="Last name" value={pmLastName} onChange={(e) => setPmLastName(e.target.value)} />
        <FormField label="Email" type="email" value={pmEmail} onChange={(e) => setPmEmail(e.target.value)} />
        <FormField label="Mobile" value={pmMobile} onChange={(e) => setPmMobile(e.target.value)} />
        {pmError ? <p className="mb-4 text-sm text-red-600">{pmError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setPmModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createPm.mutate()}
            disabled={createPm.isPending || !pmAgencyId}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createPm.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal open={propertyModalOpen} onClose={() => setPropertyModalOpen(false)} title="New managed property">
        <SelectField
          label="Agency"
          value={propAgencyId}
          onChange={(v) => {
            setPropAgencyId(v);
            setPropPmId("");
          }}
          options={(agencies ?? []).map((a) => ({ value: a.id, label: a.name }))}
          placeholder="Select agency"
        />
        <SelectField
          label="Property manager"
          value={propPmId}
          onChange={setPropPmId}
          options={pmsByAgency(propAgencyId).map((pm) => ({ value: pm.id, label: `${pm.first_name} ${pm.last_name}` }))}
          placeholder="Unassigned"
        />
        <FormField label="Address line 1" value={propAddress} onChange={(e) => setPropAddress(e.target.value)} />
        <div className="grid grid-cols-3 gap-3">
          <FormField label="Suburb" value={propSuburb} onChange={(e) => setPropSuburb(e.target.value)} />
          <FormField label="State" value={propState} onChange={(e) => setPropState(e.target.value)} />
          <FormField label="Postcode" value={propPostcode} onChange={(e) => setPropPostcode(e.target.value)} />
        </div>
        <SelectField label="Property type" value={propType} onChange={setPropType} options={PROPERTY_TYPE_OPTIONS} placeholder="Select type" />
        <FormField label="Owner / landlord name" value={propOwnerName} onChange={(e) => setPropOwnerName(e.target.value)} />
        <FormField label="Key tag number" value={propKeyTag} onChange={(e) => setPropKeyTag(e.target.value)} placeholder="e.g. Key #42" />
        {propError ? <p className="mb-4 text-sm text-red-600">{propError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setPropertyModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createProperty.mutate()}
            disabled={createProperty.isPending || !propAgencyId}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createProperty.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

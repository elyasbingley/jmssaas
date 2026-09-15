import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  createAgencySchema,
  createClientSchema,
  createPropertyManagerSchema,
  createPropertySchema,
  type Agency,
  type AgencyType,
  type Client,
  type Property,
  type PropertyManager,
  type PropertyType,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedFormField, ThemedSelectField } from "../components/theme/ThemedFormField";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedBadge } from "../components/theme/ThemedBadge";
import { KeyManagementDashboard } from "../components/KeyManagementDashboard";
import { RecurringMaintenanceEngine } from "../components/RecurringMaintenanceEngine";

// The four sub-tabs from the spec live under a single sidebar destination
// (/real-estate) rather than as four separate sidebar links - Directory,
// Key Management, and Recurring Maintenance are in-page tabs here; Property
// Profile & Asset Register isn't a list-type tab at all (the spec's own
// wording is "when a property is selected") so it's a drill-down route
// instead, same relationship Jobs/JobDetail or Quotes/QuoteDetail already
// have.

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
async function fetchClients(): Promise<Client[]> {
  const { data, error } = await supabase.from("clients").select("*").order("name");
  if (error) throw error;
  return data as Client[];
}

// Sentinel for the agency's "billing client" picker - not a real client id,
// it means "create a new client automatically from this agency's name/
// billing email" rather than linking to one that already exists.
const AUTO_CREATE_CLIENT = "__auto__";

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

type SubTab = "directory" | "keys" | "maintenance";

export default function RealEstatePage() {
  const [tab, setTab] = useState<SubTab>("directory");

  return (
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <h1 className="mb-1 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Real Estate & Strata
      </h1>
      <p className="mb-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
        Agencies, property managers, managed properties, and key tracking.
      </p>

      <div className="mb-6 flex gap-1" style={{ borderBottom: "1px solid var(--jms-border)" }}>
        {(
          [
            { key: "directory", label: "Directory" },
            { key: "keys", label: "Key Management" },
            { key: "maintenance", label: "Recurring Maintenance" },
          ] as { key: SubTab; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="border-b-2 px-4 py-2 font-semibold uppercase tracking-wide"
            style={
              tab === t.key
                ? { borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                : { borderColor: "transparent", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "directory" ? <DirectoryTab /> : tab === "keys" ? <KeyManagementDashboard /> : <RecurringMaintenanceEngine />}
    </div>
  );
}

function DirectoryTab() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: agencies } = useQuery({ queryKey: ["agencies"], queryFn: fetchAgencies });
  const { data: propertyManagers } = useQuery({ queryKey: ["property-managers"], queryFn: fetchPropertyManagers });
  const { data: properties } = useQuery({ queryKey: ["properties"], queryFn: fetchProperties });
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: fetchClients });
  const clientById = new Map((clients ?? []).map((c) => [c.id, c]));

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

  // --- Add / Edit Agency ---
  // Deliberately no contact email/phone fields here - those are always
  // specific to a particular property manager at the agency (see
  // property_managers), not the agency as a whole. billing_email is the
  // exception: it's what an auto-created billing client (below) gets as its
  // email, so it lives on the agency itself.
  const [agencyModalOpen, setAgencyModalOpen] = useState(false);
  const [agencyEditId, setAgencyEditId] = useState<string | null>(null);
  const [agencyName, setAgencyName] = useState("");
  const [agencyType, setAgencyType] = useState<AgencyType | "">("real_estate");
  const [agencyBillingEmail, setAgencyBillingEmail] = useState("");
  const [agencyRequireWorkOrder, setAgencyRequireWorkOrder] = useState(true);
  const [agencyClientId, setAgencyClientId] = useState<string>(AUTO_CREATE_CLIENT);
  const [agencyError, setAgencyError] = useState<string | null>(null);

  const openNewAgency = () => {
    setAgencyEditId(null);
    setAgencyName("");
    setAgencyType("real_estate");
    setAgencyBillingEmail("");
    setAgencyRequireWorkOrder(true);
    setAgencyClientId(AUTO_CREATE_CLIENT);
    setAgencyError(null);
    setAgencyModalOpen(true);
  };

  const openEditAgency = (agency: Agency) => {
    setAgencyEditId(agency.id);
    setAgencyName(agency.name);
    setAgencyType(agency.type);
    setAgencyBillingEmail(agency.billing_email ?? "");
    setAgencyRequireWorkOrder(agency.require_work_order_num);
    setAgencyClientId(agency.client_id ?? AUTO_CREATE_CLIENT);
    setAgencyError(null);
    setAgencyModalOpen(true);
  };

  const saveAgency = useMutation({
    mutationFn: async () => {
      const result = createAgencySchema.safeParse({
        name: agencyName,
        type: agencyType || "real_estate",
        billing_email: agencyBillingEmail,
        require_work_order_num: agencyRequireWorkOrder,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid agency");
      if (!profile) throw new Error("Not signed in");

      // A linked client is created once per agency, the moment one doesn't
      // already exist to pick from - closes the "double handling" gap where
      // an agency and its billing client used to be two unrelated records
      // the user had to create separately.
      let clientId = agencyClientId;
      if (clientId === AUTO_CREATE_CLIENT) {
        const clientResult = createClientSchema.safeParse({
          client_type: "company",
          company_name: result.data.name,
          name: result.data.name,
          email: result.data.billing_email || "",
        });
        if (!clientResult.success) throw new Error(clientResult.error.issues[0]?.message ?? "Invalid client");
        const { data: newClient, error: clientError } = await supabase
          .from("clients")
          .insert({
            tenant_id: profile.tenant_id,
            client_type: clientResult.data.client_type,
            company_name: clientResult.data.company_name,
            name: clientResult.data.name,
            email: clientResult.data.email || null,
          })
          .select("id")
          .single();
        if (clientError) throw clientError;
        clientId = newClient.id as string;
      }

      const values = {
        name: result.data.name,
        type: result.data.type,
        billing_email: result.data.billing_email || null,
        require_work_order_num: result.data.require_work_order_num,
        client_id: clientId,
      };

      const { error } = agencyEditId
        ? await supabase.from("agencies").update(values).eq("id", agencyEditId)
        : await supabase.from("agencies").insert({ tenant_id: profile.tenant_id, ...values, payment_terms_days: result.data.payment_terms_days });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agencies"] });
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      setAgencyModalOpen(false);
    },
    onError: (e) => setAgencyError(getErrorMessage(e, agencyEditId ? "Failed to save agency" : "Failed to create agency")),
  });

  // --- Add / Edit Property Manager ---
  const [pmModalOpen, setPmModalOpen] = useState(false);
  const [pmEditId, setPmEditId] = useState<string | null>(null);
  const [pmAgencyId, setPmAgencyId] = useState("");
  const [pmFirstName, setPmFirstName] = useState("");
  const [pmLastName, setPmLastName] = useState("");
  const [pmEmail, setPmEmail] = useState("");
  const [pmMobile, setPmMobile] = useState("");
  const [pmError, setPmError] = useState<string | null>(null);

  const openNewPm = (agencyId?: string) => {
    setPmEditId(null);
    setPmAgencyId(agencyId ?? "");
    setPmFirstName("");
    setPmLastName("");
    setPmEmail("");
    setPmMobile("");
    setPmError(null);
    setPmModalOpen(true);
  };

  const openEditPm = (pm: PropertyManager) => {
    setPmEditId(pm.id);
    setPmAgencyId(pm.agency_id);
    setPmFirstName(pm.first_name);
    setPmLastName(pm.last_name);
    setPmEmail(pm.email ?? "");
    setPmMobile(pm.mobile ?? "");
    setPmError(null);
    setPmModalOpen(true);
  };

  const savePm = useMutation({
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

      const values = {
        agency_id: result.data.agency_id,
        first_name: result.data.first_name,
        last_name: result.data.last_name,
        email: result.data.email || null,
        mobile: result.data.mobile || null,
      };

      const { error } = pmEditId
        ? await supabase.from("property_managers").update(values).eq("id", pmEditId)
        : await supabase.from("property_managers").insert({
            tenant_id: profile.tenant_id,
            ...values,
            work_phone: result.data.work_phone || null,
            notes: result.data.notes || null,
          });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["property-managers"] });
      setPmModalOpen(false);
    },
    onError: (e) => setPmError(getErrorMessage(e, pmEditId ? "Failed to save property manager" : "Failed to create property manager")),
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
  const [propOwnerPhone, setPropOwnerPhone] = useState("");
  const [propOwnerEmail, setPropOwnerEmail] = useState("");
  const [propTenantName, setPropTenantName] = useState("");
  const [propTenantPhone, setPropTenantPhone] = useState("");
  const [propTenantEmail, setPropTenantEmail] = useState("");
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
    setPropOwnerPhone("");
    setPropOwnerEmail("");
    setPropTenantName("");
    setPropTenantPhone("");
    setPropTenantEmail("");
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
        owner_landlord_phone: propOwnerPhone,
        owner_landlord_email: propOwnerEmail,
        tenant_name: propTenantName,
        tenant_phone: propTenantPhone,
        tenant_email: propTenantEmail,
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
        owner_landlord_phone: result.data.owner_landlord_phone || null,
        owner_landlord_email: result.data.owner_landlord_email || null,
        tenant_name: result.data.tenant_name || null,
        tenant_phone: result.data.tenant_phone || null,
        tenant_email: result.data.tenant_email || null,
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
        <ThemedButton variant="secondary" onClick={() => openNewProperty()} style={{ paddingBlock: 6, paddingInline: 12 }}>
          + Add Managed Property
        </ThemedButton>
        <ThemedButton variant="secondary" onClick={() => openNewPm()} style={{ paddingBlock: 6, paddingInline: 12 }}>
          + Add Property Manager
        </ThemedButton>
        <ThemedButton onClick={openNewAgency} style={{ paddingBlock: 6, paddingInline: 12 }}>
          + Add Agency
        </ThemedButton>
      </div>

      {!agencies || agencies.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No agencies yet.</p>
      ) : (
        <div className="space-y-3">
          {agencies.map((agency) => {
            const expanded = expandedAgencyIds.has(agency.id);
            const pms = pmsByAgency(agency.id);
            return (
              <div key={agency.id} className="rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
                <div className="flex w-full items-center justify-between px-4 py-3">
                  <button onClick={() => toggleAgency(agency.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <span style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>{expanded ? "▾" : "▸"}</span>
                    <span className="font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                      {agency.name}
                    </span>
                    <ThemedBadge label={agency.type === "strata" ? "Strata" : "Real Estate"} color="var(--jms-text-muted)" />
                    {agency.client_id && clientById.get(agency.client_id) ? (
                      <ThemedBadge label={`Bills to: ${clientById.get(agency.client_id)!.company_name || clientById.get(agency.client_id)!.name}`} />
                    ) : (
                      <ThemedBadge label="No billing client linked" color="var(--jms-warning)" />
                    )}
                  </button>
                  <div className="flex flex-shrink-0 items-center gap-3">
                    <span style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                      {pms.length} PM{pms.length === 1 ? "" : "s"}
                    </span>
                    <button
                      onClick={() => openEditAgency(agency)}
                      className="font-semibold hover:underline"
                      style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                    >
                      Edit
                    </button>
                  </div>
                </div>
                {expanded ? (
                  <div className="px-4 py-3" style={{ borderTop: "1px solid var(--jms-border)" }}>
                    {pms.length === 0 ? (
                      <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No property managers yet for this agency.</p>
                    ) : (
                      <div className="space-y-1">
                        {pms.map((pm) => (
                          <div key={pm.id}>
                            <div
                              className={`jms-nav-link flex w-full items-center justify-between rounded px-3 py-2 text-left ${
                                selectedPmId === pm.id ? "jms-nav-link-active" : ""
                              }`}
                            >
                              <button
                                onClick={() => setSelectedPmId(selectedPmId === pm.id ? null : pm.id)}
                                className="flex min-w-0 flex-1 items-center justify-between text-left"
                              >
                                <span className="font-medium" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                                  {pm.first_name} {pm.last_name}
                                </span>
                                <span style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{pm.email ?? pm.mobile ?? ""}</span>
                              </button>
                              <button
                                onClick={() => openEditPm(pm)}
                                className="ml-3 flex-shrink-0 font-semibold hover:underline"
                                style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                              >
                                Edit
                              </button>
                            </div>
                            {selectedPmId === pm.id ? (
                              <div className="ml-6 mb-2 mt-1 space-y-1 pl-4" style={{ borderLeft: "1px solid var(--jms-border)" }}>
                                {propertiesByPm(pm.id).length === 0 ? (
                                  <p className="py-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                                    No managed properties for this PM yet.
                                  </p>
                                ) : (
                                  propertiesByPm(pm.id).map((property) => (
                                    <Link
                                      key={property.id}
                                      to={`/real-estate/properties/${property.id}`}
                                      className="flex justify-between rounded px-2 py-1 hover:underline"
                                      style={{ fontSize: "var(--jms-font-body)" }}
                                    >
                                      <span className="min-w-0 flex-1 truncate" style={{ color: "var(--jms-accent)" }}>
                                        {property.address_line1}
                                      </span>
                                      <span className="ml-2 flex-shrink-0" style={{ color: "var(--jms-text-muted)" }}>
                                        {property.suburb}
                                      </span>
                                    </Link>
                                  ))
                                )}
                                <button
                                  onClick={() => openNewProperty(agency.id, pm.id)}
                                  className="mt-1 font-semibold hover:underline"
                                  style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
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
                      className="mt-2 font-semibold hover:underline"
                      style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
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

      <ThemedModal open={agencyModalOpen} onClose={() => setAgencyModalOpen(false)} title={agencyEditId ? "Edit agency" : "New agency"}>
        <ThemedFormField label="Name" value={agencyName} onChange={(e) => setAgencyName(e.target.value)} placeholder="e.g. McGrath Estate Agents" />
        <ThemedSelectField label="Type" value={agencyType} onChange={setAgencyType} options={AGENCY_TYPE_OPTIONS} placeholder="Select type" />
        <ThemedFormField
          label="Billing email (optional)"
          type="email"
          value={agencyBillingEmail}
          onChange={(e) => setAgencyBillingEmail(e.target.value)}
        />
        <label className="mb-4 flex items-center gap-2 font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
          <input
            type="checkbox"
            checked={agencyRequireWorkOrder}
            onChange={(e) => setAgencyRequireWorkOrder(e.target.checked)}
          />
          Require a work order number on every invoice
        </label>
        <ThemedSelectField
          label="Billing client"
          value={agencyClientId}
          onChange={setAgencyClientId}
          options={[
            { value: AUTO_CREATE_CLIENT, label: "+ Create a new client automatically" },
            ...(clients ?? []).map((c) => ({ value: c.id, label: c.company_name || c.name })),
          ]}
        />
        <p className="-mt-2 mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Jobs created for this agency will bill against this client automatically - no need to create a matching client card
          separately.
        </p>
        {agencyError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {agencyError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setAgencyModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveAgency.mutate()} disabled={saveAgency.isPending || !agencyName.trim()}>
            {saveAgency.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal open={pmModalOpen} onClose={() => setPmModalOpen(false)} title={pmEditId ? "Edit property manager" : "New property manager"}>
        <ThemedSelectField
          label="Agency"
          value={pmAgencyId}
          onChange={setPmAgencyId}
          options={(agencies ?? []).map((a) => ({ value: a.id, label: a.name }))}
          placeholder="Select agency"
        />
        <ThemedFormField label="First name" value={pmFirstName} onChange={(e) => setPmFirstName(e.target.value)} />
        <ThemedFormField label="Last name" value={pmLastName} onChange={(e) => setPmLastName(e.target.value)} />
        <ThemedFormField label="Email" type="email" value={pmEmail} onChange={(e) => setPmEmail(e.target.value)} />
        <ThemedFormField label="Mobile" value={pmMobile} onChange={(e) => setPmMobile(e.target.value)} />
        {pmError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {pmError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setPmModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => savePm.mutate()} disabled={savePm.isPending || !pmAgencyId}>
            {savePm.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal open={propertyModalOpen} onClose={() => setPropertyModalOpen(false)} title="New managed property">
        <ThemedSelectField
          label="Agency"
          value={propAgencyId}
          onChange={(v) => {
            setPropAgencyId(v);
            setPropPmId("");
          }}
          options={(agencies ?? []).map((a) => ({ value: a.id, label: a.name }))}
          placeholder="Select agency"
        />
        <ThemedSelectField
          label="Property manager"
          value={propPmId}
          onChange={setPropPmId}
          options={pmsByAgency(propAgencyId).map((pm) => ({ value: pm.id, label: `${pm.first_name} ${pm.last_name}` }))}
          placeholder="Unassigned"
        />
        <ThemedFormField label="Address line 1" value={propAddress} onChange={(e) => setPropAddress(e.target.value)} />
        <div className="grid grid-cols-3 gap-3">
          <ThemedFormField label="Suburb" value={propSuburb} onChange={(e) => setPropSuburb(e.target.value)} />
          <ThemedFormField label="State" value={propState} onChange={(e) => setPropState(e.target.value)} />
          <ThemedFormField label="Postcode" value={propPostcode} onChange={(e) => setPropPostcode(e.target.value)} />
        </div>
        <ThemedSelectField label="Property type" value={propType} onChange={setPropType} options={PROPERTY_TYPE_OPTIONS} placeholder="Select type" />

        <ThemedFormField label="Owner / landlord name" value={propOwnerName} onChange={(e) => setPropOwnerName(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField label="Landlord mobile" value={propOwnerPhone} onChange={(e) => setPropOwnerPhone(e.target.value)} />
          <ThemedFormField label="Landlord email" type="email" value={propOwnerEmail} onChange={(e) => setPropOwnerEmail(e.target.value)} />
        </div>

        <ThemedFormField label="Tenant name" value={propTenantName} onChange={(e) => setPropTenantName(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField label="Tenant mobile" value={propTenantPhone} onChange={(e) => setPropTenantPhone(e.target.value)} />
          <ThemedFormField label="Tenant email" type="email" value={propTenantEmail} onChange={(e) => setPropTenantEmail(e.target.value)} />
        </div>

        <ThemedFormField label="Key tag number" value={propKeyTag} onChange={(e) => setPropKeyTag(e.target.value)} placeholder="e.g. Key #42" />
        {propError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {propError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setPropertyModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => createProperty.mutate()} disabled={createProperty.isPending || !propAgencyId}>
            {createProperty.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}

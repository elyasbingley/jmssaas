import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { Agency, Property, PropertyAsset, PropertyAssetCategory } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { triggerImmediateDispatch } from "../lib/dispatch-now";
import { SelectField } from "./FormField";

// Scoped specifically to the gutter-clean schedule already captured on a
// roofing property_assets row (last_gutter_clean_date +
// gutter_clean_interval_months) - see the real_estate_maintenance_engine
// migration's own comment for why the spec's other example (backflow
// inspections) isn't modelled here (no matching field exists anywhere in
// this schema yet). The Asset Type filter is still offered for forward
// compatibility even though only "roofing" currently has qualifying data.

async function fetchAssets(): Promise<PropertyAsset[]> {
  const { data, error } = await supabase.from("property_assets").select("*");
  if (error) throw error;
  return data as PropertyAsset[];
}
async function fetchProperties(): Promise<Property[]> {
  const { data, error } = await supabase.from("properties").select("*");
  if (error) throw error;
  return data as Property[];
}
async function fetchAgencies(): Promise<Agency[]> {
  const { data, error } = await supabase.from("agencies").select("*");
  if (error) throw error;
  return data as Agency[];
}

interface DueItem {
  asset: PropertyAsset;
  property: Property;
  agency: Agency | undefined;
  dueDate: Date;
}

function computeDueDate(asset: PropertyAsset): Date | null {
  const { last_gutter_clean_date, gutter_clean_interval_months } = asset.attributes;
  if (!last_gutter_clean_date || !gutter_clean_interval_months) return null;
  const d = new Date(`${last_gutter_clean_date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + gutter_clean_interval_months);
  return d;
}

export function RecurringMaintenanceEngine() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data: assets } = useQuery({ queryKey: ["property-assets"], queryFn: fetchAssets });
  const { data: properties } = useQuery({ queryKey: ["properties"], queryFn: fetchProperties });
  const { data: agencies } = useQuery({ queryKey: ["agencies"], queryFn: fetchAgencies });

  const propertyById = new Map((properties ?? []).map((p) => [p.id, p]));
  const agencyById = new Map((agencies ?? []).map((a) => [a.id, a]));

  const dueItems: DueItem[] = useMemo(() => {
    const items: DueItem[] = [];
    for (const asset of assets ?? []) {
      const dueDate = computeDueDate(asset);
      if (!dueDate) continue;
      const property = propertyById.get(asset.property_id);
      if (!property) continue;
      items.push({ asset, property, agency: agencyById.get(property.agency_id), dueDate });
    }
    return items.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  }, [assets, properties, agencies]);

  const [filterMonth, setFilterMonth] = useState("");
  const [filterSuburb, setFilterSuburb] = useState("");
  const [filterAgency, setFilterAgency] = useState("");
  const [filterAssetType, setFilterAssetType] = useState<PropertyAssetCategory | "">("");

  const filteredItems = dueItems.filter((item) => {
    if (filterMonth && `${item.dueDate.getFullYear()}-${String(item.dueDate.getMonth() + 1).padStart(2, "0")}` !== filterMonth) {
      return false;
    }
    if (filterSuburb && !item.property.suburb.toLowerCase().includes(filterSuburb.toLowerCase())) return false;
    if (filterAgency && item.property.agency_id !== filterAgency) return false;
    if (filterAssetType && item.asset.category !== filterAssetType) return false;
    return true;
  });

  const monthOptions = useMemo(() => {
    const months = new Set(dueItems.map((item) => `${item.dueDate.getFullYear()}-${String(item.dueDate.getMonth() + 1).padStart(2, "0")}`));
    return Array.from(months)
      .sort()
      .map((m) => ({ value: m, label: new Date(`${m}-01T00:00:00`).toLocaleDateString("en-AU", { month: "long", year: "numeric" }) }));
  }, [dueItems]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelected = (assetId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  };

  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const generateDraftJobs = useMutation({
    mutationFn: async (items: DueItem[]) => {
      if (!profile) throw new Error("Not signed in");
      let created = 0;
      for (const item of items) {
        const { property } = item;
        // A property has no client_id of its own (its tenant/landlord are
        // plain text fields, not a `clients` row) - job_cards.client_id is
        // required, so a lightweight client is created from the property's
        // tenant details (falling back to the landlord's name) to satisfy
        // that FK. An admin reviewing the resulting draft job can merge or
        // edit this client afterward same as any other client record.
        const clientName = property.tenant_name || property.owner_landlord_name || property.address_line1;
        const { data: client, error: clientError } = await supabase
          .from("clients")
          .insert({
            tenant_id: profile.tenant_id,
            name: clientName,
            phone: property.tenant_phone,
            email: property.tenant_email,
            created_by: profile.id,
          })
          .select("id")
          .single();
        if (clientError) throw clientError;

        const { error: jobError } = await supabase.from("job_cards").insert({
          tenant_id: profile.tenant_id,
          client_id: client.id,
          title: `Gutter Clean - ${property.address_line1}`,
          description: `Scheduled gutter clean, due ${item.dueDate.toLocaleDateString("en-AU")}.`,
          is_real_estate_job: true,
          agency_id: property.agency_id,
          property_manager_id: property.property_manager_id,
          property_id: property.id,
          created_by: profile.id,
        });
        if (jobError) throw jobError;
        created++;
      }
      return created;
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setActionError(null);
      setActionMessage(`${created} draft job${created === 1 ? "" : "s"} created.`);
      setSelectedIds(new Set());
      setTimeout(() => setActionMessage(null), 5000);
    },
    onError: (e) => setActionError(getErrorMessage(e, "Failed to generate draft jobs")),
  });

  const sendReminder = useMutation({
    mutationFn: async (item: DueItem) => {
      if (!profile) throw new Error("Not signed in");
      if (!item.property.property_manager_id) throw new Error("This property has no property manager assigned.");

      const { data: pm } = await supabase.from("property_managers").select("email").eq("id", item.property.property_manager_id).single();
      if (!pm?.email) throw new Error("This property manager has no email address on file.");

      const { data: rule } = await supabase
        .from("communication_rules")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "property_maintenance_due")
        .maybeSingle();
      if (!rule || !rule.is_enabled) {
        throw new Error("The 'Property Maintenance Due' email is turned off in Settings > Automation & Messaging");
      }
      const { data: templates } = await supabase
        .from("communication_templates")
        .select("*")
        .eq("tenant_id", profile.tenant_id)
        .eq("trigger_key", "property_maintenance_due")
        .eq("is_active", true);
      const template = (templates ?? []).find((t) => rule.channel === "both" || rule.channel === t.type);
      if (!template) throw new Error("No active 'Property Maintenance Due' email template found");

      const { data: row, error } = await supabase
        .from("scheduled_communications")
        .insert({
          tenant_id: profile.tenant_id,
          entity_type: "property_asset",
          entity_id: item.asset.id,
          trigger_key: "property_maintenance_due",
          template_id: template.id,
          channel: template.type,
          recipient_phone_or_email: pm.email,
          rendered_subject: template.subject,
          rendered_body: template.body,
          scheduled_for: new Date().toISOString(),
          status: "pending",
        })
        .select("id")
        .single();
      if (error) throw error;
      await triggerImmediateDispatch(row.id);
    },
    onSuccess: () => {
      setActionError(null);
      setActionMessage("Reminder sent to the property manager.");
      setTimeout(() => setActionMessage(null), 5000);
    },
    onError: (e) => setActionError(getErrorMessage(e, "Failed to send reminder")),
  });

  return (
    <div>
      <div className="mb-4 grid grid-cols-4 gap-3">
        <SelectField label="Month" value={filterMonth} onChange={setFilterMonth} options={monthOptions} placeholder="All months" />
        <div>
          <label className="mb-1 block text-sm font-semibold text-gray-700">Suburb</label>
          <input
            value={filterSuburb}
            onChange={(e) => setFilterSuburb(e.target.value)}
            placeholder="e.g. Bondi"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <SelectField
          label="Agency"
          value={filterAgency}
          onChange={setFilterAgency}
          options={(agencies ?? []).map((a) => ({ value: a.id, label: a.name }))}
          placeholder="All agencies"
        />
        <SelectField
          label="Asset type"
          value={filterAssetType}
          onChange={setFilterAssetType}
          options={[
            { value: "plumbing", label: "Plumbing" },
            { value: "roofing", label: "Roofing" },
            { value: "hvac", label: "HVAC" },
            { value: "general", label: "General" },
          ]}
          placeholder="All types"
        />
      </div>

      {actionError ? <p className="mb-3 text-sm text-red-600">{actionError}</p> : null}
      {actionMessage ? <p className="mb-3 text-sm text-green-700">{actionMessage}</p> : null}

      <div className="mb-3 flex justify-end">
        <button
          onClick={() => generateDraftJobs.mutate(filteredItems.filter((item) => selectedIds.has(item.asset.id)))}
          disabled={selectedIds.size === 0 || generateDraftJobs.isPending}
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {generateDraftJobs.isPending ? "Generating..." : `Batch Generate Draft Jobs (${selectedIds.size})`}
        </button>
      </div>

      {filteredItems.length === 0 ? (
        <p className="text-sm text-gray-500">No upcoming maintenance found.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2"></th>
                <th className="px-4 py-2 font-semibold">Property</th>
                <th className="px-4 py-2 font-semibold">Agency</th>
                <th className="px-4 py-2 font-semibold">Asset</th>
                <th className="px-4 py-2 font-semibold">Due</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => (
                <tr key={item.asset.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.asset.id)}
                      onChange={() => toggleSelected(item.asset.id)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/real-estate/properties/${item.property.id}`} className="text-blue-700 hover:underline">
                      {item.property.address_line1}, {item.property.suburb}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-700">{item.agency?.name ?? "-"}</td>
                  <td className="px-4 py-3 text-gray-700">{item.asset.asset_name}</td>
                  <td className="px-4 py-3 text-gray-700">{item.dueDate.toLocaleDateString("en-AU")}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => sendReminder.mutate(item)}
                      disabled={sendReminder.isPending}
                      className="text-xs font-semibold text-blue-700 hover:underline disabled:opacity-60"
                    >
                      Send Reminder Email to PM
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

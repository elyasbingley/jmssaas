import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPropertyAssetSchema,
  type PropertyAsset,
  type PropertyAssetAttributes,
  type PropertyAssetCategory,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "./Modal";
import { FormField, SelectField } from "./FormField";

// Extracted from PropertyDetail.tsx's original inline "Asset Register" tab
// (property_assets was always property-only until the client_assets
// migration widened it to also allow a client as owner) - now shared by
// PropertyDetail.tsx (property owner), ClientDetail.tsx (client owner), and
// JobDetail.tsx (whichever owner the job resolves to: its linked property
// for an agency-managed job, its client otherwise), so this logic exists
// in exactly one place instead of three.

type AssetOwner = { type: "property"; id: string } | { type: "client"; id: string };

interface AssetsSectionProps {
  owner: AssetOwner;
  // PropertyDetail.tsx already renders its own "Asset Register" tab label
  // above this - passing bare skips the redundant bordered box + heading
  // this component otherwise wraps itself in for ClientDetail.tsx/
  // JobDetail.tsx, where there's no other heading doing that job.
  bare?: boolean;
  title?: string;
}

async function fetchAssets(owner: AssetOwner): Promise<PropertyAsset[]> {
  const column = owner.type === "property" ? "property_id" : "client_id";
  const { data, error } = await supabase
    .from("property_assets")
    .select("*")
    .eq(column, owner.id)
    .order("category")
    .order("asset_name");
  if (error) throw error;
  return data as PropertyAsset[];
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

export function AssetsSection({ owner, bare = false, title = "Assets" }: AssetsSectionProps) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["assets", owner.type, owner.id];

  const { data: assets } = useQuery({ queryKey, queryFn: () => fetchAssets(owner) });

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
        property_id: owner.type === "property" ? owner.id : undefined,
        client_id: owner.type === "client" ? owner.id : undefined,
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
          property_id: result.data.property_id ?? null,
          client_id: result.data.client_id ?? null,
          category: result.data.category,
          asset_name: result.data.asset_name,
          attributes: result.data.attributes,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setAssetModalOpen(false);
    },
    onError: (e) => setAssetError(getErrorMessage(e, "Failed to save asset")),
  });

  const deleteAsset = useMutation({
    mutationFn: async (asset: PropertyAsset) => {
      const { error } = await supabase.from("property_assets").delete().eq("id", asset.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const noAssetsLabel = owner.type === "property" ? "No assets recorded for this property yet." : "No assets recorded for this client yet.";

  const content = (
    <div>
      <div className="mb-4 flex justify-end">
        <button onClick={openNewAsset} className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800">
          + Add Asset
        </button>
      </div>
      {!assets || assets.length === 0 ? (
        <p className="text-sm text-gray-500">{noAssetsLabel}</p>
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
                      isWarrantyActive(asset.attributes.warranty_expiry_date) ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {isWarrantyActive(asset.attributes.warranty_expiry_date) ? "Under warranty" : "Warranty expired"}
                  </span>
                ) : null}
                {asset.attributes.roof_type ? (
                  <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-800">{asset.attributes.roof_type}</span>
                ) : null}
                {asset.attributes.gutter_clean_interval_months ? (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
                    Gutter clean every {asset.attributes.gutter_clean_interval_months}mo
                  </span>
                ) : null}
                {asset.attributes.fuel_type ? (
                  <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-800">{asset.attributes.fuel_type}</span>
                ) : null}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <>
      {bare ? (
        content
      ) : (
        <div className="mb-6 rounded-lg border border-gray-300 bg-white p-6">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">{title}</h2>
          {content}
        </div>
      )}

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
                onChange={(e) => setAttrs({ ...attrs, gutter_clean_interval_months: e.target.value ? Number(e.target.value) : undefined })}
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
    </>
  );
}

import {
  assetDefaults,
  assetSummary,
  sydneyToday,
  type Asset,
  type AssetDefaultWarranty,
  type AssetFile,
  type AssetService,
  type AssetServiceRecord,
  type AssetType,
  type AssetWarranty,
  type AssetWarrantyClaim,
} from "@jmssaas/shared";
import { supabase } from "./supabase";
import { fetchAllRows } from "./fetch-all-rows";

// Data access for the asset register (asset_register migration). The
// desktop reads and writes Supabase directly, like every desktop screen.

export type AssetOwner = { type: "property"; id: string } | { type: "client"; id: string };

export const ASSETS_KEY = ["assets"];

export async function fetchAssetTypes(): Promise<AssetType[]> {
  const { data, error } = await supabase.from("asset_types").select("*").order("sort_order").order("name");
  if (error) throw error;
  return data as AssetType[];
}

export interface AssetBundle {
  assets: Asset[];
  warranties: AssetWarranty[];
  services: AssetService[];
  records: AssetServiceRecord[];
  files: AssetFile[];
  claims: AssetWarrantyClaim[];
}

async function childrenOf(assetIds: string[]): Promise<Omit<AssetBundle, "assets">> {
  if (assetIds.length === 0) return { warranties: [], services: [], records: [], files: [], claims: [] };
  const inIds = (q: any) => q.in("asset_id", assetIds); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [warranties, services, records, files, claims] = await Promise.all([
    fetchAllRows<AssetWarranty>("asset_warranties", "*", inIds),
    fetchAllRows<AssetService>("asset_services", "*", inIds),
    fetchAllRows<AssetServiceRecord>("asset_service_records", "*", inIds),
    fetchAllRows<AssetFile>("asset_files", "*", inIds),
    fetchAllRows<AssetWarrantyClaim>("asset_warranty_claims", "*", inIds),
  ]);
  return { warranties, services, records, files, claims };
}

// One client's or property's assets with everything hanging off them.
export async function fetchAssetsFor(owner: AssetOwner): Promise<AssetBundle> {
  const column = owner.type === "property" ? "property_id" : "client_id";
  const assets = await fetchAllRows<Asset>("property_assets", "*", (q) => q.eq(column, owner.id));
  return { assets, ...(await childrenOf(assets.map((a) => a.id))) };
}

// Every asset in the company (the register page).
export async function fetchAllAssets(): Promise<AssetBundle> {
  const [assets, warranties, services, records, files, claims] = await Promise.all([
    fetchAllRows<Asset>("property_assets", "*"),
    fetchAllRows<AssetWarranty>("asset_warranties", "*"),
    fetchAllRows<AssetService>("asset_services", "*"),
    fetchAllRows<AssetServiceRecord>("asset_service_records", "*"),
    fetchAllRows<AssetFile>("asset_files", "*"),
    fetchAllRows<AssetWarrantyClaim>("asset_warranty_claims", "*"),
  ]);
  return { assets, warranties, services, records, files, claims };
}

// A new asset with its type's service plan and warranties (the same rows
// the database gives an asset created from a job).
export async function createAsset(params: {
  tenantId: string;
  createdBy: string;
  owner: AssetOwner;
  type: AssetType | null;
  fields: Partial<Asset>;
  warranties?: AssetDefaultWarranty[] | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  const { error } = await supabase.from("property_assets").insert({
    id,
    tenant_id: params.tenantId,
    created_by: params.createdBy,
    property_id: params.owner.type === "property" ? params.owner.id : null,
    client_id: params.owner.type === "client" ? params.owner.id : null,
    category: params.type?.category ?? "general",
    asset_type_id: params.type?.id ?? null,
    asset_name: params.fields.asset_name ?? params.type?.name ?? "Asset",
    attributes: params.fields.attributes ?? {},
    site_id: params.fields.site_id ?? null,
    installed_on: params.fields.installed_on ?? null,
    install_year: params.fields.install_year ?? null,
    location: params.fields.location ?? null,
    notes: params.fields.notes ?? null,
  });
  if (error) throw error;
  if (params.type) {
    const installed = params.fields.installed_on ?? (params.fields.install_year ? `${params.fields.install_year}-07-01` : null);
    const defaults = assetDefaults(params.type, installed, sydneyToday(), params.warranties);
    if (defaults.services.length) {
      const { error: e } = await supabase.from("asset_services").insert(defaults.services.map((s) => ({ ...s, tenant_id: params.tenantId, asset_id: id })));
      if (e) throw e;
    }
    if (defaults.warranties.length) {
      const { error: e } = await supabase.from("asset_warranties").insert(defaults.warranties.map((w) => ({ ...w, tenant_id: params.tenantId, asset_id: id })));
      if (e) throw e;
    }
  }
  return id;
}

// Photos and documents: job-files bucket, <tenant>/asset-<asset id>/.
export async function uploadAssetFile(params: { tenantId: string; assetId: string; uploadedBy: string; file: File; caption?: string }): Promise<void> {
  const id = crypto.randomUUID();
  const extension = params.file.name.split(".").pop()?.toLowerCase() || "bin";
  const fileName = `${id}.${extension}`;
  const storagePath = `${params.tenantId}/asset-${params.assetId}/${fileName}`;
  const { error: uploadError } = await supabase.storage.from("job-files").upload(storagePath, params.file, { contentType: params.file.type || undefined });
  if (uploadError) throw uploadError;
  const { error } = await supabase.from("asset_files").insert({
    id,
    tenant_id: params.tenantId,
    asset_id: params.assetId,
    kind: params.file.type.startsWith("image/") ? "photo" : "document",
    storage_path: storagePath,
    // Keep the original name for documents ("Compliance certificate.pdf").
    file_name: params.file.type.startsWith("image/") ? fileName : params.file.name,
    mime_type: params.file.type || null,
    size_bytes: params.file.size,
    caption: params.caption ?? null,
    uploaded_by: params.uploadedBy,
  });
  if (error) throw error;
}

export async function signedFileUrl(storagePath: string): Promise<string | null> {
  const { data } = await supabase.storage.from("job-files").createSignedUrl(storagePath, 60 * 60);
  return data?.signedUrl ?? null;
}

// ---------------------------------------------------------------------------
// For PDFs (invoice "installed on this job", Home record)
// ---------------------------------------------------------------------------

export function toPdfAsset(asset: Asset, type: AssetType | null, warranties: AssetWarranty[], services: AssetService[]) {
  return {
    name: asset.asset_name,
    detail: [type && type.name !== asset.asset_name ? type.name : null, assetSummary(asset)].filter(Boolean).join(" · "),
    installed: asset.installed_on ?? (asset.install_year ? `${asset.install_year}-07-01` : null),
    location: asset.location,
    warranties: warranties
      .filter((w) => w.asset_id === asset.id)
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "manufacturer" ? -1 : 1))
      .map((w) => ({ label: w.kind === "workmanship" ? (w.label && w.label !== "Workmanship" ? `Workmanship (${w.label})` : "Workmanship") : w.label || "Manufacturer", until: w.expires_on })),
    services: services.filter((s) => s.asset_id === asset.id && s.next_due_on).map((s) => ({ name: s.name, next: s.next_due_on })),
  };
}

// What a job installed, ready for its invoice PDF.
export async function fetchInstalledAssetsForJob(jobCardId: string | null | undefined) {
  if (!jobCardId) return [];
  const assets = await fetchAllRows<Asset>("property_assets", "*", (q) => q.eq("installed_by_job_id", jobCardId).eq("status", "active"));
  if (assets.length === 0) return [];
  const [types, children] = await Promise.all([fetchAssetTypes(), childrenOf(assets.map((a) => a.id))]);
  return assets.map((a) => toPdfAsset(a, types.find((t) => t.id === a.asset_type_id) ?? null, children.warranties, children.services));
}

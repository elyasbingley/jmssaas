import { assetSummary, type Asset, type AssetService, type AssetType, type AssetWarranty } from "@jmssaas/shared";
import { supabase } from "./supabase";
import type { PdfAsset } from "./pdf";

// What a job installed (asset register), for the "Installed on this job"
// section of its invoice PDF - same content as the desktop's
// fetchInstalledAssetsForJob. A failure just leaves the section off.
export async function fetchInstalledAssetsForJob(jobCardId: string | null | undefined): Promise<PdfAsset[]> {
  if (!jobCardId) return [];
  try {
    const { data: assets, error } = await supabase.from("property_assets").select("*").eq("installed_by_job_id", jobCardId).eq("status", "active");
    if (error || !assets?.length) return [];
    const ids = assets.map((a) => a.id as string);
    const [types, warranties, services] = await Promise.all([
      supabase.from("asset_types").select("*"),
      supabase.from("asset_warranties").select("*").in("asset_id", ids),
      supabase.from("asset_services").select("*").in("asset_id", ids),
    ]);
    return (assets as Asset[]).map((asset) => {
      const type = ((types.data ?? []) as AssetType[]).find((t) => t.id === asset.asset_type_id) ?? null;
      return {
        name: asset.asset_name,
        detail: [type && type.name !== asset.asset_name ? type.name : null, assetSummary(asset)].filter(Boolean).join(" · "),
        installed: asset.installed_on ?? (asset.install_year ? `${asset.install_year}-07-01` : null),
        location: asset.location,
        warranties: ((warranties.data ?? []) as AssetWarranty[])
          .filter((w) => w.asset_id === asset.id)
          .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "manufacturer" ? -1 : 1))
          .map((w) => ({ label: w.kind === "workmanship" ? (w.label && w.label !== "Workmanship" ? `Workmanship (${w.label})` : "Workmanship") : w.label || "Manufacturer", until: w.expires_on })),
        services: ((services.data ?? []) as AssetService[]).filter((s) => s.asset_id === asset.id && s.next_due_on).map((s) => ({ name: s.name, next: s.next_due_on })),
      };
    });
  } catch {
    return [];
  }
}

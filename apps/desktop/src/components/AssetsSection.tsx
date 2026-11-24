import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  assetAgeYears,
  assetSummary,
  serviceState,
  sydneyToday,
  warrantyState,
  type Asset,
  type AssetService,
  type AssetType,
  type AssetWarranty,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ASSETS_KEY, fetchAssetTypes, fetchAssetsFor, type AssetOwner } from "../lib/assets-data";
import { ThemedButton } from "./theme/ThemedButton";
import { AssetEditor, STATE_COLOURS, fmtDay } from "./AssetEditor";
import { HomeRecordButton } from "./HomeRecordButton";

// A client's or property's assets (asset register). On a job page
// (jobCardId set) each service can be ticked off as done on this job, and
// assets the job installed can be added from its price book items.

interface AssetsSectionProps {
  owner: AssetOwner;
  bare?: boolean;
  title?: string;
  jobCardId?: string | null;
  jobSiteId?: string | null;
}

const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const link = { color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" } as const;

export function bestWarranty(warranties: AssetWarranty[], today: string): { text: string; state: string } | null {
  if (warranties.length === 0) return null;
  const live = warranties.filter((w) => w.expires_on && w.expires_on >= today).sort((a, b) => (a.expires_on! < b.expires_on! ? 1 : -1));
  if (live.length) {
    const w = live[0]!;
    return { text: `Warranty to ${fmtDay(w.expires_on)}${w.label ? ` (${w.label.toLowerCase()})` : ""}`, state: warrantyState(w.expires_on, today) };
  }
  return warranties.some((w) => w.expires_on) ? { text: "Warranty expired", state: "expired" } : { text: "Warranty dates not set", state: "unknown" };
}

export function AssetsSection({ owner, bare = false, title = "Assets", jobCardId = null, jobSiteId = null }: AssetsSectionProps) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const today = sydneyToday();
  const { data, error } = useQuery({ queryKey: [...ASSETS_KEY, owner.type, owner.id], queryFn: () => fetchAssetsFor(owner) });
  const { data: types } = useQuery({ queryKey: [...ASSETS_KEY, "types"], queryFn: fetchAssetTypes });
  const { data: sites } = useQuery({
    queryKey: ["client-sites", owner.id],
    enabled: owner.type === "client",
    queryFn: async () => {
      const { data: rows, error: e } = await supabase.from("client_sites").select("id, label, address_line1, suburb").eq("client_id", owner.id).order("created_at");
      if (e) throw e;
      return (rows ?? []).map((s) => ({ id: s.id as string, label: [s.label, [s.address_line1, s.suburb].filter(Boolean).join(", ")].filter(Boolean).join(" - ") }));
    },
  });
  const { data: jobRecords } = useQuery({
    queryKey: [...ASSETS_KEY, "job-records", jobCardId],
    enabled: !!jobCardId,
    queryFn: async () => {
      const { data: rows, error: e } = await supabase.from("asset_service_records").select("id, service_id, done_by").eq("job_card_id", jobCardId!);
      if (e) throw e;
      return rows as { id: string; service_id: string | null; done_by: string | null }[];
    },
  });
  const [showRemoved, setShowRemoved] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [installResult, setInstallResult] = useState<string | null>(null);

  const typeById = useMemo(() => new Map((types ?? []).map((t) => [t.id, t])), [types]);
  const siteLabel = (id: string | null) => (id ? sites?.find((s) => s.id === id)?.label ?? "Other address" : sites && sites.length ? "Main address" : null);
  const assets = (data?.assets ?? [])
    .filter((a) => showRemoved || a.status === "active")
    // On a job, the assets at the job's address come first.
    .sort((a, b) => Number(b.site_id === jobSiteId) - Number(a.site_id === jobSiteId) || a.asset_name.localeCompare(b.asset_name));

  const refresh = () => queryClient.invalidateQueries({ queryKey: ASSETS_KEY });
  const tick = useMutation({
    mutationFn: async ({ asset, service, done }: { asset: Asset; service: AssetService; done: boolean }) => {
      if (done) {
        const { error: e } = await supabase.from("asset_service_records").insert({
          tenant_id: asset.tenant_id,
          asset_id: asset.id,
          service_id: service.id,
          job_card_id: jobCardId,
          done_on: today,
          done_by: profile?.id ?? null,
        });
        if (e) throw e;
      } else {
        const ids = (jobRecords ?? []).filter((r) => r.service_id === service.id).map((r) => r.id);
        const { error: e } = await supabase.from("asset_service_records").delete().in("id", ids);
        if (e) throw e;
      }
    },
    onSettled: refresh,
  });
  const fromJob = useMutation({
    mutationFn: async () => {
      const { data: count, error: e } = await supabase.rpc("create_assets_from_job", { p_job_card_id: jobCardId });
      if (e) throw e;
      return count as number;
    },
    onSuccess: (count) => {
      setInstallResult(
        count
          ? `Added ${count} asset${count === 1 ? "" : "s"} from this job's price book items.`
          : "Nothing new to add - none of this job's invoice or accepted quote lines use a price book item marked 'creates an asset' (or they're already added)."
      );
      refresh();
    },
  });

  const removedCount = (data?.assets ?? []).filter((a) => a.status === "removed").length;
  const content = (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ThemedButton onClick={() => setEditing({ id: null })} style={{ paddingBlock: 4, paddingInline: 12 }}>
          + Add asset
        </ThemedButton>
        {jobCardId ? (
          <button onClick={() => fromJob.mutate()} className="font-semibold hover:underline" style={link} disabled={fromJob.isPending}>
            Add assets installed on this job
          </button>
        ) : null}
        {owner.type === "client" && (data?.assets ?? []).length > 0 ? <HomeRecordButton clientId={owner.id} /> : null}
        {removedCount ? (
          <button onClick={() => setShowRemoved((v) => !v)} className="ml-auto hover:underline" style={muted}>
            {showRemoved ? "Hide removed" : `Show ${removedCount} removed`}
          </button>
        ) : null}
      </div>
      {installResult ? <p className="mb-2" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>{installResult}</p> : null}
      {error || fromJob.error || tick.error ? (
        <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(error ?? fromJob.error ?? tick.error, "Something went wrong")}</p>
      ) : null}
      {data && assets.length === 0 ? <p style={muted}>No assets recorded yet.</p> : null}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {assets.map((asset) => {
          const type: AssetType | null = asset.asset_type_id ? typeById.get(asset.asset_type_id) ?? null : null;
          const services = (data?.services ?? []).filter((s) => s.asset_id === asset.id);
          const warranty = bestWarranty((data?.warranties ?? []).filter((w) => w.asset_id === asset.id), today);
          const photos = (data?.files ?? []).filter((f) => f.asset_id === asset.id).length;
          const age = assetAgeYears(asset, today);
          const where = [siteLabel(asset.site_id), asset.location].filter(Boolean).join(" · ");
          return (
            <div
              key={asset.id}
              className="rounded p-3"
              style={{ border: `1px solid ${asset.needs_details ? "var(--jms-warning)" : "var(--jms-border)"}`, backgroundColor: "var(--jms-bg)", opacity: asset.status === "removed" ? 0.6 : 1 }}
              data-testid="asset-card"
            >
              <div className="flex items-start gap-2">
                <span style={{ fontSize: "1.3rem" }}>{type?.icon ?? "🔧"}</span>
                <div className="min-w-0 flex-1">
                  <button onClick={() => setEditing({ id: asset.id })} className="text-left font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
                    {asset.asset_name}
                  </button>
                  <p style={muted}>
                    {[type?.name, assetSummary(asset), age !== null ? `${age} yr${age === 1 ? "" : "s"} old` : null].filter(Boolean).join(" · ")}
                    {asset.status === "removed" ? ` · removed ${fmtDay(asset.removed_on)}` : ""}
                  </p>
                  {where ? <p style={muted}>{where}</p> : null}
                </div>
                {asset.needs_details ? <span style={{ color: "var(--jms-warning)", fontSize: "var(--jms-font-label)" }}>needs details</span> : null}
              </div>
              {warranty ? (
                <p className="mt-1" style={{ color: STATE_COLOURS[warranty.state], fontSize: "var(--jms-font-label)" }}>
                  {warranty.text}
                </p>
              ) : null}
              {services.length ? (
                <ul className="mt-1 space-y-0.5">
                  {services.map((s) => {
                    const state = serviceState(s.next_due_on, today, type?.lead_days ?? 28);
                    // While a tick is saving, show it straight away.
                    const pending = tick.isPending && tick.variables?.service.id === s.id ? tick.variables.done : null;
                    const doneHere = pending ?? (jobRecords ?? []).some((r) => r.service_id === s.id);
                    return (
                      <li key={s.id} className="flex items-center gap-2" style={{ fontSize: "var(--jms-font-label)" }}>
                        {jobCardId && asset.status === "active" ? (
                          <input
                            type="checkbox"
                            checked={doneHere}
                            onChange={(e) => tick.mutate({ asset, service: s, done: e.target.checked })}
                            aria-label={`${s.name} done on this job`}
                          />
                        ) : null}
                        <span style={{ color: "var(--jms-text)" }}>{s.name}</span>
                        <span style={{ color: STATE_COLOURS[doneHere ? "ok" : state] }}>
                          {doneHere ? "done on this job" : s.next_due_on ? `${state === "overdue" ? "overdue since" : "due"} ${fmtDay(s.next_due_on)}` : "no date yet"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {photos ? <p className="mt-1" style={muted}>📷 {photos}</p> : null}
            </div>
          );
        })}
      </div>
      {editing ? (
        <AssetEditor
          open
          onClose={() => setEditing(null)}
          owner={owner}
          assetId={editing.id}
          sites={sites}
          defaultSiteId={jobSiteId}
          jobCardId={jobCardId}
        />
      ) : null}
    </>
  );

  if (bare) return content;
  return (
    <div className="mt-6 rounded p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }} data-testid="assets-section">
      <h2 className="mb-3 font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
        {title}
      </h2>
      {content}
    </div>
  );
}

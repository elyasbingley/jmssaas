import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ASSET_CLAIM_STATUS_LABELS,
  assetAgeYears,
  replacementDueDate,
  serviceState,
  sydneyToday,
  warrantyState,
  type Asset,
  type AssetClaimStatus,
  type AssetField,
  type AssetFile,
  type AssetService,
  type AssetServiceRecord,
  type AssetType,
  type AssetWarranty,
  type AssetWarrantyClaim,
  type AssetWarrantyKind,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ASSETS_KEY, createAsset, fetchAssetTypes, signedFileUrl, uploadAssetFile, type AssetOwner } from "../lib/assets-data";
import { ThemedButton } from "./theme/ThemedButton";

// One asset: details, warranties, service plan, history, photos/files and
// warranty claims (asset_register migration). Used from the register, the
// client / property pages and the job page.

const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const body = { color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
const inputClass = "w-full rounded border px-2 py-1.5 focus:outline-none";
const inputStyle = { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)", fontFamily: "var(--jms-font)" } as const;
const link = { color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" } as const;

export const STATE_COLOURS: Record<string, string> = {
  overdue: "var(--jms-danger)",
  expired: "var(--jms-danger)",
  due: "var(--jms-warning)",
  expiring: "var(--jms-warning)",
  ok: "var(--jms-accent)",
  active: "var(--jms-accent)",
  unknown: "var(--jms-text-muted)",
};

export function fmtDay(day: string | null | undefined): string {
  if (!day) return "-";
  return new Date(`${day}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block uppercase tracking-wide" style={muted}>
      {children}
    </span>
  );
}

function TextInput({ value, onChange, type = "text", placeholder, ariaLabel }: { value: string; onChange: (v: string) => void; type?: string; placeholder?: string; ariaLabel?: string }) {
  return <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={ariaLabel} className={inputClass} style={inputStyle} />;
}

type Tab = "details" | "warranties" | "services" | "history" | "files" | "claims";

export function AssetEditor({
  open,
  onClose,
  owner,
  assetId,
  sites,
  defaultSiteId,
  jobCardId,
}: {
  open: boolean;
  onClose: () => void;
  owner: AssetOwner;
  assetId: string | null;
  sites?: { id: string; label: string }[];
  defaultSiteId?: string | null;
  jobCardId?: string | null;
}) {
  const [currentId, setCurrentId] = useState<string | null>(assetId);
  const [tab, setTab] = useState<Tab>("details");
  useEffect(() => {
    setCurrentId(assetId);
    setTab("details");
  }, [assetId, open]);
  if (!open) return null;
  const tabs: { key: Tab; label: string }[] = [
    { key: "details", label: "Details" },
    { key: "warranties", label: "Warranties" },
    { key: "services", label: "Services" },
    { key: "history", label: "History" },
    { key: "files", label: "Photos & files" },
    { key: "claims", label: "Claims" },
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4" onClick={onClose} style={{ fontFamily: "var(--jms-font)" }}>
      <div
        className="my-8 w-full max-w-3xl rounded p-6"
        onClick={(e) => e.stopPropagation()}
        style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)", boxShadow: "0 0 24px var(--jms-accent-glow)" }}
        role="dialog"
        aria-label="Asset"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            {currentId ? "Asset" : "New asset"}
          </h2>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none" style={{ color: "var(--jms-text-muted)" }}>
            ×
          </button>
        </div>
        {currentId ? (
          <div className="mb-4 flex flex-wrap gap-1" style={{ borderBottom: "1px solid var(--jms-border)" }}>
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className="border-b-2 px-3 py-1.5 font-semibold uppercase tracking-wide"
                style={tab === t.key ? { borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" } : { borderColor: "transparent", ...muted }}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : null}
        <AssetEditorBody owner={owner} assetId={currentId} onCreated={setCurrentId} tab={tab} sites={sites} defaultSiteId={defaultSiteId} jobCardId={jobCardId} onClose={onClose} />
      </div>
    </div>
  );
}

function useAsset(assetId: string | null) {
  return useQuery({
    queryKey: [...ASSETS_KEY, "one", assetId],
    enabled: !!assetId,
    queryFn: async () => {
      const id = assetId!;
      const [asset, warranties, services, records, files, claims] = await Promise.all([
        supabase.from("property_assets").select("*").eq("id", id).single(),
        supabase.from("asset_warranties").select("*").eq("asset_id", id).order("kind").order("created_at"),
        supabase.from("asset_services").select("*").eq("asset_id", id).order("created_at"),
        supabase.from("asset_service_records").select("*, job_cards(id, number, title), profiles(full_name)").eq("asset_id", id).order("done_on", { ascending: false }),
        supabase.from("asset_files").select("*").eq("asset_id", id).order("created_at", { ascending: false }),
        supabase.from("asset_warranty_claims").select("*").eq("asset_id", id).order("lodged_on", { ascending: false }),
      ]);
      for (const r of [asset, warranties, services, records, files, claims]) if (r.error) throw r.error;
      return {
        asset: asset.data as Asset,
        warranties: warranties.data as AssetWarranty[],
        services: services.data as AssetService[],
        records: records.data as (AssetServiceRecord & { job_cards: { id: string; number: string | null; title: string } | null; profiles: { full_name: string } | null })[],
        files: files.data as AssetFile[],
        claims: claims.data as AssetWarrantyClaim[],
      };
    },
  });
}

function AssetEditorBody({
  owner,
  assetId,
  onCreated,
  tab,
  sites,
  defaultSiteId,
  jobCardId,
  onClose,
}: {
  owner: AssetOwner;
  assetId: string | null;
  onCreated: (id: string) => void;
  tab: Tab;
  sites?: { id: string; label: string }[];
  defaultSiteId?: string | null;
  jobCardId?: string | null;
  onClose: () => void;
}) {
  const { data: types } = useQuery({ queryKey: [...ASSETS_KEY, "types"], queryFn: fetchAssetTypes });
  const { data, error } = useAsset(assetId);
  if (error) return <p style={{ color: "var(--jms-danger)" }}>{getErrorMessage(error, "Couldn't load the asset")}</p>;
  if (!types || (assetId && !data)) return <p style={muted}>Loading...</p>;
  const type = types.find((t) => t.id === data?.asset.asset_type_id) ?? null;
  if (tab === "details" || !assetId || !data)
    return <DetailsTab owner={owner} asset={data?.asset ?? null} types={types} sites={sites} defaultSiteId={defaultSiteId} onCreated={onCreated} onClose={onClose} />;
  if (tab === "warranties") return <WarrantiesTab asset={data.asset} warranties={data.warranties} />;
  if (tab === "services") return <ServicesTab asset={data.asset} type={type} services={data.services} jobCardId={jobCardId} />;
  if (tab === "history") return <HistoryTab records={data.records} services={data.services} />;
  if (tab === "files") return <FilesTab asset={data.asset} files={data.files} />;
  return <ClaimsTab asset={data.asset} warranties={data.warranties} claims={data.claims} jobCardId={jobCardId} />;
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

function DetailsTab({
  owner,
  asset,
  types,
  sites,
  defaultSiteId,
  onCreated,
  onClose,
}: {
  owner: AssetOwner;
  asset: Asset | null;
  types: AssetType[];
  sites?: { id: string; label: string }[];
  defaultSiteId?: string | null;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const activeTypes = types.filter((t) => !t.is_archived || t.id === asset?.asset_type_id);
  const [typeId, setTypeId] = useState(asset?.asset_type_id ?? activeTypes[0]?.id ?? "");
  const [name, setName] = useState(asset?.asset_name ?? "");
  const [siteId, setSiteId] = useState(asset ? asset.site_id ?? "" : defaultSiteId ?? "");
  const [installedOn, setInstalledOn] = useState(asset?.installed_on ?? "");
  const [installYear, setInstallYear] = useState(asset?.install_year ? String(asset.install_year) : "");
  const [location, setLocation] = useState(asset?.location ?? "");
  const [notes, setNotes] = useState(asset?.notes ?? "");
  const [attrs, setAttrs] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(asset?.attributes ?? {}).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)]))
  );
  const [removing, setRemoving] = useState(false);
  const [removedOn, setRemovedOn] = useState(sydneyToday());
  const [removedReason, setRemovedReason] = useState("");
  const [saved, setSaved] = useState(false);
  const type = types.find((t) => t.id === typeId) ?? null;
  const today = sydneyToday();

  const fieldValues = (fields: AssetField[]) => {
    const out: Record<string, string | number | null> = { ...Object.fromEntries(Object.entries(asset?.attributes ?? {}).map(([k, v]) => [k, (v ?? null) as string | number | null])) };
    for (const f of fields) {
      const v = (attrs[f.key] ?? "").trim();
      out[f.key] = v === "" ? null : f.type === "number" && !Number.isNaN(Number(v)) ? Number(v) : v;
    }
    return out;
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const year = installYear.trim() ? Number(installYear) : null;
      if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200)) throw new Error("Install year should be like 2014");
      const fields = {
        asset_name: name.trim() || type?.name || "Asset",
        attributes: fieldValues(type?.fields ?? []),
        site_id: owner.type === "client" ? siteId || null : null,
        installed_on: installedOn || null,
        install_year: installedOn ? null : year,
        location: location.trim() || null,
        notes: notes.trim() || null,
      };
      if (!asset) {
        return createAsset({ tenantId: profile.tenant_id, createdBy: profile.id, owner, type, fields });
      }
      const { error } = await supabase
        .from("property_assets")
        .update({ ...fields, asset_type_id: type?.id ?? null, category: type?.category ?? asset.category, needs_details: false })
        .eq("id", asset.id);
      if (error) throw error;
      return asset.id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ASSETS_KEY });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      if (!asset) onCreated(id);
    },
  });

  const setStatus = useMutation({
    mutationFn: async (remove: boolean) => {
      const { error } = await supabase
        .from("property_assets")
        .update(remove ? { status: "removed", removed_on: removedOn, removed_reason: removedReason.trim() || null } : { status: "active", removed_on: null, removed_reason: null })
        .eq("id", asset!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setRemoving(false);
      queryClient.invalidateQueries({ queryKey: ASSETS_KEY });
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("property_assets").delete().eq("id", asset!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ASSETS_KEY });
      onClose();
    },
  });

  const age = asset ? assetAgeYears(asset, today) : null;
  const replaceOn = asset && type ? replacementDueDate(asset, type) : null;

  return (
    <div>
      {asset?.needs_details ? (
        <p className="mb-3 rounded p-2" style={{ border: "1px solid var(--jms-warning)", color: "var(--jms-warning)", fontSize: "var(--jms-font-body)" }}>
          Added automatically from a completed job - check the details, add the serial number and a photo of the data plate, then save.
        </p>
      ) : null}
      {asset?.status === "removed" ? (
        <p className="mb-3 rounded p-2" style={{ border: "1px solid var(--jms-border)", ...body }}>
          Removed {fmtDay(asset.removed_on)}
          {asset.removed_reason ? ` - ${asset.removed_reason}` : ""}.{" "}
          <button onClick={() => setStatus.mutate(false)} className="font-semibold hover:underline" style={link}>
            Put back on the register
          </button>
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label>
          <Label>Type</Label>
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={inputClass} style={inputStyle} aria-label="Type">
            {activeTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.icon ? `${t.icon} ` : ""}
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <Label>Name</Label>
          <TextInput value={name} onChange={setName} placeholder={type?.name ?? "e.g. Rheem Stellar 330"} ariaLabel="Name" />
        </label>
        {owner.type === "client" && sites && sites.length > 0 ? (
          <label>
            <Label>Address</Label>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={inputClass} style={inputStyle} aria-label="Address">
              <option value="">Their main address</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <Label>Where it is</Label>
          <TextInput value={location} onChange={setLocation} placeholder="e.g. garage, back of house" ariaLabel="Where it is" />
        </label>
        <label>
          <Label>Installed on</Label>
          <TextInput type="date" value={installedOn} onChange={setInstalledOn} ariaLabel="Installed on" />
        </label>
        <label>
          <Label>Or about what year (if the date isn't known)</Label>
          <TextInput value={installedOn ? "" : installYear} onChange={setInstallYear} placeholder="e.g. 2014" ariaLabel="Install year" />
        </label>
        {(type?.fields ?? []).map((f) => (
          <label key={f.key}>
            <Label>{f.label}</Label>
            {f.type === "select" ? (
              <select value={attrs[f.key] ?? ""} onChange={(e) => setAttrs({ ...attrs, [f.key]: e.target.value })} className={inputClass} style={inputStyle} aria-label={f.label}>
                <option value="">-</option>
                {[...(f.options ?? []), ...(attrs[f.key] && !(f.options ?? []).includes(attrs[f.key]!) ? [attrs[f.key]!] : [])].map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <TextInput type={f.type === "date" ? "date" : "text"} value={attrs[f.key] ?? ""} onChange={(v) => setAttrs({ ...attrs, [f.key]: v })} ariaLabel={f.label} />
            )}
          </label>
        ))}
      </div>
      <label className="mt-3 block">
        <Label>Notes</Label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputClass} style={inputStyle} aria-label="Notes" />
      </label>
      {asset ? (
        <p className="mt-2" style={muted}>
          {age !== null ? `${age} year${age === 1 ? "" : "s"} old. ` : "Install date not known. "}
          {replaceOn ? `Due for replacement around ${fmtDay(replaceOn)}.` : ""}
          {asset.installed_by_job_id ? (
            <>
              {" "}
              Installed on{" "}
              <Link to={`/jobs/${asset.installed_by_job_id}`} className="hover:underline" style={link}>
                this job
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : (
        <p className="mt-2" style={muted}>
          {type && (type.default_services.length || type.default_warranties.length)
            ? `Adds the ${type.name.toLowerCase()} service plan (${type.default_services.map((s) => `${s.name.toLowerCase()} every ${s.interval_months} months`).join(", ") || "none"})${type.default_warranties.length ? " and default warranties" : ""}. You can change them after.`
            : ""}
        </p>
      )}
      {save.error ? <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(save.error, "Couldn't save")}</p> : null}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <ThemedButton onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving..." : asset ? "Save" : "Add asset"}
        </ThemedButton>
        {saved ? <span style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>Saved.</span> : null}
        {asset && asset.status === "active" ? (
          <button onClick={() => setRemoving((v) => !v)} className="font-semibold hover:underline" style={link}>
            Removed or replaced?
          </button>
        ) : null}
        {asset && isAdmin ? (
          <button
            onClick={() => window.confirm("Delete this asset and its history? Use 'Removed or replaced' instead to keep the history.") && remove.mutate()}
            className="ml-auto font-semibold hover:underline"
            style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}
          >
            Delete
          </button>
        ) : null}
      </div>
      {removing ? (
        <div className="mt-3 flex flex-wrap items-end gap-3 rounded p-3" style={{ border: "1px solid var(--jms-border)" }}>
          <label>
            <Label>Removed on</Label>
            <TextInput type="date" value={removedOn} onChange={setRemovedOn} ariaLabel="Removed on" />
          </label>
          <label className="min-w-[14rem] flex-1">
            <Label>Why</Label>
            <TextInput value={removedReason} onChange={setRemovedReason} placeholder="e.g. replaced with a heat pump" ariaLabel="Why removed" />
          </label>
          <ThemedButton variant="secondary" onClick={() => setStatus.mutate(true)} disabled={setStatus.isPending}>
            Mark removed
          </ThemedButton>
          <p className="w-full" style={muted}>
            It stays on the register with its history but stops getting reminders.
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Warranties
// ---------------------------------------------------------------------------

type WarrantyDraft = Pick<AssetWarranty, "kind" | "label" | "starts_on" | "expires_on" | "notes"> & { id: string; isNew?: boolean };

function WarrantiesTab({ asset, warranties }: { asset: Asset; warranties: AssetWarranty[] }) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<WarrantyDraft[]>(warranties.map((w) => ({ ...w })));
  const [removed, setRemoved] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setRows(warranties.map((w) => ({ ...w })));
    setRemoved([]);
  }, [warranties]);
  const today = sydneyToday();
  const save = useMutation({
    mutationFn: async () => {
      if (removed.length) {
        const { error } = await supabase.from("asset_warranties").delete().in("id", removed);
        if (error) throw error;
      }
      for (const r of rows) {
        const row = { kind: r.kind, label: r.label, starts_on: r.starts_on || null, expires_on: r.expires_on || null, notes: r.notes || null };
        const { error } = r.isNew
          ? await supabase.from("asset_warranties").insert({ ...row, id: r.id, tenant_id: asset.tenant_id, asset_id: asset.id })
          : await supabase.from("asset_warranties").update(row).eq("id", r.id);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ASSETS_KEY });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });
  const add = (kind: AssetWarrantyKind) =>
    setRows([...rows, { id: crypto.randomUUID(), isNew: true, kind, label: kind === "workmanship" ? "Workmanship" : "", starts_on: asset.installed_on, expires_on: null, notes: null }]);
  const update = (id: string, patch: Partial<WarrantyDraft>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const group = (kind: AssetWarrantyKind, title: string) => (
    <div className="mb-4">
      <p className="mb-2 font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
        {title}
      </p>
      {rows.filter((r) => r.kind === kind).length === 0 ? <p style={muted}>None recorded.</p> : null}
      {rows
        .filter((r) => r.kind === kind)
        .map((r) => {
          const state = warrantyState(r.expires_on, today);
          return (
            <div key={r.id} className="mb-2 grid grid-cols-2 items-end gap-2 md:grid-cols-[1.3fr_1fr_1fr_1.5fr_auto]" data-testid={`warranty-${kind}`}>
              <label>
                <Label>What it covers</Label>
                <TextInput value={r.label} onChange={(v) => update(r.id, { label: v })} placeholder={kind === "manufacturer" ? "e.g. Cylinder" : "Workmanship"} ariaLabel="Warranty covers" />
              </label>
              <label>
                <Label>From</Label>
                <TextInput type="date" value={r.starts_on ?? ""} onChange={(v) => update(r.id, { starts_on: v })} ariaLabel="Warranty from" />
              </label>
              <label>
                <Label>Until</Label>
                <TextInput type="date" value={r.expires_on ?? ""} onChange={(v) => update(r.id, { expires_on: v })} ariaLabel="Warranty until" />
              </label>
              <label>
                <Label>Notes</Label>
                <TextInput value={r.notes ?? ""} onChange={(v) => update(r.id, { notes: v })} placeholder="e.g. registered online, ref 1234" ariaLabel="Warranty notes" />
              </label>
              <div className="flex items-center gap-2 pb-1.5">
                <span style={{ color: STATE_COLOURS[state], fontSize: "var(--jms-font-label)" }}>{state === "unknown" ? "" : state}</span>
                <button
                  onClick={() => {
                    setRows(rows.filter((x) => x.id !== r.id));
                    if (!r.isNew) setRemoved([...removed, r.id]);
                  }}
                  aria-label="Remove warranty"
                  style={{ color: "var(--jms-danger)" }}
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
      <button onClick={() => add(kind)} className="font-semibold hover:underline" style={link}>
        + Add {kind === "manufacturer" ? "a manufacturer warranty" : "your workmanship warranty"}
      </button>
    </div>
  );
  return (
    <div>
      {group("manufacturer", "Manufacturer")}
      {group("workmanship", "Your workmanship")}
      <div className="flex items-center gap-3">
        <ThemedButton onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving..." : "Save warranties"}
        </ThemedButton>
        {saved ? <span style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>Saved.</span> : null}
        {save.error ? <span style={{ color: "var(--jms-danger)" }}>{getErrorMessage(save.error, "Couldn't save")}</span> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

type ServiceDraft = Pick<AssetService, "name" | "interval_months" | "last_done_on" | "next_due_on" | "notes"> & { id: string; isNew?: boolean };

function ServicesTab({ asset, type, services, jobCardId }: { asset: Asset; type: AssetType | null; services: AssetService[]; jobCardId?: string | null }) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const [rows, setRows] = useState<ServiceDraft[]>(services.map((s) => ({ ...s })));
  const [removed, setRemoved] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setRows(services.map((s) => ({ ...s })));
    setRemoved([]);
  }, [services]);
  const today = sydneyToday();
  const lead = type?.lead_days ?? 28;
  const save = useMutation({
    mutationFn: async () => {
      if (removed.length) {
        const { error } = await supabase.from("asset_services").delete().in("id", removed);
        if (error) throw error;
      }
      for (const r of rows) {
        if (!r.name.trim()) throw new Error("Every service needs a name");
        const original = services.find((s) => s.id === r.id);
        const row = {
          name: r.name.trim(),
          interval_months: r.interval_months || null,
          last_done_on: r.last_done_on || null,
          // Only send the due date when it was changed by hand, so the
          // database works it out from last done / interval otherwise.
          ...(r.isNew || (original && (r.next_due_on || null) !== original.next_due_on) ? { next_due_on: r.next_due_on || null } : {}),
          notes: r.notes || null,
        };
        const { error } = r.isNew
          ? await supabase.from("asset_services").insert({ ...row, id: r.id, tenant_id: asset.tenant_id, asset_id: asset.id })
          : await supabase.from("asset_services").update(row).eq("id", r.id);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ASSETS_KEY });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });
  const doneNow = useMutation({
    mutationFn: async (serviceId: string) => {
      const { error } = await supabase.from("asset_service_records").insert({
        tenant_id: asset.tenant_id,
        asset_id: asset.id,
        service_id: serviceId,
        job_card_id: jobCardId ?? null,
        done_on: today,
        done_by: profile?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ASSETS_KEY }),
  });
  const update = (id: string, patch: Partial<ServiceDraft>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div>
      <p className="mb-3" style={muted}>
        Each service has its own interval. Ticking one off on a job (or "Done today") moves its next due date on. Reminders go out {lead} days ahead.
      </p>
      {rows.length === 0 ? <p className="mb-2" style={muted}>No services yet.</p> : null}
      {rows.map((r) => {
        const state = serviceState(r.next_due_on, today, lead);
        return (
          <div key={r.id} className="mb-3 grid grid-cols-2 items-end gap-2 md:grid-cols-[1.5fr_0.7fr_1fr_1fr_auto]" data-testid="service-row">
            <label>
              <Label>Service</Label>
              <TextInput value={r.name} onChange={(v) => update(r.id, { name: v })} placeholder="e.g. Relief valve check" ariaLabel="Service name" />
            </label>
            <label>
              <Label>Every (months)</Label>
              <TextInput value={r.interval_months ? String(r.interval_months) : ""} onChange={(v) => update(r.id, { interval_months: v.trim() ? Number(v) || null : null })} ariaLabel="Interval months" />
            </label>
            <label>
              <Label>Last done</Label>
              <TextInput type="date" value={r.last_done_on ?? ""} onChange={(v) => update(r.id, { last_done_on: v })} ariaLabel="Last done" />
            </label>
            <label>
              <Label>Next due</Label>
              <TextInput type="date" value={r.next_due_on ?? ""} onChange={(v) => update(r.id, { next_due_on: v })} ariaLabel="Next due" />
            </label>
            <div className="flex items-center gap-2 pb-1.5">
              <span style={{ color: STATE_COLOURS[state], fontSize: "var(--jms-font-label)" }}>{state === "unknown" ? "no date" : state}</span>
              {!r.isNew ? (
                <button onClick={() => doneNow.mutate(r.id)} className="whitespace-nowrap font-semibold hover:underline" style={link} disabled={doneNow.isPending}>
                  Done today
                </button>
              ) : null}
              <button
                onClick={() => {
                  setRows(rows.filter((x) => x.id !== r.id));
                  if (!r.isNew) setRemoved([...removed, r.id]);
                }}
                aria-label="Remove service"
                style={{ color: "var(--jms-danger)" }}
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
      <button
        onClick={() => setRows([...rows, { id: crypto.randomUUID(), isNew: true, name: "", interval_months: 12, last_done_on: null, next_due_on: null, notes: null }])}
        className="mb-4 font-semibold hover:underline"
        style={link}
      >
        + Add a service
      </button>
      <div className="flex items-center gap-3">
        <ThemedButton onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving..." : "Save services"}
        </ThemedButton>
        {saved ? <span style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>Saved.</span> : null}
        {save.error || doneNow.error ? <span style={{ color: "var(--jms-danger)" }}>{getErrorMessage(save.error ?? doneNow.error, "Couldn't save")}</span> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History, files, claims
// ---------------------------------------------------------------------------

function HistoryTab({
  records,
  services,
}: {
  records: (AssetServiceRecord & { job_cards: { id: string; number: string | null; title: string } | null; profiles: { full_name: string } | null })[];
  services: AssetService[];
}) {
  if (records.length === 0) return <p style={muted}>No services recorded yet. They appear here when a service is ticked off on a job or marked done.</p>;
  return (
    <ul className="space-y-2">
      {records.map((r) => (
        <li key={r.id} className="rounded p-2" style={{ border: "1px solid var(--jms-border)", ...body }} data-testid="history-row">
          <span className="font-semibold">{fmtDay(r.done_on)}</span> · {services.find((s) => s.id === r.service_id)?.name ?? "Work on this asset"}
          {r.job_cards ? (
            <>
              {" "}
              ·{" "}
              <Link to={`/jobs/${r.job_cards.id}`} className="hover:underline" style={link}>
                {r.job_cards.number ?? ""} {r.job_cards.title}
              </Link>
            </>
          ) : null}
          {r.profiles ? <span style={muted}> · {r.profiles.full_name}</span> : null}
          {r.note ? <p style={muted}>{r.note}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function FileThumb({ file }: { file: AssetFile }) {
  const { data: url } = useQuery({ queryKey: [...ASSETS_KEY, "file-url", file.storage_path], queryFn: () => signedFileUrl(file.storage_path), staleTime: 30 * 60_000 });
  if (file.kind === "photo") {
    return url ? (
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt={file.caption ?? "Asset photo"} className="h-28 w-28 rounded object-cover" style={{ border: "1px solid var(--jms-border)" }} />
      </a>
    ) : (
      <div className="h-28 w-28 rounded" style={{ border: "1px solid var(--jms-border)" }} />
    );
  }
  return (
    <a href={url ?? "#"} target="_blank" rel="noreferrer" className="flex h-28 w-28 items-center justify-center rounded p-2 text-center hover:underline" style={{ border: "1px solid var(--jms-border)", ...link }}>
      📄 {file.file_name}
    </a>
  );
}

function FilesTab({ asset, files }: { asset: Asset; files: AssetFile[] }) {
  const queryClient = useQueryClient();
  const { profile, isAdmin } = useAuth();
  const [caption, setCaption] = useState("");
  const upload = useMutation({
    mutationFn: async (list: FileList) => {
      if (!profile) throw new Error("Not signed in");
      for (const file of Array.from(list)) await uploadAssetFile({ tenantId: profile.tenant_id, assetId: asset.id, uploadedBy: profile.id, file, caption: caption.trim() || undefined });
    },
    onSuccess: () => {
      setCaption("");
      queryClient.invalidateQueries({ queryKey: ASSETS_KEY });
    },
  });
  const remove = useMutation({
    mutationFn: async (file: AssetFile) => {
      await supabase.storage.from("job-files").remove([file.storage_path]);
      const { error } = await supabase.from("asset_files").delete().eq("id", file.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ASSETS_KEY }),
  });
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="min-w-[14rem] flex-1">
          <Label>Caption (optional)</Label>
          <TextInput value={caption} onChange={setCaption} placeholder="e.g. data plate, compliance certificate" ariaLabel="Caption" />
        </label>
        <label className="cursor-pointer rounded border px-3 py-1.5 font-semibold" style={{ borderColor: "var(--jms-border)", ...link }}>
          {upload.isPending ? "Uploading..." : "+ Add photos or files"}
          <input type="file" multiple className="hidden" onChange={(e) => e.target.files && upload.mutate(e.target.files)} aria-label="Add photos or files" />
        </label>
      </div>
      {upload.error ? <p className="mb-2" style={{ color: "var(--jms-danger)" }}>{getErrorMessage(upload.error, "Couldn't upload")}</p> : null}
      {files.length === 0 ? <p style={muted}>No photos or files yet - a photo of the data plate is the most useful one.</p> : null}
      <div className="flex flex-wrap gap-3">
        {files.map((f) => (
          <div key={f.id} className="w-28" data-testid="asset-file">
            <FileThumb file={f} />
            <p className="mt-1 truncate" style={muted} title={f.caption ?? f.file_name}>
              {f.caption ?? (f.kind === "photo" ? fmtDay(f.created_at.slice(0, 10)) : "")}
            </p>
            {isAdmin || f.uploaded_by === profile?.id ? (
              <button onClick={() => window.confirm("Delete this file?") && remove.mutate(f)} style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                Delete
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function ClaimsTab({ asset, warranties, claims, jobCardId }: { asset: Asset; warranties: AssetWarranty[]; claims: AssetWarrantyClaim[]; jobCardId?: string | null }) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const blank = { warranty_id: "", lodged_on: sydneyToday(), claim_with: "", reference: "", status: "lodged" as AssetClaimStatus, parts_supplied: "", notes: "" };
  const [form, setForm] = useState(blank);
  const [adding, setAdding] = useState(false);
  const warrantyLabel = useMemo(() => new Map(warranties.map((w) => [w.id, `${w.kind === "workmanship" ? "Workmanship" : "Manufacturer"}${w.label ? `: ${w.label}` : ""}`])), [warranties]);
  const add = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("asset_warranty_claims").insert({
        tenant_id: asset.tenant_id,
        asset_id: asset.id,
        warranty_id: form.warranty_id || null,
        job_card_id: jobCardId ?? null,
        lodged_on: form.lodged_on,
        claim_with: form.claim_with.trim() || null,
        reference: form.reference.trim() || null,
        status: form.status,
        parts_supplied: form.parts_supplied.trim() || null,
        notes: form.notes.trim() || null,
        created_by: profile?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setForm(blank);
      setAdding(false);
      queryClient.invalidateQueries({ queryKey: ASSETS_KEY });
    },
  });
  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: AssetClaimStatus }) => {
      const { error } = await supabase.from("asset_warranty_claims").update({ status }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ASSETS_KEY }),
  });
  return (
    <div>
      {claims.length === 0 && !adding ? <p className="mb-3" style={muted}>No warranty claims.</p> : null}
      <ul className="mb-3 space-y-2">
        {claims.map((c) => (
          <li key={c.id} className="rounded p-2" style={{ border: "1px solid var(--jms-border)", ...body }} data-testid="claim-row">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{fmtDay(c.lodged_on)}</span>
              <span>· {c.claim_with ?? "Claim"}</span>
              {c.reference ? <span style={muted}>· ref {c.reference}</span> : null}
              {c.warranty_id ? <span style={muted}>· {warrantyLabel.get(c.warranty_id)}</span> : null}
              <select
                value={c.status}
                onChange={(e) => setStatus.mutate({ id: c.id, status: e.target.value as AssetClaimStatus })}
                className="ml-auto rounded border px-2 py-0.5"
                style={inputStyle}
                aria-label="Claim status"
              >
                {Object.entries(ASSET_CLAIM_STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            {c.parts_supplied ? <p style={muted}>Parts: {c.parts_supplied}</p> : null}
            {c.notes ? <p style={muted}>{c.notes}</p> : null}
          </li>
        ))}
      </ul>
      {adding ? (
        <div className="grid grid-cols-1 gap-2 rounded p-3 md:grid-cols-2" style={{ border: "1px solid var(--jms-border)" }}>
          <label>
            <Label>Against which warranty</Label>
            <select value={form.warranty_id} onChange={(e) => setForm({ ...form, warranty_id: e.target.value })} className={inputClass} style={inputStyle} aria-label="Warranty">
              <option value="">-</option>
              {warranties.map((w) => (
                <option key={w.id} value={w.id}>
                  {warrantyLabel.get(w.id)} (until {fmtDay(w.expires_on)})
                </option>
              ))}
            </select>
          </label>
          <label>
            <Label>Lodged on</Label>
            <TextInput type="date" value={form.lodged_on} onChange={(v) => setForm({ ...form, lodged_on: v })} ariaLabel="Lodged on" />
          </label>
          <label>
            <Label>Lodged with</Label>
            <TextInput value={form.claim_with} onChange={(v) => setForm({ ...form, claim_with: v })} placeholder="e.g. Rheem" ariaLabel="Lodged with" />
          </label>
          <label>
            <Label>Claim / reference number</Label>
            <TextInput value={form.reference} onChange={(v) => setForm({ ...form, reference: v })} ariaLabel="Reference" />
          </label>
          <label>
            <Label>Status</Label>
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as AssetClaimStatus })} className={inputClass} style={inputStyle} aria-label="New claim status">
              {Object.entries(ASSET_CLAIM_STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            <Label>Parts supplied</Label>
            <TextInput value={form.parts_supplied} onChange={(v) => setForm({ ...form, parts_supplied: v })} placeholder="e.g. replacement element" ariaLabel="Parts supplied" />
          </label>
          <label className="md:col-span-2">
            <Label>Notes</Label>
            <TextInput value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} placeholder="What happened" ariaLabel="Claim notes" />
          </label>
          <div className="flex items-center gap-3 md:col-span-2">
            <ThemedButton onClick={() => add.mutate()} disabled={add.isPending}>
              {add.isPending ? "Saving..." : "Save claim"}
            </ThemedButton>
            <button onClick={() => setAdding(false)} style={muted}>
              Cancel
            </button>
            {add.error ? <span style={{ color: "var(--jms-danger)" }}>{getErrorMessage(add.error, "Couldn't save")}</span> : null}
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="font-semibold hover:underline" style={link}>
          + Log a warranty claim
        </button>
      )}
    </div>
  );
}

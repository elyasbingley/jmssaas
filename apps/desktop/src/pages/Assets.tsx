import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ASSET_CLAIM_STATUS_LABELS,
  addMonths,
  assetAgeYears,
  assetSummary,
  replacementDueDate,
  serviceState,
  sydneyToday,
  warrantyState,
  type Asset,
  type AssetType,
} from "@jmssaas/shared";
import { fetchAllRows } from "../lib/fetch-all-rows";
import { getErrorMessage } from "../lib/errors";
import { ASSETS_KEY, fetchAllAssets, fetchAssetTypes, type AssetOwner } from "../lib/assets-data";
import { AssetEditor, STATE_COLOURS, fmtDay } from "../components/AssetEditor";
import { bestWarranty } from "../components/AssetsSection";
import { downloadCsv } from "./analytics/ui";

// The asset register: every client's and agency property's assets, and the
// lists to work from - services coming due, things old enough to replace,
// warranties running out, and warranty claims (asset_register migration).

type Tab = "all" | "service" | "replacement" | "warranties" | "claims";

interface Owner {
  name: string;
  link: string;
  phone: string | null;
  address: string;
  suburb: string;
}

const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const cell = "px-3 py-2 align-top";
const inputStyle = { backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;

export default function AssetsPage() {
  const today = sydneyToday();
  const { data, error } = useQuery({ queryKey: [...ASSETS_KEY, "all"], queryFn: fetchAllAssets });
  const { data: types } = useQuery({ queryKey: [...ASSETS_KEY, "types"], queryFn: fetchAssetTypes });
  const { data: people } = useQuery({
    queryKey: [...ASSETS_KEY, "owners"],
    queryFn: async () => {
      const [clients, sites, properties] = await Promise.all([
        fetchAllRows<{ id: string; name: string; phone: string | null; address_line1: string | null; suburb: string | null }>("clients", "id, name, phone, address_line1, suburb"),
        fetchAllRows<{ id: string; label: string | null; address_line1: string; suburb: string }>("client_sites", "id, label, address_line1, suburb"),
        fetchAllRows<{ id: string; address_line1: string; suburb: string; owner_landlord_name: string | null }>("properties", "id, address_line1, suburb, owner_landlord_name"),
      ]);
      return { clients, sites, properties };
    },
  });

  const [tab, setTab] = useState<Tab>("service");
  const [search, setSearch] = useState("");
  const [typeId, setTypeId] = useState("");
  const [suburb, setSuburb] = useState("");
  const [range, setRange] = useState("lead");
  const [showRemoved, setShowRemoved] = useState(false);
  const [editing, setEditing] = useState<{ owner: AssetOwner; id: string } | null>(null);

  const typeById = useMemo(() => new Map((types ?? []).map((t) => [t.id, t])), [types]);
  const ownerOf = useMemo(() => {
    const clients = new Map((people?.clients ?? []).map((c) => [c.id, c]));
    const sites = new Map((people?.sites ?? []).map((s) => [s.id, s]));
    const properties = new Map((people?.properties ?? []).map((p) => [p.id, p]));
    return (a: Asset): Owner => {
      if (a.property_id) {
        const p = properties.get(a.property_id);
        return { name: p ? `${p.address_line1} (agency)` : "Property", link: `/real-estate/properties/${a.property_id}`, phone: null, address: p ? `${p.address_line1}, ${p.suburb}` : "", suburb: p?.suburb ?? "" };
      }
      const c = a.client_id ? clients.get(a.client_id) : undefined;
      const s = a.site_id ? sites.get(a.site_id) : undefined;
      return {
        name: c?.name ?? "Client",
        link: `/clients/${a.client_id}`,
        phone: c?.phone ?? null,
        address: s ? `${s.address_line1}, ${s.suburb}` : [c?.address_line1, c?.suburb].filter(Boolean).join(", "),
        suburb: s?.suburb ?? c?.suburb ?? "",
      };
    };
  }, [people]);

  const assets = (data?.assets ?? []).filter((a) => showRemoved || a.status === "active");
  const suburbs = useMemo(() => [...new Set(assets.map((a) => ownerOf(a).suburb).filter(Boolean))].sort(), [assets, ownerOf]);
  const matches = (a: Asset) => {
    const o = ownerOf(a);
    const q = search.trim().toLowerCase();
    return (
      (!typeId || a.asset_type_id === typeId) &&
      (!suburb || o.suburb === suburb) &&
      (!q || `${a.asset_name} ${assetSummary(a)} ${o.name} ${o.address}`.toLowerCase().includes(q))
    );
  };
  const filtered = assets.filter(matches);
  const typeOf = (a: Asset): AssetType | null => (a.asset_type_id ? typeById.get(a.asset_type_id) ?? null : null);
  const open = (a: Asset) => setEditing({ owner: a.property_id ? { type: "property", id: a.property_id } : { type: "client", id: a.client_id! }, id: a.id });

  // "Due within" for the service list: the type's own lead time by default.
  const horizon = (a: Asset): string =>
    range === "overdue" ? today : range === "lead" ? addDays(today, typeOf(a)?.lead_days ?? 28) : addMonths(today, Number(range));

  const dueServices = (data?.services ?? [])
    .map((s) => ({ s, a: filtered.find((a) => a.id === s.asset_id) }))
    .filter((x): x is { s: (typeof x)["s"]; a: Asset } => !!x.a && x.a.status === "active" && !!x.s.next_due_on && x.s.next_due_on <= horizon(x.a))
    .filter((x) => range !== "overdue" || x.s.next_due_on! < today)
    .sort((a, b) => a.s.next_due_on!.localeCompare(b.s.next_due_on!));
  const replacements = filtered
    .filter((a) => a.status === "active")
    .map((a) => ({ a, due: replacementDueDate(a, typeOf(a)) }))
    .filter((x): x is { a: Asset; due: string } => !!x.due && x.due <= (range === "lead" ? addDays(today, typeOf(x.a)?.lead_days ?? 28) : range === "overdue" ? today : addMonths(today, Number(range))))
    .sort((a, b) => a.due.localeCompare(b.due));
  const warrantyDays = range === "lead" ? 90 : range === "overdue" ? 0 : Number(range) * 30;
  const warranties = (data?.warranties ?? [])
    .map((w) => ({ w, a: filtered.find((a) => a.id === w.asset_id) }))
    .filter((x): x is { w: (typeof x)["w"]; a: Asset } => !!x.a && !!x.w.expires_on && x.w.expires_on >= addDays(today, -90) && x.w.expires_on <= addDays(today, warrantyDays))
    .sort((a, b) => a.w.expires_on!.localeCompare(b.w.expires_on!));
  const claims = (data?.claims ?? []).map((c) => ({ c, a: (data?.assets ?? []).find((a) => a.id === c.asset_id) })).filter((x): x is { c: (typeof x)["c"]; a: Asset } => !!x.a && matches(x.a));

  const exportTab = () => {
    const name = (a: Asset) => `${a.asset_name}${assetSummary(a) ? ` (${assetSummary(a)})` : ""}`;
    if (tab === "service")
      downloadCsv(`service-due-${today}.csv`, ["Due", "Service", "Asset", "Type", "Client", "Phone", "Address", "Last done", "Texted"], dueServices.map(({ s, a }) => [s.next_due_on!, s.name, name(a), typeOf(a)?.name ?? "", ownerOf(a).name, ownerOf(a).phone ?? "", ownerOf(a).address, s.last_done_on ?? "", (s as unknown as { reminded_for: string | null }).reminded_for === s.next_due_on ? "yes" : ""]));
    else if (tab === "replacement")
      downloadCsv(`due-for-replacement-${today}.csv`, ["Replace from", "Asset", "Type", "Age", "Client", "Phone", "Address"], replacements.map(({ a, due }) => [due, name(a), typeOf(a)?.name ?? "", String(assetAgeYears(a, today) ?? ""), ownerOf(a).name, ownerOf(a).phone ?? "", ownerOf(a).address]));
    else if (tab === "warranties")
      downloadCsv(`warranties-${today}.csv`, ["Until", "Warranty", "Kind", "Asset", "Client", "Phone", "Address"], warranties.map(({ w, a }) => [w.expires_on!, w.label, w.kind, name(a), ownerOf(a).name, ownerOf(a).phone ?? "", ownerOf(a).address]));
    else if (tab === "claims")
      downloadCsv(`warranty-claims-${today}.csv`, ["Lodged", "Status", "With", "Reference", "Asset", "Client", "Parts", "Notes"], claims.map(({ c, a }) => [c.lodged_on, ASSET_CLAIM_STATUS_LABELS[c.status], c.claim_with ?? "", c.reference ?? "", name(a), ownerOf(a).name, c.parts_supplied ?? "", c.notes ?? ""]));
    else
      downloadCsv(`assets-${today}.csv`, ["Asset", "Type", "Brand", "Model", "Serial", "Installed", "Age", "Client", "Phone", "Address", "Location", "Status"], filtered.map((a) => [a.asset_name, typeOf(a)?.name ?? "", String(a.attributes?.brand ?? ""), String(a.attributes?.model ?? ""), String(a.attributes?.serial_number ?? ""), a.installed_on ?? (a.install_year ? String(a.install_year) : ""), String(assetAgeYears(a, today) ?? ""), ownerOf(a).name, ownerOf(a).phone ?? "", ownerOf(a).address, a.location ?? "", a.status]));
  };

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "service", label: "Due for service", count: dueServices.length },
    { key: "replacement", label: "Due for replacement", count: replacements.length },
    { key: "warranties", label: "Warranties", count: warranties.length },
    { key: "claims", label: "Claims", count: claims.filter(({ c }) => c.status === "lodged" || c.status === "approved").length },
    { key: "all", label: "All assets", count: filtered.length },
  ];

  const ownerCell = (a: Asset) => {
    const o = ownerOf(a);
    return (
      <td className={cell}>
        <Link to={o.link} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
          {o.name}
        </Link>
        {o.phone ? <span style={muted}> {o.phone}</span> : null}
        <div style={muted}>{o.address}</div>
      </td>
    );
  };
  const assetCell = (a: Asset) => (
    <td className={cell}>
      <button onClick={() => open(a)} className="text-left hover:underline" style={{ color: "var(--jms-text)" }}>
        {typeOf(a)?.icon ?? "🔧"} {a.asset_name}
      </button>
      <div style={muted}>{[typeOf(a)?.name, assetSummary(a), a.status === "removed" ? "removed" : null].filter(Boolean).join(" · ")}</div>
    </td>
  );
  const head = (cols: string[]) => (
    <thead className="uppercase" style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
      <tr>
        {cols.map((c) => (
          <th key={c} className="px-3 py-2 font-semibold">
            {c}
          </th>
        ))}
      </tr>
    </thead>
  );
  const row = (key: string, children: React.ReactNode) => (
    <tr key={key} className="last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
      {children}
    </tr>
  );

  return (
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            Assets
          </h1>
          <p style={muted}>
            Everything installed at clients' and agency properties - what's due for a service or replacement, and warranties running out. Add assets from a client, property or job
            page. Types and service plans are in{" "}
            <Link to="/settings/asset-types" className="underline">
              Settings &gt; Asset types
            </Link>
            ; reminder texts are under{" "}
            <Link to="/follow-ups" className="underline">
              Follow-ups
            </Link>
            .
          </p>
        </div>
        <button onClick={exportTab} className="rounded border px-3 py-1.5 font-semibold" style={{ borderColor: "var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          Export CSV
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-1" style={{ borderBottom: "1px solid var(--jms-border)" }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="border-b-2 px-4 py-2 font-semibold uppercase tracking-wide"
            style={tab === t.key ? { borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" } : { borderColor: "transparent", ...muted }}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, serial, client, address..." className="w-72 rounded border px-3 py-1.5 focus:outline-none" style={inputStyle} />
        <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className="rounded border px-3 py-1.5" style={inputStyle} aria-label="Type">
          <option value="">Every type</option>
          {(types ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select value={suburb} onChange={(e) => setSuburb(e.target.value)} className="rounded border px-3 py-1.5" style={inputStyle} aria-label="Suburb">
          <option value="">Every suburb</option>
          {suburbs.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {tab === "service" || tab === "replacement" || tab === "warranties" ? (
          <select value={range} onChange={(e) => setRange(e.target.value)} className="rounded border px-3 py-1.5" style={inputStyle} aria-label="Due within">
            <option value="overdue">{tab === "warranties" ? "Expired" : "Overdue only"}</option>
            <option value="lead">{tab === "warranties" ? "Within 90 days" : "Due now (each type's lead time)"}</option>
            <option value="3">Within 3 months</option>
            <option value="6">Within 6 months</option>
            <option value="12">Within 12 months</option>
          </select>
        ) : null}
        {tab === "all" ? (
          <label className="flex items-center gap-2" style={muted}>
            <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> Include removed
          </label>
        ) : null}
      </div>

      {error ? <p style={{ color: "var(--jms-danger)" }}>{getErrorMessage(error, "Couldn't load the register")}</p> : null}
      {!data || !people ? (
        <p style={muted}>Loading...</p>
      ) : (
        <div className="overflow-x-auto rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)", color: "var(--jms-text)" }} data-testid={`assets-${tab}`}>
            {tab === "service" ? (
              <>
                {head(["Due", "Service", "Asset", "Client / property", "Last done", "Text"])}
                <tbody>
                  {dueServices.map(({ s, a }) => {
                    const state = serviceState(s.next_due_on, today, typeOf(a)?.lead_days ?? 28);
                    return row(
                      s.id,
                      <>
                        <td className={cell} style={{ color: STATE_COLOURS[state], whiteSpace: "nowrap" }}>
                          {fmtDay(s.next_due_on)}
                          {state === "overdue" ? <div style={{ fontSize: "var(--jms-font-label)" }}>overdue</div> : null}
                        </td>
                        <td className={cell}>{s.name}</td>
                        {assetCell(a)}
                        {ownerCell(a)}
                        <td className={cell} style={muted}>
                          {fmtDay(s.last_done_on)}
                        </td>
                        <td className={cell} style={muted}>
                          {a.property_id ? "to the PM" : (s as unknown as { reminded_for: string | null }).reminded_for === s.next_due_on ? "texted" : ""}
                        </td>
                      </>
                    );
                  })}
                </tbody>
              </>
            ) : tab === "replacement" ? (
              <>
                {head(["Replace from", "Asset", "Age", "Client / property", "Text"])}
                <tbody>
                  {replacements.map(({ a, due }) =>
                    row(
                      a.id,
                      <>
                        <td className={cell} style={{ color: due < today ? "var(--jms-danger)" : "var(--jms-warning)", whiteSpace: "nowrap" }}>
                          {fmtDay(due)}
                        </td>
                        {assetCell(a)}
                        <td className={cell}>{assetAgeYears(a, today)} years</td>
                        {ownerCell(a)}
                        <td className={cell} style={muted}>
                          {a.replacement_reminded_at ? `texted ${fmtDay(a.replacement_reminded_at.slice(0, 10))}` : ""}
                        </td>
                      </>
                    )
                  )}
                </tbody>
              </>
            ) : tab === "warranties" ? (
              <>
                {head(["Until", "Warranty", "Asset", "Client / property"])}
                <tbody>
                  {warranties.map(({ w, a }) =>
                    row(
                      w.id,
                      <>
                        <td className={cell} style={{ color: STATE_COLOURS[warrantyState(w.expires_on, today)], whiteSpace: "nowrap" }}>
                          {fmtDay(w.expires_on)}
                        </td>
                        <td className={cell}>
                          {w.kind === "workmanship" ? "Workmanship" : "Manufacturer"}
                          {w.label && w.label !== "Workmanship" && w.label !== "Manufacturer" ? `: ${w.label}` : ""}
                        </td>
                        {assetCell(a)}
                        {ownerCell(a)}
                      </>
                    )
                  )}
                </tbody>
              </>
            ) : tab === "claims" ? (
              <>
                {head(["Lodged", "Status", "With / reference", "Asset", "Client / property"])}
                <tbody>
                  {claims.map(({ c, a }) =>
                    row(
                      c.id,
                      <>
                        <td className={cell} style={{ whiteSpace: "nowrap" }}>
                          {fmtDay(c.lodged_on)}
                        </td>
                        <td className={cell} style={{ color: c.status === "declined" ? "var(--jms-danger)" : c.status === "completed" ? "var(--jms-text-muted)" : "var(--jms-warning)" }}>
                          {ASSET_CLAIM_STATUS_LABELS[c.status]}
                        </td>
                        <td className={cell}>
                          {c.claim_with ?? "-"}
                          {c.reference ? <div style={muted}>ref {c.reference}</div> : null}
                        </td>
                        {assetCell(a)}
                        {ownerCell(a)}
                      </>
                    )
                  )}
                </tbody>
              </>
            ) : (
              <>
                {head(["Asset", "Installed", "Warranty", "Next service", "Client / property"])}
                <tbody>
                  {filtered
                    .slice()
                    .sort((a, b) => ownerOf(a).name.localeCompare(ownerOf(b).name) || a.asset_name.localeCompare(b.asset_name))
                    .map((a) => {
                      const w = bestWarranty((data.warranties ?? []).filter((x) => x.asset_id === a.id), today);
                      const next = (data.services ?? []).filter((s) => s.asset_id === a.id && s.next_due_on).sort((x, y) => x.next_due_on!.localeCompare(y.next_due_on!))[0];
                      const age = assetAgeYears(a, today);
                      return row(
                        a.id,
                        <>
                          {assetCell(a)}
                          <td className={cell} style={muted}>
                            {a.installed_on ? fmtDay(a.installed_on) : a.install_year ? `about ${a.install_year}` : "-"}
                            {age !== null ? <div>{age} yrs</div> : null}
                          </td>
                          <td className={cell} style={{ color: w ? STATE_COLOURS[w.state] : "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                            {w?.text ?? "-"}
                          </td>
                          <td className={cell} style={{ fontSize: "var(--jms-font-label)", color: next ? STATE_COLOURS[serviceState(next.next_due_on, today, typeOf(a)?.lead_days ?? 28)] : "var(--jms-text-muted)" }}>
                            {next ? `${next.name} ${fmtDay(next.next_due_on)}` : "-"}
                          </td>
                          {ownerCell(a)}
                        </>
                      );
                    })}
                </tbody>
              </>
            )}
          </table>
          {(tab === "service" && dueServices.length === 0) ||
          (tab === "replacement" && replacements.length === 0) ||
          (tab === "warranties" && warranties.length === 0) ||
          (tab === "claims" && claims.length === 0) ||
          (tab === "all" && filtered.length === 0) ? (
            <p className="p-4" style={muted}>
              Nothing here.
            </p>
          ) : null}
        </div>
      )}
      {editing ? <AssetEditor open onClose={() => setEditing(null)} owner={editing.owner} assetId={editing.id} /> : null}
    </div>
  );
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

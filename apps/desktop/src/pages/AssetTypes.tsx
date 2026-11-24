import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AssetDefaultService, AssetDefaultWarranty, AssetField, AssetFieldType, AssetType, PropertyAssetCategory } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ASSETS_KEY, fetchAssetTypes } from "../lib/assets-data";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";

// Settings > Asset types: what can be recorded (hot water systems, roofs,
// pumps...), the details each one asks for, its service plan, warranties,
// when it's due for replacement and how early to remind. A change here
// applies to assets added from now on; existing assets keep their own
// services and warranties (edit those on the asset).

const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const label = "mb-1 block uppercase tracking-wide";
const input = "w-full rounded border px-2 py-1.5 focus:outline-none";
const inputStyle = { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
const CATEGORIES: { value: PropertyAssetCategory; label: string }[] = [
  { value: "plumbing", label: "Plumbing" },
  { value: "roofing", label: "Roofing" },
  { value: "hvac", label: "Heating & cooling" },
  { value: "general", label: "General" },
];
const FIELD_TYPES: { value: AssetFieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Pick from a list" },
];

interface Draft {
  id: string | null;
  name: string;
  icon: string;
  category: PropertyAssetCategory;
  fields: (AssetField & { optionsText: string })[];
  services: { name: string; months: string }[];
  warranties: { kind: AssetDefaultWarranty["kind"]; label: string; years: string }[];
  replaceAfter: string;
  leadDays: string;
  sortOrder: number;
  isArchived: boolean;
}

const toDraft = (t: AssetType | null, nextSort: number): Draft =>
  t
    ? {
        id: t.id,
        name: t.name,
        icon: t.icon ?? "",
        category: t.category,
        fields: (t.fields ?? []).map((f) => ({ ...f, optionsText: (f.options ?? []).join(", ") })),
        services: (t.default_services ?? []).map((s) => ({ name: s.name, months: s.interval_months ? String(s.interval_months) : "" })),
        warranties: (t.default_warranties ?? []).map((w) => ({ kind: w.kind, label: w.label, years: w.years ? String(w.years) : "" })),
        replaceAfter: t.replace_after_years ? String(t.replace_after_years) : "",
        leadDays: String(t.lead_days ?? 28),
        sortOrder: t.sort_order,
        isArchived: t.is_archived,
      }
    : {
        id: null,
        name: "",
        icon: "🔧",
        category: "general",
        fields: [
          { key: "brand", label: "Brand", type: "text", optionsText: "" },
          { key: "model", label: "Model", type: "text", optionsText: "" },
          { key: "serial_number", label: "Serial number", type: "text", optionsText: "" },
        ],
        services: [],
        warranties: [{ kind: "workmanship", label: "Workmanship", years: "" }],
        replaceAfter: "",
        leadDays: "28",
        sortOrder: nextSort,
        isArchived: false,
      };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "") || "field";
const num = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));

export default function AssetTypesPage() {
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const { data: types, error } = useQuery({ queryKey: [...ASSETS_KEY, "types"], queryFn: fetchAssetTypes });
  const { data: counts } = useQuery({
    queryKey: [...ASSETS_KEY, "type-counts"],
    queryFn: async () => {
      const { data, error: e } = await supabase.from("property_assets").select("asset_type_id").eq("status", "active");
      if (e) throw e;
      const m = new Map<string, number>();
      for (const r of data ?? []) if (r.asset_type_id) m.set(r.asset_type_id, (m.get(r.asset_type_id) ?? 0) + 1);
      return m;
    },
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      if (!d.name.trim()) throw new Error("Give the type a name.");
      const keys = new Set<string>();
      const fields: AssetField[] = d.fields
        .filter((f) => f.label.trim())
        .map((f) => {
          let key = f.key || slug(f.label);
          while (keys.has(key)) key += "_2";
          keys.add(key);
          const options = f.optionsText
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean);
          return f.type === "select" ? { key, label: f.label.trim(), type: f.type, options } : { key, label: f.label.trim(), type: f.type };
        });
      if (fields.some((f) => f.type === "select" && !f.options?.length)) throw new Error("A 'pick from a list' detail needs its choices, separated by commas.");
      const services: AssetDefaultService[] = d.services.filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim(), interval_months: num(s.months) }));
      const warranties: AssetDefaultWarranty[] = d.warranties.map((w) => ({ kind: w.kind, label: w.label.trim() || (w.kind === "workmanship" ? "Workmanship" : "Manufacturer"), years: num(w.years) }));
      const row = {
        name: d.name.trim(),
        icon: d.icon.trim() || null,
        category: d.category,
        fields,
        default_services: services,
        default_warranties: warranties,
        replace_after_years: num(d.replaceAfter),
        lead_days: Math.max(0, Math.round(num(d.leadDays) ?? 28)),
        sort_order: d.sortOrder,
        is_archived: d.isArchived,
      };
      const { error: e } = d.id
        ? await supabase.from("asset_types").update(row).eq("id", d.id)
        : await supabase.from("asset_types").insert({ ...row, tenant_id: profile!.tenant_id });
      if (e) throw e.code === "23505" ? new Error("There's already a type with that name.") : e;
    },
    onSuccess: () => {
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ASSETS_KEY });
    },
    onError: (e) => setFormError(getErrorMessage(e, "Couldn't save the type")),
  });

  const list = (types ?? []).filter((t) => showArchived || !t.is_archived);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const open = (t: AssetType | null) => {
    setFormError(null);
    setDraft(toDraft(t, Math.max(0, ...(types ?? []).map((x) => x.sort_order)) + 1));
  };
  const plan = (t: AssetType) =>
    [
      ...(t.default_services ?? []).map((s) => `${s.name}${s.interval_months ? ` every ${s.interval_months % 12 === 0 ? `${s.interval_months / 12} yr` : `${s.interval_months} mo`}` : ""}`),
      ...(t.default_warranties ?? []).filter((w) => w.years).map((w) => `${w.kind === "workmanship" ? "workmanship" : w.label.toLowerCase() || "manufacturer"} warranty ${w.years} yr`),
      t.replace_after_years ? `replace around ${t.replace_after_years} yrs` : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings" className="hover:underline" style={muted}>
        &larr; Settings
      </Link>
      <div className="mb-4 mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            Asset types
          </h1>
          <p className="max-w-3xl" style={muted}>
            The kinds of things you record in the{" "}
            <Link to="/assets" className="underline">
              asset register
            </Link>
            . Each type sets the details to fill in, the services it needs and how often, its warranties, and when it's due for replacement. Changes apply to assets added from now
            on - existing assets keep their own services and warranties.
          </p>
        </div>
        {isAdmin ? <ThemedButton onClick={() => open(null)}>+ New type</ThemedButton> : null}
      </div>
      {!isAdmin ? <p className="mb-3" style={{ color: "var(--jms-warning)", fontSize: "var(--jms-font-body)" }}>Only an admin can change asset types.</p> : null}
      {error ? <p style={{ color: "var(--jms-danger)" }}>{getErrorMessage(error, "Couldn't load the types")}</p> : null}
      {!types ? <p style={muted}>Loading...</p> : null}
      <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {list.map((t) => (
          <button
            key={t.id}
            onClick={() => (isAdmin ? open(t) : undefined)}
            className="flex w-full items-start gap-3 px-4 py-3 text-left"
            style={{ borderBottom: "1px solid var(--jms-border)", opacity: t.is_archived ? 0.55 : 1, cursor: isAdmin ? "pointer" : "default" }}
            data-testid="asset-type-row"
          >
            <span style={{ fontSize: "1.3rem" }}>{t.icon ?? "🔧"}</span>
            <span className="min-w-0 flex-1">
              <span className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                {t.name}
                {t.is_archived ? " (archived)" : ""}
              </span>
              <span className="block" style={muted}>
                {plan(t) || "No service plan"}
              </span>
            </span>
            <span style={muted}>{counts?.get(t.id) ?? 0} recorded</span>
          </button>
        ))}
      </div>
      {(types ?? []).some((t) => t.is_archived) ? (
        <button onClick={() => setShowArchived((v) => !v)} className="mt-2 hover:underline" style={muted}>
          {showArchived ? "Hide archived types" : "Show archived types"}
        </button>
      ) : null}

      {draft ? (
        <ThemedModal open onClose={() => setDraft(null)} title={draft.id ? `Edit ${draft.name || "type"}` : "New asset type"}>
          <div style={{ fontSize: "var(--jms-font-body)" }}>
            <div className="mb-3 grid grid-cols-[4rem_1fr] gap-2">
              <div>
                <label className={label} style={muted}>
                  Icon
                </label>
                <input value={draft.icon} onChange={(e) => set({ icon: e.target.value })} className={input} style={inputStyle} aria-label="Icon" />
              </div>
              <div>
                <label className={label} style={muted}>
                  Name
                </label>
                <input value={draft.name} onChange={(e) => set({ name: e.target.value })} className={input} style={inputStyle} placeholder="e.g. Hot water system" aria-label="Name" />
              </div>
            </div>
            <div className="mb-4">
              <label className={label} style={muted}>
                Trade
              </label>
              <select value={draft.category} onChange={(e) => set({ category: e.target.value as PropertyAssetCategory })} className={input} style={inputStyle} aria-label="Trade">
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <Section title="Details to record" hint="Brand, model and serial number show on the asset card, invoices and the home record.">
              {draft.fields.map((f, i) => (
                <div key={i} className="mb-2 grid grid-cols-[1fr_9rem_1.5rem] gap-2">
                  <input
                    value={f.label}
                    onChange={(e) => set({ fields: draft.fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                    className={input}
                    style={inputStyle}
                    placeholder="Label"
                    aria-label={`Detail ${i + 1}`}
                  />
                  <select
                    value={f.type}
                    onChange={(e) => set({ fields: draft.fields.map((x, j) => (j === i ? { ...x, type: e.target.value as AssetFieldType } : x)) })}
                    className={input}
                    style={inputStyle}
                    aria-label={`Detail ${i + 1} type`}
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <Remove onClick={() => set({ fields: draft.fields.filter((_, j) => j !== i) })} />
                  {f.type === "select" ? (
                    <input
                      value={f.optionsText}
                      onChange={(e) => set({ fields: draft.fields.map((x, j) => (j === i ? { ...x, optionsText: e.target.value } : x)) })}
                      className={`${input} col-span-2`}
                      style={inputStyle}
                      placeholder="Choices, separated by commas"
                      aria-label={`Detail ${i + 1} choices`}
                    />
                  ) : null}
                </div>
              ))}
              <Add onClick={() => set({ fields: [...draft.fields, { key: "", label: "", type: "text", optionsText: "" }] })}>+ Add a detail</Add>
            </Section>

            <Section title="Service plan" hint="Each service gets a due date from when it was last done (or from the install date). Leave the months empty for one with no set interval.">
              {draft.services.map((s, i) => (
                <div key={i} className="mb-2 grid grid-cols-[1fr_7rem_1.5rem] items-center gap-2">
                  <input
                    value={s.name}
                    onChange={(e) => set({ services: draft.services.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                    className={input}
                    style={inputStyle}
                    placeholder="e.g. Relief valve check"
                    aria-label={`Service ${i + 1}`}
                  />
                  <span className="flex items-center gap-1">
                    <input
                      value={s.months}
                      onChange={(e) => set({ services: draft.services.map((x, j) => (j === i ? { ...x, months: e.target.value } : x)) })}
                      className={input}
                      style={inputStyle}
                      inputMode="numeric"
                      aria-label={`Service ${i + 1} every (months)`}
                    />
                    <span style={muted}>mo</span>
                  </span>
                  <Remove onClick={() => set({ services: draft.services.filter((_, j) => j !== i) })} />
                </div>
              ))}
              <Add onClick={() => set({ services: [...draft.services, { name: "", months: "12" }] })}>+ Add a service</Add>
            </Section>

            <Section title="Warranties" hint="Dated from the install date. A price book item can set its own manufacturer warranty instead (e.g. 5 years on the cylinder for one model).">
              {draft.warranties.map((w, i) => (
                <div key={i} className="mb-2 grid grid-cols-[8.5rem_1fr_5.5rem_1.5rem] items-center gap-2">
                  <select
                    value={w.kind}
                    onChange={(e) => set({ warranties: draft.warranties.map((x, j) => (j === i ? { ...x, kind: e.target.value as AssetDefaultWarranty["kind"] } : x)) })}
                    className={input}
                    style={inputStyle}
                    aria-label={`Warranty ${i + 1} kind`}
                  >
                    <option value="manufacturer">Manufacturer</option>
                    <option value="workmanship">Workmanship</option>
                  </select>
                  <input
                    value={w.label}
                    onChange={(e) => set({ warranties: draft.warranties.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                    className={input}
                    style={inputStyle}
                    placeholder="e.g. Cylinder"
                    aria-label={`Warranty ${i + 1} label`}
                  />
                  <span className="flex items-center gap-1">
                    <input
                      value={w.years}
                      onChange={(e) => set({ warranties: draft.warranties.map((x, j) => (j === i ? { ...x, years: e.target.value } : x)) })}
                      className={input}
                      style={inputStyle}
                      inputMode="decimal"
                      aria-label={`Warranty ${i + 1} years`}
                    />
                    <span style={muted}>yr</span>
                  </span>
                  <Remove onClick={() => set({ warranties: draft.warranties.filter((_, j) => j !== i) })} />
                </div>
              ))}
              <Add onClick={() => set({ warranties: [...draft.warranties, { kind: "manufacturer", label: "", years: "" }] })}>+ Add a warranty</Add>
            </Section>

            <div className="mb-4 grid grid-cols-2 gap-3">
              <div>
                <label className={label} style={muted}>
                  Replace around (years)
                </label>
                <input value={draft.replaceAfter} onChange={(e) => set({ replaceAfter: e.target.value })} className={input} style={inputStyle} inputMode="decimal" placeholder="Never" aria-label="Replace around (years)" />
              </div>
              <div>
                <label className={label} style={muted}>
                  Remind (days before due)
                </label>
                <input value={draft.leadDays} onChange={(e) => set({ leadDays: e.target.value })} className={input} style={inputStyle} inputMode="numeric" aria-label="Remind (days before due)" />
              </div>
            </div>
            {draft.id ? (
              <label className="mb-4 flex items-center gap-2" style={muted}>
                <input type="checkbox" checked={draft.isArchived} onChange={(e) => set({ isArchived: e.target.checked })} /> Archived - hidden when adding assets (assets already
                recorded keep it)
              </label>
            ) : null}
            {formError ? <p className="mb-3" style={{ color: "var(--jms-danger)" }}>{formError}</p> : null}
            <div className="flex justify-end gap-2">
              <ThemedButton variant="secondary" onClick={() => setDraft(null)}>
                Cancel
              </ThemedButton>
              <ThemedButton
                onClick={() => {
                  setFormError(null);
                  save.mutate(draft);
                }}
                disabled={save.isPending}
              >
                {save.isPending ? "Saving..." : "Save"}
              </ThemedButton>
            </div>
          </div>
        </ThemedModal>
      ) : null}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded p-3" style={{ border: "1px solid var(--jms-border)" }}>
      <p className="font-semibold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
        {title}
      </p>
      <p className="mb-2" style={muted}>
        {hint}
      </p>
      {children}
    </div>
  );
}
function Add({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
      {children}
    </button>
  );
}
function Remove({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Remove" style={{ color: "var(--jms-text-muted)" }}>
      ✕
    </button>
  );
}

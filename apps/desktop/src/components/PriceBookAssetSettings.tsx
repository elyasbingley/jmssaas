import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AssetDefaultWarranty } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { ASSETS_KEY, fetchAssetTypes } from "../lib/assets-data";
import { ThemedButton } from "./theme/ThemedButton";

// "Creates an asset" on a price book item: when a job with this item on
// its invoice (or accepted quote) is completed, an asset of this type is
// added to the client's register with the brand/model and warranties set
// here (create_assets_from_job in the asset_register migration).

export interface PriceBookAssetFields {
  creates_asset_type_id?: string | null;
  asset_attributes?: Record<string, string> | null;
  asset_warranties?: AssetDefaultWarranty[] | null;
}

const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const input = "w-full rounded border px-2 py-1.5 focus:outline-none";
const inputStyle = { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;

export function PriceBookAssetSettings({ itemId, item }: { itemId: string; item: PriceBookAssetFields }) {
  const queryClient = useQueryClient();
  const { data: types } = useQuery({ queryKey: [...ASSETS_KEY, "types"], queryFn: fetchAssetTypes });
  const [typeId, setTypeId] = useState(item.creates_asset_type_id ?? "");
  const [brand, setBrand] = useState(item.asset_attributes?.brand ?? "");
  const [model, setModel] = useState(item.asset_attributes?.model ?? "");
  const [ownWarranties, setOwnWarranties] = useState(!!item.asset_warranties);
  const [warranties, setWarranties] = useState<{ kind: AssetDefaultWarranty["kind"]; label: string; years: string }[]>(
    (item.asset_warranties ?? []).map((w) => ({ kind: w.kind, label: w.label, years: w.years ? String(w.years) : "" }))
  );
  const [saved, setSaved] = useState(false);
  const type = (types ?? []).find((t) => t.id === typeId) ?? null;

  const save = useMutation({
    mutationFn: async () => {
      const attributes: Record<string, string> = {};
      if (brand.trim()) attributes.brand = brand.trim();
      if (model.trim()) attributes.model = model.trim();
      const { error } = await supabase
        .from("price_book_items")
        .update({
          creates_asset_type_id: typeId || null,
          asset_attributes: typeId ? attributes : {},
          asset_warranties:
            typeId && ownWarranties
              ? warranties.map((w) => ({
                  kind: w.kind,
                  label: w.label.trim() || (w.kind === "workmanship" ? "Workmanship" : "Manufacturer"),
                  years: w.years.trim() && Number.isFinite(Number(w.years)) ? Number(w.years) : null,
                }))
              : null,
        })
        .eq("id", itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["price-book-item", itemId] });
    },
  });

  const useOwn = (on: boolean) => {
    setOwnWarranties(on);
    if (on && warranties.length === 0) setWarranties((type?.default_warranties ?? []).map((w) => ({ kind: w.kind, label: w.label, years: w.years ? String(w.years) : "" })));
  };

  return (
    <div className="mt-8 rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }} data-testid="price-book-asset">
      <h2 className="mb-1 font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
        Asset register
      </h2>
      <p className="mb-3" style={muted}>
        When a job with this item is completed, add it to the client's{" "}
        <Link to="/assets" className="underline">
          asset register
        </Link>{" "}
        (one per unit when it's sold by each). The tech fills in the serial number on the job.
      </p>
      <label className="mb-1 block uppercase tracking-wide" style={muted}>
        Creates an asset
      </label>
      <select
        value={typeId}
        onChange={(e) => {
          setTypeId(e.target.value);
          setSaved(false);
        }}
        className={`${input} mb-3`}
        style={inputStyle}
        aria-label="Creates an asset"
      >
        <option value="">No - this item isn't an asset</option>
        {(types ?? [])
          .filter((t) => !t.is_archived || t.id === typeId)
          .map((t) => (
            <option key={t.id} value={t.id}>
              {t.icon ?? ""} {t.name}
            </option>
          ))}
      </select>
      {typeId ? (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <input value={brand} onChange={(e) => (setBrand(e.target.value), setSaved(false))} className={input} style={inputStyle} placeholder="Brand (e.g. Rheem)" aria-label="Asset brand" />
            <input value={model} onChange={(e) => (setModel(e.target.value), setSaved(false))} className={input} style={inputStyle} placeholder="Model (e.g. Stellar 330)" aria-label="Asset model" />
          </div>
          <label className="mb-2 flex items-center gap-2" style={muted}>
            <input type="checkbox" checked={ownWarranties} onChange={(e) => (useOwn(e.target.checked), setSaved(false))} /> Warranties for this product (instead of the {type?.name ?? "type"}'s:{" "}
            {(type?.default_warranties ?? []).map((w) => `${w.label || w.kind} ${w.years ?? "?"} yr`).join(", ") || "none"})
          </label>
          {ownWarranties ? (
            <div className="mb-3">
              {warranties.map((w, i) => (
                <div key={i} className="mb-2 grid grid-cols-[8.5rem_1fr_5.5rem_1.5rem] items-center gap-2">
                  <select
                    value={w.kind}
                    onChange={(e) => setWarranties((ws) => ws.map((x, j) => (j === i ? { ...x, kind: e.target.value as AssetDefaultWarranty["kind"] } : x)))}
                    className={input}
                    style={inputStyle}
                    aria-label={`Product warranty ${i + 1} kind`}
                  >
                    <option value="manufacturer">Manufacturer</option>
                    <option value="workmanship">Workmanship</option>
                  </select>
                  <input
                    value={w.label}
                    onChange={(e) => setWarranties((ws) => ws.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                    className={input}
                    style={inputStyle}
                    placeholder="e.g. Cylinder"
                    aria-label={`Product warranty ${i + 1} label`}
                  />
                  <span className="flex items-center gap-1">
                    <input
                      value={w.years}
                      onChange={(e) => setWarranties((ws) => ws.map((x, j) => (j === i ? { ...x, years: e.target.value } : x)))}
                      className={input}
                      style={inputStyle}
                      inputMode="decimal"
                      aria-label={`Product warranty ${i + 1} years`}
                    />
                    <span style={muted}>yr</span>
                  </span>
                  <button type="button" onClick={() => setWarranties((ws) => ws.filter((_, j) => j !== i))} aria-label="Remove" style={{ color: "var(--jms-text-muted)" }}>
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setWarranties((ws) => [...ws, { kind: "manufacturer", label: "", years: "" }])}
                className="font-semibold hover:underline"
                style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
              >
                + Add a warranty
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {save.error ? <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(save.error, "Couldn't save")}</p> : null}
      <div className="flex items-center gap-3">
        <ThemedButton variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving..." : "Save asset settings"}
        </ThemedButton>
        {saved ? <span style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>Saved.</span> : null}
      </div>
    </div>
  );
}

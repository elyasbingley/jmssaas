import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  computeItemizedLinePricing,
  computeLineItemUnitPriceCents,
  createPriceBookItemSchema,
  createPriceBookVariationSchema,
  formatCentsAsAud,
  type LineItemCrewInput,
  type LineItemMaterialInput,
  type PriceBookItem,
  type PriceBookItemCrew,
  type PriceBookItemMaterial,
  type PriceBookItemVariation,
  type PriceBookItemVariationCrew,
  type PriceBookItemVariationMaterial,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField, ThemedTextAreaField } from "../components/theme/ThemedFormField";
import { UnitSelect } from "../components/UnitSelect";
import { PriceBookItemizedFields, type PriceBookPricingFields } from "../components/PriceBookItemizedFields";

const IMAGE_BUCKET = "price-book-images";

const emptyPricing: PriceBookPricingFields = {
  pricing_model: "legacy",
  quantity: 1,
  labour_rate_cents: 0,
  labour_hours: 0,
  labour_cost_rate_cents: undefined,
  labour_charge_out_rate_cents: undefined,
  crew: [],
  material_cost_cents: 0,
  materials: [],
  markup_percent: 0,
  material_margin_percent: undefined,
  waste_percent: undefined,
  contingency_percent: undefined,
  tip_fees_cents: undefined,
  equipment_hire_cents: undefined,
  travel_cost_cents: undefined,
  is_subcontracted: false,
  subcontractor_cost_cents: 0,
  subcontractor_margin_percent: undefined,
};

function pricingFromItem(item: PriceBookItem | PriceBookItemVariation, crew: LineItemCrewInput[], materials: LineItemMaterialInput[]): PriceBookPricingFields {
  return {
    pricing_model: item.pricing_model === "itemized" ? "itemized" : "legacy",
    quantity: item.quantity ?? 1,
    labour_rate_cents: item.labour_rate_cents,
    labour_hours: item.labour_hours,
    labour_cost_rate_cents: item.labour_cost_rate_cents ?? undefined,
    labour_charge_out_rate_cents: item.labour_charge_out_rate_cents ?? undefined,
    crew,
    material_cost_cents: item.material_cost_cents,
    materials,
    markup_percent: item.markup_percent,
    material_margin_percent: item.material_margin_percent ?? undefined,
    waste_percent: item.waste_percent ?? undefined,
    contingency_percent: item.contingency_percent ?? undefined,
    tip_fees_cents: item.tip_fees_cents ?? undefined,
    equipment_hire_cents: item.equipment_hire_cents ?? undefined,
    travel_cost_cents: item.travel_cost_cents ?? undefined,
    is_subcontracted: item.is_subcontracted ?? false,
    subcontractor_cost_cents: item.subcontractor_cost_cents ?? 0,
    subcontractor_margin_percent: item.subcontractor_margin_percent ?? undefined,
  };
}

function previewPriceCents(pricing: PriceBookPricingFields): number {
  return pricing.pricing_model === "itemized" ? computeItemizedLinePricing(pricing).unitPriceCents : computeLineItemUnitPriceCents(pricing);
}

// Strips crew/materials (not real columns on price_book_items/price_book_
// item_variations - their own child tables) out of a successfully-parsed
// schema result, returning just the scalar fields to write to the parent
// row, plus crew/materials separately for the caller to replace in their
// own tables. No RPC for this (unlike replace_quote_line_items) - a price
// book item/variation is a single row with a small, bounded child-row
// count, so a plain delete-then-insert from the client is simple enough
// and consistent with how this app already handles other small child-row
// replacements (e.g. note_properties).
function splitPricingResult<T extends { crew?: LineItemCrewInput[]; materials?: LineItemMaterialInput[] }>(
  data: T
): { scalar: Omit<T, "crew" | "materials">; crew: LineItemCrewInput[]; materials: LineItemMaterialInput[] } {
  const { crew, materials, ...scalar } = data;
  return { scalar, crew: crew ?? [], materials: materials ?? [] };
}

async function fetchItem(id: string): Promise<PriceBookItem> {
  const { data, error } = await supabase.from("price_book_items").select("*").eq("id", id).single();
  if (error) throw error;
  return data as PriceBookItem;
}

async function fetchItemCrew(itemId: string): Promise<PriceBookItemCrew[]> {
  const { data, error } = await supabase.from("price_book_item_crew").select("*").eq("price_book_item_id", itemId).order("sort_order");
  if (error) throw error;
  return data as PriceBookItemCrew[];
}

async function fetchItemMaterials(itemId: string): Promise<PriceBookItemMaterial[]> {
  const { data, error } = await supabase.from("price_book_item_materials").select("*").eq("price_book_item_id", itemId).order("sort_order");
  if (error) throw error;
  return data as PriceBookItemMaterial[];
}

async function fetchVariations(itemId: string): Promise<PriceBookItemVariation[]> {
  const { data, error } = await supabase
    .from("price_book_item_variations")
    .select("*")
    .eq("price_book_item_id", itemId)
    .order("sort_order")
    .order("name");
  if (error) throw error;
  return data as PriceBookItemVariation[];
}

async function fetchVariationCrew(variationId: string): Promise<PriceBookItemVariationCrew[]> {
  const { data, error } = await supabase
    .from("price_book_item_variation_crew")
    .select("*")
    .eq("price_book_item_variation_id", variationId)
    .order("sort_order");
  if (error) throw error;
  return data as PriceBookItemVariationCrew[];
}

async function fetchVariationMaterials(variationId: string): Promise<PriceBookItemVariationMaterial[]> {
  const { data, error } = await supabase
    .from("price_book_item_variation_materials")
    .select("*")
    .eq("price_book_item_variation_id", variationId)
    .order("sort_order");
  if (error) throw error;
  return data as PriceBookItemVariationMaterial[];
}

export default function PriceBookItemPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: item } = useQuery({ queryKey: ["price-book-item", id], queryFn: () => fetchItem(id!), enabled: !!id });
  const { data: itemCrew } = useQuery({ queryKey: ["price-book-item-crew", id], queryFn: () => fetchItemCrew(id!), enabled: !!id });
  const { data: itemMaterials } = useQuery({ queryKey: ["price-book-item-materials", id], queryFn: () => fetchItemMaterials(id!), enabled: !!id });
  const { data: variations } = useQuery({
    queryKey: ["price-book-variations", id],
    queryFn: () => fetchVariations(id!),
    enabled: !!id,
  });

  // Gate on all three fetches, not just `item`: the form below seeds its
  // local state (including every DecimalField's own displayed text) once
  // from props on mount, with no re-seeding effect watching for later
  // prop changes. Mounting it before itemCrew/itemMaterials have loaded -
  // as a `useEffect([item, itemCrew, itemMaterials])` reseed used to allow -
  // means it captures a zeroed/blank value and then never updates its
  // displayed text once the real data arrives a render later, which is
  // what made labour (and every other field) appear wiped after save-and-
  // return. `key={id}` below forces a fresh mount (and fresh seed) if the
  // route ever points at a different item without a full page reload.
  if (!item || !itemCrew || !itemMaterials) {
    return (
      <div className="p-8" style={{ color: "var(--jms-text-muted)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}>
        Loading...
      </div>
    );
  }

  return (
    <PriceBookItemForm
      key={id}
      id={id!}
      item={item}
      itemCrew={itemCrew}
      itemMaterials={itemMaterials}
      variations={variations ?? []}
      navigate={navigate}
    />
  );
}

function PriceBookItemForm({
  id,
  item,
  itemCrew,
  itemMaterials,
  variations,
  navigate,
}: {
  id: string;
  item: PriceBookItem;
  itemCrew: PriceBookItemCrew[];
  itemMaterials: PriceBookItemMaterial[];
  variations: PriceBookItemVariation[];
  navigate: ReturnType<typeof useNavigate>;
}) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const [description, setDescription] = useState(item.description);
  const [isCalloutFee, setIsCalloutFee] = useState(item.is_callout_fee ?? false);
  const [gstApplicable, setGstApplicable] = useState(item.gst_applicable ?? true);
  const [unit, setUnit] = useState<string | null>(item.unit ?? null);
  const [warrantyText, setWarrantyText] = useState(item.warranty_text ?? "");
  const [pricing, setPricing] = useState<PriceBookPricingFields>(() =>
    pricingFromItem(
      item,
      itemCrew.map((c) => ({ ...c })),
      itemMaterials.map((m) => ({ ...m }))
    )
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const previewCents = previewPriceCents(pricing);

  const invalidateItem = () => {
    queryClient.invalidateQueries({ queryKey: ["price-book-item", id] });
    queryClient.invalidateQueries({ queryKey: ["price-book-item-crew", id] });
    queryClient.invalidateQueries({ queryKey: ["price-book-item-materials", id] });
    queryClient.invalidateQueries({ queryKey: ["price-book-items", item.category_id] });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not loaded yet");
      const result = createPriceBookItemSchema.safeParse({
        category_id: item.category_id,
        description,
        is_callout_fee: isCalloutFee,
        gst_applicable: gstApplicable,
        unit,
        warranty_text: warrantyText || null,
        ...pricing,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");
      const { scalar, crew, materials } = splitPricingResult(result.data);

      const { error } = await supabase.from("price_book_items").update(scalar).eq("id", id);
      if (error) throw error;

      const { error: deleteCrewError } = await supabase.from("price_book_item_crew").delete().eq("price_book_item_id", id);
      if (deleteCrewError) throw deleteCrewError;
      if (crew.length > 0) {
        const { error: crewError } = await supabase
          .from("price_book_item_crew")
          .insert(crew.map((c, i) => ({ ...c, tenant_id: profile.tenant_id, price_book_item_id: id, sort_order: c.sort_order ?? i })));
        if (crewError) throw crewError;
      }

      const { error: deleteMaterialsError } = await supabase.from("price_book_item_materials").delete().eq("price_book_item_id", id);
      if (deleteMaterialsError) throw deleteMaterialsError;
      if (materials.length > 0) {
        const { error: materialsError } = await supabase
          .from("price_book_item_materials")
          .insert(materials.map((m, i) => ({ ...m, tenant_id: profile.tenant_id, price_book_item_id: id, sort_order: m.sort_order ?? i })));
        if (materialsError) throw materialsError;
      }
    },
    onSuccess: () => {
      invalidateItem();
      setSaveError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save")),
  });

  const [imageError, setImageError] = useState<string | null>(null);

  const changeImage = useMutation({
    mutationFn: async (file: File) => {
      const extension = file.type.includes("png") ? "png" : "jpg";
      const path = `${item.tenant_id}/item-${item.id}-${Date.now()}.${extension}`;
      const { error: uploadError } = await supabase.storage
        .from(IMAGE_BUCKET)
        .upload(path, file, { contentType: file.type || "image/jpeg", upsert: true });
      if (uploadError) throw uploadError;
      const imageUrl = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;

      const { error } = await supabase.from("price_book_items").update({ image_url: imageUrl }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateItem();
      setImageError(null);
    },
    onError: (e) => setImageError(getErrorMessage(e, "Failed to upload image")),
  });

  const removeImage = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("price_book_items").update({ image_url: null }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateItem();
      setImageError(null);
    },
    onError: (e) => setImageError(getErrorMessage(e, "Failed to remove image")),
  });

  const deleteItem = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("price_book_items").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["price-book-items", item.category_id] });
      navigate(`/price-book/categories/${item.category_id}`);
    },
  });

  const [variationModalOpen, setVariationModalOpen] = useState(false);
  const [editingVariationId, setEditingVariationId] = useState<string | null>(null);
  const [variationName, setVariationName] = useState("");
  const [variationUnit, setVariationUnit] = useState<string | null>(null);
  const [variationWarrantyText, setVariationWarrantyText] = useState("");
  const [variationPricing, setVariationPricing] = useState<PriceBookPricingFields>(emptyPricing);
  const [variationError, setVariationError] = useState<string | null>(null);
  // Bumped every time the modal is (re)opened, and used as PriceBookItemizedFields'
  // key below, forcing a fresh mount - and a fresh DecimalField seed - every
  // time, even if the modal's own open/close toggle were ever changed to not
  // fully unmount its content (as mobile's RN <Modal> already doesn't).
  const [variationSessionKey, setVariationSessionKey] = useState(0);

  const openNewVariation = () => {
    setEditingVariationId(null);
    setVariationName("");
    setVariationUnit(null);
    setVariationWarrantyText("");
    setVariationPricing(emptyPricing);
    setVariationError(null);
    setVariationSessionKey((k) => k + 1);
    setVariationModalOpen(true);
  };

  const openEditVariation = async (variation: PriceBookItemVariation) => {
    // Fetch crew/materials and set every field - including pricing - before
    // opening the modal, not after: opening it first (as this used to do)
    // mounts PriceBookItemizedFields - and every DecimalField inside it,
    // which seeds its own displayed text once on mount with no resync -
    // while variationPricing still holds the previous variation's values
    // (or emptyPricing), and that stale seed never catches up once the
    // real fetch resolves a moment later. Same race as PriceBookItem's own
    // reseed bug, just one level down in the variation modal.
    setVariationError(null);
    const [crew, materials] = await Promise.all([fetchVariationCrew(variation.id), fetchVariationMaterials(variation.id)]);
    setEditingVariationId(variation.id);
    setVariationName(variation.name);
    setVariationUnit(variation.unit ?? null);
    setVariationWarrantyText(variation.warranty_text ?? "");
    setVariationPricing(pricingFromItem(variation, crew, materials));
    setVariationSessionKey((k) => k + 1);
    setVariationModalOpen(true);
  };

  const saveVariation = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const result = createPriceBookVariationSchema.safeParse({
        price_book_item_id: id,
        name: variationName,
        unit: variationUnit,
        warranty_text: variationWarrantyText || null,
        ...variationPricing,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");
      const { scalar, crew, materials } = splitPricingResult(result.data);

      const { data: savedVariation, error } = editingVariationId
        ? await supabase.from("price_book_item_variations").update(scalar).eq("id", editingVariationId).select("id").single()
        : await supabase
            .from("price_book_item_variations")
            .insert({ ...scalar, tenant_id: profile.tenant_id })
            .select("id")
            .single();
      if (error) throw error;
      const variationId = savedVariation.id as string;

      const { error: deleteCrewError } = await supabase
        .from("price_book_item_variation_crew")
        .delete()
        .eq("price_book_item_variation_id", variationId);
      if (deleteCrewError) throw deleteCrewError;
      if (crew.length > 0) {
        const { error: crewError } = await supabase
          .from("price_book_item_variation_crew")
          .insert(crew.map((c, i) => ({ ...c, tenant_id: profile.tenant_id, price_book_item_variation_id: variationId, sort_order: c.sort_order ?? i })));
        if (crewError) throw crewError;
      }

      const { error: deleteMaterialsError } = await supabase
        .from("price_book_item_variation_materials")
        .delete()
        .eq("price_book_item_variation_id", variationId);
      if (deleteMaterialsError) throw deleteMaterialsError;
      if (materials.length > 0) {
        const { error: materialsError } = await supabase
          .from("price_book_item_variation_materials")
          .insert(materials.map((m, i) => ({ ...m, tenant_id: profile.tenant_id, price_book_item_variation_id: variationId, sort_order: m.sort_order ?? i })));
        if (materialsError) throw materialsError;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["price-book-variations", id] });
      setVariationModalOpen(false);
    },
    onError: (e) => setVariationError(getErrorMessage(e, "Failed to save variation")),
  });

  const deleteVariation = useMutation({
    mutationFn: async () => {
      if (!editingVariationId) return;
      const { error } = await supabase.from("price_book_item_variations").delete().eq("id", editingVariationId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["price-book-variations", id] });
      setVariationModalOpen(false);
    },
  });

  return (
    <div className="mx-auto max-w-3xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link
        to={`/price-book/categories/${item.category_id}`}
        className="mb-4 inline-block hover:underline"
        style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
      >
        &larr; Back to category
      </Link>

      <h2 className="mb-2 font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
        Tile image
      </h2>
      {item.image_url ? (
        <img src={item.image_url} alt="" className="mb-2 h-32 w-full rounded object-cover" style={{ border: "1px solid var(--jms-border)" }} />
      ) : (
        <div
          className="mb-2 flex h-32 w-full items-center justify-center rounded"
          style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
        >
          No image uploaded
        </div>
      )}
      <div className="mb-2 flex items-center gap-4">
        <label
          className="cursor-pointer rounded px-4 py-2 font-semibold"
          style={{ border: "1px solid var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
        >
          {changeImage.isPending ? "Uploading..." : item.image_url ? "Change image" : "Upload image"}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={changeImage.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) changeImage.mutate(file);
              e.target.value = "";
            }}
          />
        </label>
        {item.image_url ? (
          <button onClick={() => removeImage.mutate()} className="font-semibold" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            Remove
          </button>
        ) : null}
      </div>
      {imageError ? (
        <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {imageError}
        </p>
      ) : null}

      <ThemedTextAreaField label="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />

      <div className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Unit
          </label>
          <UnitSelect value={unit} onChange={setUnit} />
        </div>
        <ThemedFormField
          label="Warranty (shown to the client when added to a quote/invoice)"
          value={warrantyText}
          onChange={(e) => setWarrantyText(e.target.value)}
          placeholder="e.g. 10 year workmanship warranty"
        />
      </div>

      <div className="mb-4">
        <PriceBookItemizedFields value={pricing} onChange={(patch) => setPricing((prev) => ({ ...prev, ...patch }))} />
        {pricing.pricing_model === "itemized" ? (
          <ThemedFormField
            label="Benchmark quantity (what the itemized total above was priced for, e.g. 70 for a $/lm rate)"
            value={String(pricing.quantity)}
            onChange={(e) => setPricing((prev) => ({ ...prev, quantity: parseFloat(e.target.value) || 1 }))}
          />
        ) : null}
      </div>

      <label className="mb-2 flex items-center gap-2" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
        <input type="checkbox" checked={isCalloutFee} onChange={(e) => setIsCalloutFee(e.target.checked)} />
        This is the call-out / service fee
      </label>
      <p className="mb-4 -mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        A membership plan that waives the call-out fee will waive this item automatically when it's added to a quote or invoice.
      </p>

      <label className="mb-4 flex items-center gap-2" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
        <input type="checkbox" checked={gstApplicable} onChange={(e) => setGstApplicable(e.target.checked)} />
        GST applicable (carried through as the default when added to a quote/invoice)
      </label>

      <div className="mb-4 rounded p-3" style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)" }}>
        <p className="font-bold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Computed price{pricing.pricing_model === "itemized" ? ` (per ${pricing.quantity} ${unit ?? "unit"})` : ""}
        </p>
        <p className="text-xl font-extrabold" style={{ color: "var(--jms-accent)" }}>
          {formatCentsAsAud(previewCents)}
        </p>
      </div>

      {saveError ? (
        <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {saveError}
        </p>
      ) : null}
      {saved ? (
        <p className="mb-2" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
          Saved.
        </p>
      ) : null}

      <ThemedButton onClick={() => save.mutate()} disabled={save.isPending} style={{ paddingBlock: 12, paddingInline: 24 }}>
        {save.isPending ? "Saving..." : "Save changes"}
      </ThemedButton>

      <h2 className="mb-2 mt-8 font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
        Variations
      </h2>
      <div className="mb-3 overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {!variations || variations.length === 0 ? (
          <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No variations yet.
          </p>
        ) : (
          variations.map((variation) => (
            <button
              key={variation.id}
              onClick={() => openEditVariation(variation)}
              className="jms-nav-link flex w-full items-center justify-between px-4 py-3 text-left last:border-0"
              style={{ borderBottom: "1px solid var(--jms-border)", fontSize: "var(--jms-font-body)" }}
            >
              <span className="font-medium" style={{ color: "var(--jms-text)" }}>
                {variation.name}
              </span>
              <span className="font-semibold" style={{ color: "var(--jms-accent)" }}>
                {/* Approximate for an itemized variation with real crew/materials rows
                    (uses the flat labour_cost_rate_cents/material_cost_cents fields,
                    not the children - fetching every variation's children just for
                    this list isn't worth an N+1 query here). The edit modal above
                    fetches and computes the real figure. */}
                {formatCentsAsAud(previewPriceCents(pricingFromItem(variation, [], [])))}
              </span>
            </button>
          ))
        )}
      </div>
      <button onClick={openNewVariation} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        + Add variation
      </button>

      <div className="mt-8 pt-6" style={{ borderTop: "1px solid var(--jms-border)" }}>
        <button
          onClick={() => deleteItem.mutate()}
          className="rounded px-6 py-3 font-semibold"
          style={{ border: "1px solid var(--jms-danger)", color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}
        >
          Delete item
        </button>
      </div>

      <ThemedModal open={variationModalOpen} onClose={() => setVariationModalOpen(false)} title={editingVariationId ? "Edit variation" : "New variation"}>
        <ThemedFormField label="Name" value={variationName} onChange={(e) => setVariationName(e.target.value)} placeholder="e.g. Standard, Premium" />

        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Unit
            </label>
            <UnitSelect value={variationUnit} onChange={setVariationUnit} />
          </div>
          <ThemedFormField
            label="Warranty (shown to the client)"
            value={variationWarrantyText}
            onChange={(e) => setVariationWarrantyText(e.target.value)}
            placeholder="e.g. 10 year workmanship warranty"
          />
        </div>

        <div className="mb-4">
          <PriceBookItemizedFields
            key={variationSessionKey}
            value={variationPricing}
            onChange={(patch) => setVariationPricing((prev) => ({ ...prev, ...patch }))}
          />
          {variationPricing.pricing_model === "itemized" ? (
            <ThemedFormField
              label="Benchmark quantity (what the itemized total above was priced for)"
              value={String(variationPricing.quantity)}
              onChange={(e) => setVariationPricing((prev) => ({ ...prev, quantity: parseFloat(e.target.value) || 1 }))}
            />
          ) : null}
        </div>

        <div className="mb-4 rounded p-3" style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)" }}>
          <p className="font-bold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Computed price
          </p>
          <p className="text-xl font-extrabold" style={{ color: "var(--jms-accent)" }}>
            {formatCentsAsAud(previewPriceCents(variationPricing))}
          </p>
        </div>

        {variationError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {variationError}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-3">
          {editingVariationId ? (
            <button onClick={() => deleteVariation.mutate()} className="mr-auto font-semibold" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
              Delete
            </button>
          ) : null}
          <button onClick={() => setVariationModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveVariation.mutate()} disabled={saveVariation.isPending}>
            {saveVariation.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}

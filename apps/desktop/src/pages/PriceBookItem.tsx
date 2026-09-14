import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  computeLineItemUnitPriceCents,
  createPriceBookItemSchema,
  createPriceBookVariationSchema,
  formatCentsAsAud,
  type PriceBookItem,
  type PriceBookItemVariation,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField, ThemedTextAreaField } from "../components/theme/ThemedFormField";

const IMAGE_BUCKET = "price-book-images";

function parseNumber(text: string): number {
  return parseFloat(text) || 0;
}

async function fetchItem(id: string): Promise<PriceBookItem> {
  const { data, error } = await supabase.from("price_book_items").select("*").eq("id", id).single();
  if (error) throw error;
  return data as PriceBookItem;
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

interface VariationFormState {
  name: string;
  labourRate: string;
  labourHours: string;
  materialCost: string;
  markupPercent: string;
}
const emptyVariationForm: VariationFormState = { name: "", labourRate: "0", labourHours: "0", materialCost: "0", markupPercent: "0" };

export default function PriceBookItemPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: item } = useQuery({ queryKey: ["price-book-item", id], queryFn: () => fetchItem(id!), enabled: !!id });
  const { data: variations } = useQuery({
    queryKey: ["price-book-variations", id],
    queryFn: () => fetchVariations(id!),
    enabled: !!id,
  });

  const [description, setDescription] = useState("");
  const [labourRate, setLabourRate] = useState("0");
  const [labourHours, setLabourHours] = useState("0");
  const [materialCost, setMaterialCost] = useState("0");
  const [markupPercent, setMarkupPercent] = useState("0");
  const [isCalloutFee, setIsCalloutFee] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (item) {
      setDescription(item.description);
      setLabourRate((item.labour_rate_cents / 100).toString());
      setLabourHours(item.labour_hours.toString());
      setMaterialCost((item.material_cost_cents / 100).toString());
      setMarkupPercent(item.markup_percent.toString());
      setIsCalloutFee(item.is_callout_fee ?? false);
    }
  }, [item]);

  const previewCents = computeLineItemUnitPriceCents({
    labour_rate_cents: Math.round(parseNumber(labourRate) * 100),
    labour_hours: parseNumber(labourHours),
    material_cost_cents: Math.round(parseNumber(materialCost) * 100),
    markup_percent: parseNumber(markupPercent),
  });

  const invalidateItem = () => {
    queryClient.invalidateQueries({ queryKey: ["price-book-item", id] });
    queryClient.invalidateQueries({ queryKey: ["price-book-items", item?.category_id] });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error("Not loaded yet");
      const result = createPriceBookItemSchema.safeParse({
        category_id: item.category_id,
        description,
        labour_rate_cents: Math.round(parseNumber(labourRate) * 100),
        labour_hours: parseNumber(labourHours),
        material_cost_cents: Math.round(parseNumber(materialCost) * 100),
        markup_percent: parseNumber(markupPercent),
        is_callout_fee: isCalloutFee,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");

      const { error } = await supabase.from("price_book_items").update(result.data).eq("id", id);
      if (error) throw error;
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
      if (!item) throw new Error("Not loaded yet");
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
      queryClient.invalidateQueries({ queryKey: ["price-book-items", item?.category_id] });
      navigate(item ? `/price-book/categories/${item.category_id}` : "/price-book");
    },
  });

  const [variationModalOpen, setVariationModalOpen] = useState(false);
  const [editingVariationId, setEditingVariationId] = useState<string | null>(null);
  const [variationForm, setVariationForm] = useState<VariationFormState>(emptyVariationForm);
  const [variationError, setVariationError] = useState<string | null>(null);

  const openNewVariation = () => {
    setEditingVariationId(null);
    setVariationForm(emptyVariationForm);
    setVariationError(null);
    setVariationModalOpen(true);
  };

  const openEditVariation = (variation: PriceBookItemVariation) => {
    setEditingVariationId(variation.id);
    setVariationForm({
      name: variation.name,
      labourRate: (variation.labour_rate_cents / 100).toString(),
      labourHours: variation.labour_hours.toString(),
      materialCost: (variation.material_cost_cents / 100).toString(),
      markupPercent: variation.markup_percent.toString(),
    });
    setVariationError(null);
    setVariationModalOpen(true);
  };

  const saveVariation = useMutation({
    mutationFn: async () => {
      const result = createPriceBookVariationSchema.safeParse({
        price_book_item_id: id,
        name: variationForm.name,
        labour_rate_cents: Math.round(parseNumber(variationForm.labourRate) * 100),
        labour_hours: parseNumber(variationForm.labourHours),
        material_cost_cents: Math.round(parseNumber(variationForm.materialCost) * 100),
        markup_percent: parseNumber(variationForm.markupPercent),
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");
      if (!profile) throw new Error("Not signed in");

      const { error } = editingVariationId
        ? await supabase.from("price_book_item_variations").update(result.data).eq("id", editingVariationId)
        : await supabase.from("price_book_item_variations").insert({ ...result.data, tenant_id: profile.tenant_id });
      if (error) throw error;
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

  if (!item) {
    return (
      <div className="p-8" style={{ color: "var(--jms-text-muted)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}>
        Loading...
      </div>
    );
  }

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

      <div className="grid grid-cols-2 gap-3">
        <ThemedFormField label="Labour rate ($/hr)" value={labourRate} onChange={(e) => setLabourRate(e.target.value)} />
        <ThemedFormField label="Labour hours" value={labourHours} onChange={(e) => setLabourHours(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <ThemedFormField label="Material cost ($)" value={materialCost} onChange={(e) => setMaterialCost(e.target.value)} />
        <ThemedFormField label="Markup (%)" value={markupPercent} onChange={(e) => setMarkupPercent(e.target.value)} />
      </div>

      <label className="mb-4 flex items-center gap-2" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
        <input type="checkbox" checked={isCalloutFee} onChange={(e) => setIsCalloutFee(e.target.checked)} />
        This is the call-out / service fee
      </label>
      <p className="mb-4 -mt-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        A membership plan that waives the call-out fee will waive this item automatically when it's added to a quote or invoice.
      </p>

      <div className="mb-4 rounded p-3" style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)" }}>
        <p className="font-bold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Computed price
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
                {formatCentsAsAud(computeLineItemUnitPriceCents(variation))}
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
        <ThemedFormField
          label="Name"
          value={variationForm.name}
          onChange={(e) => setVariationForm({ ...variationForm, name: e.target.value })}
          placeholder="e.g. Standard, Premium"
        />
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField
            label="Labour rate ($/hr)"
            value={variationForm.labourRate}
            onChange={(e) => setVariationForm({ ...variationForm, labourRate: e.target.value })}
          />
          <ThemedFormField
            label="Labour hours"
            value={variationForm.labourHours}
            onChange={(e) => setVariationForm({ ...variationForm, labourHours: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField
            label="Material cost ($)"
            value={variationForm.materialCost}
            onChange={(e) => setVariationForm({ ...variationForm, materialCost: e.target.value })}
          />
          <ThemedFormField
            label="Markup (%)"
            value={variationForm.markupPercent}
            onChange={(e) => setVariationForm({ ...variationForm, markupPercent: e.target.value })}
          />
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

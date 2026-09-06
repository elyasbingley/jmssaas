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
import { Modal } from "../components/Modal";
import { FormField, TextAreaField } from "../components/FormField";

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
    return <div className="p-8 text-sm text-gray-500">Loading...</div>;
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <Link to={`/price-book/categories/${item.category_id}`} className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to category
      </Link>

      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-gray-500">Tile image</h2>
      {item.image_url ? (
        <img src={item.image_url} alt="" className="mb-2 h-32 w-full rounded-md bg-gray-50 object-cover" />
      ) : (
        <div className="mb-2 flex h-32 w-full items-center justify-center rounded-md bg-gray-100 text-sm text-gray-400">
          No image uploaded
        </div>
      )}
      <div className="mb-2 flex items-center gap-4">
        <label className="cursor-pointer rounded-md bg-gray-100 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-gray-200">
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
          <button onClick={() => removeImage.mutate()} className="text-sm font-semibold text-red-600">
            Remove
          </button>
        ) : null}
      </div>
      {imageError ? <p className="mb-4 text-sm text-red-600">{imageError}</p> : null}

      <TextAreaField label="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Labour rate ($/hr)" value={labourRate} onChange={(e) => setLabourRate(e.target.value)} />
        <FormField label="Labour hours" value={labourHours} onChange={(e) => setLabourHours(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Material cost ($)" value={materialCost} onChange={(e) => setMaterialCost(e.target.value)} />
        <FormField label="Markup (%)" value={markupPercent} onChange={(e) => setMarkupPercent(e.target.value)} />
      </div>

      <label className="mb-4 flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={isCalloutFee} onChange={(e) => setIsCalloutFee(e.target.checked)} />
        This is the call-out / service fee
      </label>
      <p className="mb-4 -mt-3 text-xs text-gray-500">
        A membership plan that waives the call-out fee will waive this item automatically when it's added to a quote or invoice.
      </p>

      <div className="mb-4 rounded-md bg-gray-50 p-3">
        <p className="text-xs font-bold text-gray-500">Computed price</p>
        <p className="text-xl font-extrabold text-gray-900">{formatCentsAsAud(previewCents)}</p>
      </div>

      {saveError ? <p className="mb-2 text-sm text-red-600">{saveError}</p> : null}
      {saved ? <p className="mb-2 text-sm text-green-700">Saved.</p> : null}

      <button
        onClick={() => save.mutate()}
        disabled={save.isPending}
        className="rounded-md bg-blue-700 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
      >
        {save.isPending ? "Saving..." : "Save changes"}
      </button>

      <h2 className="mb-2 mt-8 text-sm font-bold uppercase tracking-wide text-gray-500">Variations</h2>
      <div className="mb-3 overflow-hidden rounded-lg border border-gray-300 bg-white">
        {!variations || variations.length === 0 ? (
          <p className="p-4 text-sm text-gray-500">No variations yet.</p>
        ) : (
          variations.map((variation) => (
            <button
              key={variation.id}
              onClick={() => openEditVariation(variation)}
              className="flex w-full items-center justify-between border-b border-gray-200 px-4 py-3 text-left text-sm last:border-0 hover:bg-gray-50"
            >
              <span className="font-medium text-gray-900">{variation.name}</span>
              <span className="font-semibold text-blue-700">{formatCentsAsAud(computeLineItemUnitPriceCents(variation))}</span>
            </button>
          ))
        )}
      </div>
      <button onClick={openNewVariation} className="text-sm font-semibold text-blue-700 hover:underline">
        + Add variation
      </button>

      <div className="mt-8 border-t border-gray-300 pt-6">
        <button
          onClick={() => deleteItem.mutate()}
          className="rounded-md bg-red-50 px-6 py-3 text-sm font-semibold text-red-600 hover:bg-red-100"
        >
          Delete item
        </button>
      </div>

      <Modal open={variationModalOpen} onClose={() => setVariationModalOpen(false)} title={editingVariationId ? "Edit variation" : "New variation"}>
        <FormField
          label="Name"
          value={variationForm.name}
          onChange={(e) => setVariationForm({ ...variationForm, name: e.target.value })}
          placeholder="e.g. Standard, Premium"
        />
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Labour rate ($/hr)"
            value={variationForm.labourRate}
            onChange={(e) => setVariationForm({ ...variationForm, labourRate: e.target.value })}
          />
          <FormField
            label="Labour hours"
            value={variationForm.labourHours}
            onChange={(e) => setVariationForm({ ...variationForm, labourHours: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Material cost ($)"
            value={variationForm.materialCost}
            onChange={(e) => setVariationForm({ ...variationForm, materialCost: e.target.value })}
          />
          <FormField
            label="Markup (%)"
            value={variationForm.markupPercent}
            onChange={(e) => setVariationForm({ ...variationForm, markupPercent: e.target.value })}
          />
        </div>
        {variationError ? <p className="mb-4 text-sm text-red-600">{variationError}</p> : null}
        <div className="flex items-center justify-end gap-3">
          {editingVariationId ? (
            <button onClick={() => deleteVariation.mutate()} className="mr-auto text-sm font-semibold text-red-600">
              Delete
            </button>
          ) : null}
          <button onClick={() => setVariationModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveVariation.mutate()}
            disabled={saveVariation.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveVariation.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

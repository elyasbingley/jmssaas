import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createInventoryCategorySchema,
  createInventorySubcategorySchema,
  createInventorySupplierSchema,
  type InventoryCategory,
  type InventoryItem,
  type InventorySubcategory,
  type InventorySupplier,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField } from "../components/FormField";

// Direct port of apps/mobile/app/inventory-setup.tsx - same two-level
// category hierarchy (Material/Tools -> Roofing/Power Tools) and flat
// supplier list; items themselves are created inline from the Inventory
// screen, same as mobile.

async function fetchCategories(): Promise<InventoryCategory[]> {
  const { data, error } = await supabase.from("inventory_categories").select("*").order("sort_order, name");
  if (error) throw error;
  return data as InventoryCategory[];
}
async function fetchSubcategories(): Promise<InventorySubcategory[]> {
  const { data, error } = await supabase.from("inventory_subcategories").select("*").order("sort_order, name");
  if (error) throw error;
  return data as InventorySubcategory[];
}
async function fetchSuppliers(): Promise<InventorySupplier[]> {
  const { data, error } = await supabase.from("inventory_suppliers").select("*").order("name");
  if (error) throw error;
  return data as InventorySupplier[];
}
// Loaded only to show "this will also delete N items" counts in the
// category delete confirmation - not edited from this screen.
async function fetchItems(): Promise<InventoryItem[]> {
  const { data, error } = await supabase.from("inventory_items").select("*");
  if (error) throw error;
  return data as InventoryItem[];
}

export default function InventorySetupPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: categories } = useQuery({ queryKey: ["inventory-categories"], queryFn: fetchCategories });
  const { data: subcategories } = useQuery({ queryKey: ["inventory-subcategories"], queryFn: fetchSubcategories });
  const { data: suppliers } = useQuery({ queryKey: ["inventory-suppliers"], queryFn: fetchSuppliers });
  const { data: items } = useQuery({ queryKey: ["inventory-items"], queryFn: fetchItems });

  const invalidateCategories = () => queryClient.invalidateQueries({ queryKey: ["inventory-categories"] });
  const invalidateSubcategories = () => queryClient.invalidateQueries({ queryKey: ["inventory-subcategories"] });
  const invalidateSuppliers = () => queryClient.invalidateQueries({ queryKey: ["inventory-suppliers"] });

  // --- Categories ---
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<InventoryCategory | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryColor, setCategoryColor] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const openNewCategory = () => {
    setEditingCategory(null);
    setCategoryName("");
    setCategoryColor("");
    setCategoryError(null);
    setCategoryModalOpen(true);
  };
  const openEditCategory = (category: InventoryCategory) => {
    setEditingCategory(category);
    setCategoryName(category.name);
    setCategoryColor(category.color ?? "");
    setCategoryError(null);
    setCategoryModalOpen(true);
  };

  const saveCategory = useMutation({
    mutationFn: async () => {
      const list = categories ?? [];
      const result = createInventoryCategorySchema.safeParse({
        name: categoryName,
        color: categoryColor || undefined,
        sort_order: editingCategory?.sort_order ?? list.length,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid category");
      if (!profile) throw new Error("Not signed in");

      if (editingCategory) {
        const { error } = await supabase
          .from("inventory_categories")
          .update({ name: result.data.name, color: result.data.color || null })
          .eq("id", editingCategory.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("inventory_categories").insert({
          tenant_id: profile.tenant_id,
          name: result.data.name,
          color: result.data.color || null,
          sort_order: result.data.sort_order,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      invalidateCategories();
      setCategoryModalOpen(false);
    },
    onError: (e) => setCategoryError(getErrorMessage(e, "Failed to save category")),
  });

  const deleteCategory = useMutation({
    mutationFn: async (category: InventoryCategory) => {
      const { error } = await supabase.from("inventory_categories").delete().eq("id", category.id);
      if (error) throw error;
    },
    onSuccess: invalidateCategories,
  });

  const handleDeleteCategory = (category: InventoryCategory) => {
    const subcategoryCount = (subcategories ?? []).filter((s) => s.category_id === category.id).length;
    const itemCount = (items ?? []).filter((i) => i.category_id === category.id).length;
    const consequences = [
      subcategoryCount > 0 ? `${subcategoryCount} subcategor${subcategoryCount === 1 ? "y" : "ies"}` : null,
      itemCount > 0 ? `${itemCount} item${itemCount === 1 ? "" : "s"} (and their stock records)` : null,
    ].filter(Boolean);
    const message =
      consequences.length > 0
        ? `Delete "${category.name}"? This will also delete ${consequences.join(" and ")}.`
        : `Delete "${category.name}"?`;
    if (window.confirm(message)) deleteCategory.mutate(category);
  };

  // --- Subcategories ---
  const [subcategoryModalOpen, setSubcategoryModalOpen] = useState(false);
  const [editingSubcategory, setEditingSubcategory] = useState<InventorySubcategory | null>(null);
  const [subcategoryForCategoryId, setSubcategoryForCategoryId] = useState<string | null>(null);
  const [subcategoryName, setSubcategoryName] = useState("");
  const [subcategoryColor, setSubcategoryColor] = useState("");
  const [subcategoryError, setSubcategoryError] = useState<string | null>(null);

  const openNewSubcategory = (categoryId: string) => {
    setEditingSubcategory(null);
    setSubcategoryForCategoryId(categoryId);
    setSubcategoryName("");
    setSubcategoryColor("");
    setSubcategoryError(null);
    setSubcategoryModalOpen(true);
  };
  const openEditSubcategory = (subcategory: InventorySubcategory) => {
    setEditingSubcategory(subcategory);
    setSubcategoryForCategoryId(subcategory.category_id);
    setSubcategoryName(subcategory.name);
    setSubcategoryColor(subcategory.color ?? "");
    setSubcategoryError(null);
    setSubcategoryModalOpen(true);
  };

  const saveSubcategory = useMutation({
    mutationFn: async () => {
      if (!subcategoryForCategoryId) throw new Error("No category selected");
      const siblingCount = (subcategories ?? []).filter((s) => s.category_id === subcategoryForCategoryId).length;
      const result = createInventorySubcategorySchema.safeParse({
        category_id: subcategoryForCategoryId,
        name: subcategoryName,
        color: subcategoryColor || undefined,
        sort_order: editingSubcategory?.sort_order ?? siblingCount,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid subcategory");
      if (!profile) throw new Error("Not signed in");

      if (editingSubcategory) {
        const { error } = await supabase
          .from("inventory_subcategories")
          .update({ name: result.data.name, color: result.data.color || null })
          .eq("id", editingSubcategory.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("inventory_subcategories").insert({
          tenant_id: profile.tenant_id,
          category_id: result.data.category_id,
          name: result.data.name,
          color: result.data.color || null,
          sort_order: result.data.sort_order,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      invalidateSubcategories();
      setSubcategoryModalOpen(false);
    },
    onError: (e) => setSubcategoryError(getErrorMessage(e, "Failed to save subcategory")),
  });

  const deleteSubcategory = useMutation({
    mutationFn: async (subcategory: InventorySubcategory) => {
      const { error } = await supabase.from("inventory_subcategories").delete().eq("id", subcategory.id);
      if (error) throw error;
    },
    onSuccess: invalidateSubcategories,
  });

  const handleDeleteSubcategory = (subcategory: InventorySubcategory) => {
    const itemCount = (items ?? []).filter((i) => i.subcategory_id === subcategory.id).length;
    const note = itemCount > 0 ? " Items using it will just lose that tag, not be deleted." : "";
    if (window.confirm(`Delete "${subcategory.name}"?${note}`)) deleteSubcategory.mutate(subcategory);
  };

  // --- Suppliers ---
  const [supplierModalOpen, setSupplierModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<InventorySupplier | null>(null);
  const [supplierName, setSupplierName] = useState("");
  const [supplierError, setSupplierError] = useState<string | null>(null);

  const openNewSupplier = () => {
    setEditingSupplier(null);
    setSupplierName("");
    setSupplierError(null);
    setSupplierModalOpen(true);
  };
  const openEditSupplier = (supplier: InventorySupplier) => {
    setEditingSupplier(supplier);
    setSupplierName(supplier.name);
    setSupplierError(null);
    setSupplierModalOpen(true);
  };

  const saveSupplier = useMutation({
    mutationFn: async () => {
      const result = createInventorySupplierSchema.safeParse({ name: supplierName });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid supplier");
      if (!profile) throw new Error("Not signed in");

      if (editingSupplier) {
        const { error } = await supabase.from("inventory_suppliers").update({ name: result.data.name }).eq("id", editingSupplier.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("inventory_suppliers").insert({ tenant_id: profile.tenant_id, name: result.data.name });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      invalidateSuppliers();
      setSupplierModalOpen(false);
    },
    onError: (e) => setSupplierError(getErrorMessage(e, "Failed to save supplier")),
  });

  const deleteSupplier = useMutation({
    mutationFn: async (supplier: InventorySupplier) => {
      const { error } = await supabase.from("inventory_suppliers").delete().eq("id", supplier.id);
      if (error) throw error;
    },
    onSuccess: invalidateSuppliers,
  });

  const handleDeleteSupplier = (supplier: InventorySupplier) => {
    const itemCount = (items ?? []).filter((i) => i.supplier_id === supplier.id).length;
    const note = itemCount > 0 ? " Items using it will just lose that tag, not be deleted." : "";
    if (window.confirm(`Delete "${supplier.name}"?${note}`)) deleteSupplier.mutate(supplier);
  };

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-bold text-gray-900">Inventory Setup</h1>

      <h2 className="mb-1 mt-6 text-sm font-bold uppercase tracking-wide text-gray-500">Categories</h2>
      <p className="mb-3 text-sm text-gray-500">
        "Material" and "Tools" as top-level categories, with "Roofing" or "Power Tools" as subcategories underneath.
      </p>

      <div className="rounded-lg border border-gray-300 bg-white">
        {(categories ?? []).length === 0 ? (
          <p className="p-4 text-sm text-gray-500">No categories yet.</p>
        ) : (
          (categories ?? []).map((category) => {
            const categorySubcategories = (subcategories ?? []).filter((s) => s.category_id === category.id);
            return (
              <div key={category.id} className="border-b border-gray-200 last:border-0">
                <div className="flex items-center justify-between gap-3 p-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ backgroundColor: category.color ?? "#e5e7eb" }} />
                    <span className="truncate text-sm font-semibold text-gray-900">{category.name}</span>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-3 text-sm">
                    <button onClick={() => openEditCategory(category)} className="font-semibold text-blue-700 hover:underline">
                      Edit
                    </button>
                    <button onClick={() => handleDeleteCategory(category)} className="font-semibold text-red-600 hover:underline">
                      Delete
                    </button>
                  </div>
                </div>
                {categorySubcategories.map((subcategory) => (
                  <div key={subcategory.id} className="flex items-center justify-between gap-3 py-2 pl-8 pr-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: subcategory.color ?? "#e5e7eb" }}
                      />
                      <span className="truncate text-sm text-gray-800">{subcategory.name}</span>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-3 text-sm">
                      <button onClick={() => openEditSubcategory(subcategory)} className="font-semibold text-blue-700 hover:underline">
                        Edit
                      </button>
                      <button onClick={() => handleDeleteSubcategory(subcategory)} className="font-semibold text-red-600 hover:underline">
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => openNewSubcategory(category.id)}
                  className="w-full py-2 pl-8 text-left text-xs font-semibold text-blue-700 hover:underline"
                >
                  + Add subcategory
                </button>
              </div>
            );
          })
        )}
      </div>
      <button
        onClick={openNewCategory}
        className="mt-3 w-full rounded-md bg-blue-700 py-2.5 text-sm font-semibold text-white hover:bg-blue-800"
      >
        + New category
      </button>

      <h2 className="mb-1 mt-8 text-sm font-bold uppercase tracking-wide text-gray-500">Suppliers</h2>
      <p className="mb-3 text-sm text-gray-500">Who you buy each item from - e.g. "Bunnings", "Reece".</p>

      <div className="divide-y divide-gray-100 rounded-lg border border-gray-300 bg-white">
        {(suppliers ?? []).length === 0 ? (
          <p className="p-4 text-sm text-gray-500">No suppliers yet.</p>
        ) : (
          (suppliers ?? []).map((supplier) => (
            <div key={supplier.id} className="flex items-center justify-between gap-3 p-3">
              <span className="text-sm font-semibold text-gray-900">{supplier.name}</span>
              <div className="flex flex-shrink-0 items-center gap-3 text-sm">
                <button onClick={() => openEditSupplier(supplier)} className="font-semibold text-blue-700 hover:underline">
                  Edit
                </button>
                <button onClick={() => handleDeleteSupplier(supplier)} className="font-semibold text-red-600 hover:underline">
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <button
        onClick={openNewSupplier}
        className="mt-3 w-full rounded-md bg-blue-700 py-2.5 text-sm font-semibold text-white hover:bg-blue-800"
      >
        + New supplier
      </button>

      <Modal open={categoryModalOpen} onClose={() => setCategoryModalOpen(false)} title={editingCategory ? "Edit category" : "New category"}>
        <FormField label="Name" value={categoryName} onChange={(e) => setCategoryName(e.target.value)} placeholder="e.g. Material, Tools, First Aid Kit" />
        <FormField label="Color (optional hex, e.g. #1d4ed8)" value={categoryColor} onChange={(e) => setCategoryColor(e.target.value)} placeholder="#1d4ed8" />
        {categoryError ? <p className="mb-4 text-sm text-red-600">{categoryError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setCategoryModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveCategory.mutate()}
            disabled={saveCategory.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveCategory.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal open={subcategoryModalOpen} onClose={() => setSubcategoryModalOpen(false)} title={editingSubcategory ? "Edit subcategory" : "New subcategory"}>
        <FormField label="Name" value={subcategoryName} onChange={(e) => setSubcategoryName(e.target.value)} placeholder="e.g. Roofing, Power Tools" />
        <FormField label="Color (optional hex, e.g. #1d4ed8)" value={subcategoryColor} onChange={(e) => setSubcategoryColor(e.target.value)} placeholder="#1d4ed8" />
        {subcategoryError ? <p className="mb-4 text-sm text-red-600">{subcategoryError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setSubcategoryModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveSubcategory.mutate()}
            disabled={saveSubcategory.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveSubcategory.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal open={supplierModalOpen} onClose={() => setSupplierModalOpen(false)} title={editingSupplier ? "Edit supplier" : "New supplier"}>
        <FormField label="Name" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} placeholder="e.g. Bunnings, Reece" />
        {supplierError ? <p className="mb-4 text-sm text-red-600">{supplierError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setSupplierModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveSupplier.mutate()}
            disabled={saveSupplier.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveSupplier.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

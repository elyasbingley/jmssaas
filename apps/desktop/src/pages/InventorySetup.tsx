import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
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
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField } from "../components/theme/ThemedFormField";

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
    <div className="mx-auto max-w-2xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Settings
      </Link>
      <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Inventory Setup
      </h1>

      <h2 className="mb-1 mt-6 uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Categories
      </h2>
      <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        "Material" and "Tools" as top-level categories, with "Roofing" or "Power Tools" as subcategories underneath.
      </p>

      <div className="rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {(categories ?? []).length === 0 ? (
          <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No categories yet.
          </p>
        ) : (
          (categories ?? []).map((category, i) => {
            const categorySubcategories = (subcategories ?? []).filter((s) => s.category_id === category.id);
            return (
              <div key={category.id} className="last:border-0" style={i > 0 ? { borderTop: "1px solid var(--jms-border)" } : undefined}>
                <div className="flex items-center justify-between gap-3 p-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ backgroundColor: category.color ?? "var(--jms-border)" }} />
                    <span className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                      {category.name}
                    </span>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-3" style={{ fontSize: "var(--jms-font-body)" }}>
                    <button onClick={() => openEditCategory(category)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)" }}>
                      Edit
                    </button>
                    <button onClick={() => handleDeleteCategory(category)} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)" }}>
                      Delete
                    </button>
                  </div>
                </div>
                {categorySubcategories.map((subcategory) => (
                  <div key={subcategory.id} className="flex items-center justify-between gap-3 py-2 pl-8 pr-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: subcategory.color ?? "var(--jms-border)" }}
                      />
                      <span className="truncate" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                        {subcategory.name}
                      </span>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-3" style={{ fontSize: "var(--jms-font-body)" }}>
                      <button onClick={() => openEditSubcategory(subcategory)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)" }}>
                        Edit
                      </button>
                      <button onClick={() => handleDeleteSubcategory(subcategory)} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)" }}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => openNewSubcategory(category.id)}
                  className="w-full py-2 pl-8 text-left font-semibold hover:underline"
                  style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
                >
                  + Add subcategory
                </button>
              </div>
            );
          })
        )}
      </div>
      <div className="mt-3">
        <ThemedButton onClick={openNewCategory} className="w-full">
          + New category
        </ThemedButton>
      </div>

      <h2 className="mb-1 mt-8 uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Suppliers
      </h2>
      <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Who you buy each item from - e.g. "Bunnings", "Reece".
      </p>

      <div className="rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {(suppliers ?? []).length === 0 ? (
          <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No suppliers yet.
          </p>
        ) : (
          (suppliers ?? []).map((supplier, i) => (
            <div
              key={supplier.id}
              className="flex items-center justify-between gap-3 p-3"
              style={i > 0 ? { borderTop: "1px solid var(--jms-border)" } : undefined}
            >
              <span className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                {supplier.name}
              </span>
              <div className="flex flex-shrink-0 items-center gap-3" style={{ fontSize: "var(--jms-font-body)" }}>
                <button onClick={() => openEditSupplier(supplier)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)" }}>
                  Edit
                </button>
                <button onClick={() => handleDeleteSupplier(supplier)} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)" }}>
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="mt-3">
        <ThemedButton onClick={openNewSupplier} className="w-full">
          + New supplier
        </ThemedButton>
      </div>

      <ThemedModal open={categoryModalOpen} onClose={() => setCategoryModalOpen(false)} title={editingCategory ? "Edit category" : "New category"}>
        <ThemedFormField label="Name" value={categoryName} onChange={(e) => setCategoryName(e.target.value)} placeholder="e.g. Material, Tools, First Aid Kit" />
        <ThemedFormField label="Color (optional hex, e.g. #1d4ed8)" value={categoryColor} onChange={(e) => setCategoryColor(e.target.value)} placeholder="#1d4ed8" />
        {categoryError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {categoryError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setCategoryModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveCategory.mutate()} disabled={saveCategory.isPending}>
            {saveCategory.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal open={subcategoryModalOpen} onClose={() => setSubcategoryModalOpen(false)} title={editingSubcategory ? "Edit subcategory" : "New subcategory"}>
        <ThemedFormField label="Name" value={subcategoryName} onChange={(e) => setSubcategoryName(e.target.value)} placeholder="e.g. Roofing, Power Tools" />
        <ThemedFormField label="Color (optional hex, e.g. #1d4ed8)" value={subcategoryColor} onChange={(e) => setSubcategoryColor(e.target.value)} placeholder="#1d4ed8" />
        {subcategoryError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {subcategoryError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setSubcategoryModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveSubcategory.mutate()} disabled={saveSubcategory.isPending}>
            {saveSubcategory.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal open={supplierModalOpen} onClose={() => setSupplierModalOpen(false)} title={editingSupplier ? "Edit supplier" : "New supplier"}>
        <ThemedFormField label="Name" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} placeholder="e.g. Bunnings, Reece" />
        {supplierError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {supplierError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setSupplierModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveSupplier.mutate()} disabled={saveSupplier.isPending}>
            {saveSupplier.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}

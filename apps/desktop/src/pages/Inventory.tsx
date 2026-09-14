import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  createInventoryItemSchema,
  createInventoryLocationSchema,
  type InventoryCategory,
  type InventoryItem,
  type InventoryLevel,
  type InventoryLocation,
  type InventorySubcategory,
  type InventorySupplier,
  type LowStockItem,
  type Tenant,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { buildShoppingListPdfHtml } from "../lib/shopping-list-pdf";
import { exportPdf } from "../lib/print";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField, ThemedSelectField } from "../components/theme/ThemedFormField";

// Direct port of apps/mobile/app/(tabs)/sales/inventory/index.tsx - same
// standalone catalogue (inventory_items organised by inventory_categories/
// inventory_subcategories, unrelated to the price book), same Location >
// Category > Subcategory drill-down as chip filters on one screen, same
// Stock / Out of Stock tabs. Reads/writes go through plain Supabase calls
// instead of PowerSync's execute(), since desktop has no offline mode.

async function fetchLocations(): Promise<InventoryLocation[]> {
  const { data, error } = await supabase.from("inventory_locations").select("*").order("name");
  if (error) throw error;
  return data as InventoryLocation[];
}
async function fetchLevels(): Promise<InventoryLevel[]> {
  const { data, error } = await supabase.from("inventory_levels").select("*");
  if (error) throw error;
  return data as InventoryLevel[];
}
async function fetchItems(): Promise<InventoryItem[]> {
  const { data, error } = await supabase.from("inventory_items").select("*").order("name");
  if (error) throw error;
  return data as InventoryItem[];
}
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
async function fetchTenant(tenantId: string): Promise<Tenant> {
  const { data, error } = await supabase.from("tenants").select("*").eq("id", tenantId).single();
  if (error) throw error;
  return data as Tenant;
}

export default function InventoryPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: locations } = useQuery({ queryKey: ["inventory-locations"], queryFn: fetchLocations });
  const { data: levels } = useQuery({ queryKey: ["inventory-levels"], queryFn: fetchLevels });
  const { data: items } = useQuery({ queryKey: ["inventory-items"], queryFn: fetchItems });
  const { data: categories } = useQuery({ queryKey: ["inventory-categories"], queryFn: fetchCategories });
  const { data: subcategories } = useQuery({ queryKey: ["inventory-subcategories"], queryFn: fetchSubcategories });
  const { data: suppliers } = useQuery({ queryKey: ["inventory-suppliers"], queryFn: fetchSuppliers });
  const { data: tenant } = useQuery({
    queryKey: ["tenant", profile?.tenant_id],
    queryFn: () => fetchTenant(profile!.tenant_id),
    enabled: !!profile,
  });

  const [activeTab, setActiveTab] = useState<"stock" | "low-stock">("stock");
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [selectedSubcategoryId, setSelectedSubcategoryId] = useState<string | null>(null);
  const [lowStockSupplierId, setLowStockSupplierId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedLocationId && locations && locations.length > 0) {
      setSelectedLocationId(locations[0]!.id);
    }
  }, [locations, selectedLocationId]);

  useEffect(() => {
    setSelectedSubcategoryId(null);
  }, [selectedCategoryId]);

  const levelByKey = useMemo(
    () => new Map((levels ?? []).map((level) => [`${level.location_id}:${level.item_id}`, level])),
    [levels]
  );
  const itemById = useMemo(() => new Map((items ?? []).map((item) => [item.id, item])), [items]);
  const locationById = useMemo(() => new Map((locations ?? []).map((loc) => [loc.id, loc])), [locations]);
  const categoryById = useMemo(() => new Map((categories ?? []).map((cat) => [cat.id, cat])), [categories]);
  const subcategoryById = useMemo(() => new Map((subcategories ?? []).map((sub) => [sub.id, sub])), [subcategories]);
  const supplierById = useMemo(() => new Map((suppliers ?? []).map((sup) => [sup.id, sup])), [suppliers]);

  const subcategoriesForSelectedCategory = selectedCategoryId
    ? (subcategories ?? []).filter((s) => s.category_id === selectedCategoryId)
    : [];

  const visibleItems = (items ?? []).filter((item) => {
    if (selectedCategoryId && item.category_id !== selectedCategoryId) return false;
    if (selectedSubcategoryId && item.subcategory_id !== selectedSubcategoryId) return false;
    return true;
  });

  const allLowStockItems: LowStockItem[] = (levels ?? [])
    .filter((level) => {
      const item = itemById.get(level.item_id);
      return item ? level.quantity <= item.reorder_threshold : false;
    })
    .map((level) => {
      const item = itemById.get(level.item_id);
      const location = locationById.get(level.location_id);
      const category = item ? categoryById.get(item.category_id) : undefined;
      const subcategory = item?.subcategory_id ? subcategoryById.get(item.subcategory_id) : undefined;
      const supplier = item?.supplier_id ? supplierById.get(item.supplier_id) : undefined;
      return {
        inventory_level_id: level.id,
        location_id: level.location_id,
        location_name: location?.name ?? "Unknown location",
        item_id: level.item_id,
        item_name: item?.name ?? "Unknown item",
        category_id: category?.id ?? null,
        category_name: category?.name ?? null,
        subcategory_id: subcategory?.id ?? null,
        subcategory_name: subcategory?.name ?? null,
        supplier_id: supplier?.id ?? null,
        supplier_name: supplier?.name ?? null,
        quantity: level.quantity,
        reorder_threshold: item?.reorder_threshold ?? 0,
        ideal_stock: item?.ideal_stock ?? 0,
      };
    })
    .sort((a, b) => a.quantity - b.quantity);

  const lowStockItems = lowStockSupplierId
    ? allLowStockItems.filter((item) => item.supplier_id === lowStockSupplierId)
    : allLowStockItems;

  const invalidateLevels = () => queryClient.invalidateQueries({ queryKey: ["inventory-levels"] });

  const adjustLevel = useMutation({
    mutationFn: async ({ item, delta }: { item: InventoryItem; delta: number }) => {
      if (!selectedLocationId || !profile) return;
      const existing = levelByKey.get(`${selectedLocationId}:${item.id}`);
      if (existing) {
        const nextQuantity = Math.max(0, existing.quantity + delta);
        const { error } = await supabase.from("inventory_levels").update({ quantity: nextQuantity }).eq("id", existing.id);
        if (error) throw error;
      } else if (delta > 0) {
        const { error } = await supabase.from("inventory_levels").insert({
          tenant_id: profile.tenant_id,
          location_id: selectedLocationId,
          item_id: item.id,
          quantity: 1,
        });
        if (error) throw error;
      }
    },
    onSuccess: invalidateLevels,
  });

  // --- New location ---
  const [locationModalOpen, setLocationModalOpen] = useState(false);
  const [newLocationName, setNewLocationName] = useState("");
  const [newLocationType, setNewLocationType] = useState("");
  const [locationError, setLocationError] = useState<string | null>(null);

  const createLocation = useMutation({
    mutationFn: async () => {
      const result = createInventoryLocationSchema.safeParse({ name: newLocationName, type: newLocationType || undefined });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid location");
      if (!profile) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("inventory_locations")
        .insert({ tenant_id: profile.tenant_id, name: result.data.name, type: result.data.type || null })
        .select()
        .single();
      if (error) throw error;
      return data as InventoryLocation;
    },
    onSuccess: (location) => {
      queryClient.invalidateQueries({ queryKey: ["inventory-locations"] });
      setSelectedLocationId(location.id);
      setNewLocationName("");
      setNewLocationType("");
      setLocationModalOpen(false);
    },
    onError: (e) => setLocationError(getErrorMessage(e, "Failed to create location")),
  });

  // --- New/edit item ---
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [newItemName, setNewItemName] = useState("");
  const [newItemCategoryId, setNewItemCategoryId] = useState("");
  const [newItemSubcategoryId, setNewItemSubcategoryId] = useState("");
  const [newItemSupplierId, setNewItemSupplierId] = useState("");
  const [newItemReorderThreshold, setNewItemReorderThreshold] = useState("5");
  const [newItemIdealStock, setNewItemIdealStock] = useState("10");
  const [itemError, setItemError] = useState<string | null>(null);

  const openNewItemModal = () => {
    setEditingItem(null);
    setNewItemName("");
    setNewItemCategoryId(selectedCategoryId ?? "");
    setNewItemSubcategoryId(selectedSubcategoryId ?? "");
    setNewItemSupplierId("");
    setNewItemReorderThreshold("5");
    setNewItemIdealStock("10");
    setItemError(null);
    setItemModalOpen(true);
  };
  const openEditItemModal = (item: InventoryItem) => {
    setEditingItem(item);
    setNewItemName(item.name);
    setNewItemCategoryId(item.category_id);
    setNewItemSubcategoryId(item.subcategory_id ?? "");
    setNewItemSupplierId(item.supplier_id ?? "");
    setNewItemReorderThreshold(String(item.reorder_threshold));
    setNewItemIdealStock(String(item.ideal_stock));
    setItemError(null);
    setItemModalOpen(true);
  };

  const newItemSubcategoryOptions = newItemCategoryId
    ? (subcategories ?? []).filter((s) => s.category_id === newItemCategoryId)
    : [];

  const saveItem = useMutation({
    mutationFn: async () => {
      const result = createInventoryItemSchema.safeParse({
        name: newItemName,
        category_id: newItemCategoryId || undefined,
        subcategory_id: newItemSubcategoryId || undefined,
        supplier_id: newItemSupplierId || undefined,
        reorder_threshold: Number(newItemReorderThreshold),
        ideal_stock: Number(newItemIdealStock),
      });
      if (!result.success) throw new Error(newItemCategoryId ? result.error.issues[0]?.message ?? "Invalid item" : "Pick a category first");
      if (!profile) throw new Error("Not signed in");

      if (editingItem) {
        const { error } = await supabase
          .from("inventory_items")
          .update({
            category_id: result.data.category_id,
            subcategory_id: result.data.subcategory_id ?? null,
            supplier_id: result.data.supplier_id ?? null,
            name: result.data.name,
            reorder_threshold: result.data.reorder_threshold,
            ideal_stock: result.data.ideal_stock,
          })
          .eq("id", editingItem.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("inventory_items").insert({
          tenant_id: profile.tenant_id,
          category_id: result.data.category_id,
          subcategory_id: result.data.subcategory_id ?? null,
          supplier_id: result.data.supplier_id ?? null,
          name: result.data.name,
          reorder_threshold: result.data.reorder_threshold,
          ideal_stock: result.data.ideal_stock,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory-items"] });
      setItemModalOpen(false);
    },
    onError: (e) => setItemError(getErrorMessage(e, "Failed to save item")),
  });

  const [generatingList, setGeneratingList] = useState(false);
  const [shoppingListError, setShoppingListError] = useState<string | null>(null);

  const handleGenerateShoppingList = () => {
    if (!tenant) return;
    setGeneratingList(true);
    setShoppingListError(null);
    try {
      const html = buildShoppingListPdfHtml({ tenant, items: lowStockItems });
      exportPdf(html, "Shopping List");
    } catch (e) {
      setShoppingListError(getErrorMessage(e, "Failed to generate PDF"));
    } finally {
      setGeneratingList(false);
    }
  };

  return (
    <div className="flex h-full flex-col p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
          Inventory
        </h1>
        <Link to="/settings/inventory-setup" className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
          ⚙ Manage categories & suppliers
        </Link>
      </div>

      <div className="mb-4 flex gap-2">
        <button
          onClick={() => setActiveTab("stock")}
          className="rounded-full border px-4 py-1.5 font-semibold"
          style={
            activeTab === "stock"
              ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
              : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
          }
        >
          Stock
        </button>
        <button
          onClick={() => setActiveTab("low-stock")}
          className="flex items-center gap-2 rounded-full border px-4 py-1.5 font-semibold"
          style={
            activeTab === "low-stock"
              ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
              : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
          }
        >
          Out of Stock / Need to Order
          {allLowStockItems.length > 0 ? (
            <span
              className="rounded-full px-2 py-0.5 font-bold"
              style={{ backgroundColor: "var(--jms-danger)", color: "var(--jms-bg)", fontSize: "var(--jms-font-label)" }}
            >
              {allLowStockItems.length}
            </span>
          ) : null}
        </button>
      </div>

      {activeTab === "stock" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {(locations ?? []).map((location) => (
              <button
                key={location.id}
                onClick={() => setSelectedLocationId(location.id)}
                className="rounded-full border px-3 py-1.5 font-semibold"
                style={
                  selectedLocationId === location.id
                    ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                    : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
                }
              >
                {location.name}
              </button>
            ))}
            <button
              onClick={() => setLocationModalOpen(true)}
              className="rounded-full border px-3 py-1.5 font-semibold"
              style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
            >
              + New location
            </button>
          </div>

          {(locations ?? []).length === 0 ? (
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              Add a location (e.g. "Ute 1") to start tracking stock.
            </p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setSelectedCategoryId(null)}
                  className="rounded-full border px-3 py-1.5 font-semibold"
                  style={
                    selectedCategoryId === null
                      ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                      : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
                  }
                >
                  All
                </button>
                {(categories ?? []).map((category) => (
                  <button
                    key={category.id}
                    onClick={() => setSelectedCategoryId(category.id)}
                    className="rounded-full border px-3 py-1.5 font-semibold"
                    style={
                      selectedCategoryId === category.id
                        ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                        : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
                    }
                  >
                    {category.name}
                  </button>
                ))}
              </div>

              {(categories ?? []).length === 0 ? (
                <p className="mb-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                  No categories yet -{" "}
                  <Link to="/settings/inventory-setup" className="font-semibold hover:underline" style={{ color: "var(--jms-accent)" }}>
                    manage categories
                  </Link>{" "}
                  to set up Material, Tools, etc. before adding items.
                </p>
              ) : null}

              {subcategoriesForSelectedCategory.length > 0 ? (
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setSelectedSubcategoryId(null)}
                    className="rounded-full border px-3 py-1 font-semibold"
                    style={
                      selectedSubcategoryId === null
                        ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                        : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
                    }
                  >
                    All
                  </button>
                  {subcategoriesForSelectedCategory.map((subcategory) => (
                    <button
                      key={subcategory.id}
                      onClick={() => setSelectedSubcategoryId(subcategory.id)}
                      className="rounded-full border px-3 py-1 font-semibold"
                      style={
                        selectedSubcategoryId === subcategory.id
                          ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                          : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
                      }
                    >
                      {subcategory.name}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="min-h-0 flex-1 overflow-y-auto rounded p-3" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
                {visibleItems.length === 0 ? (
                  <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                    No items here yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {visibleItems.map((item) => {
                      const level = selectedLocationId ? levelByKey.get(`${selectedLocationId}:${item.id}`) : undefined;
                      const quantity = level?.quantity ?? 0;
                      const isLow = level ? level.quantity <= item.reorder_threshold : false;
                      const supplier = item.supplier_id ? supplierById.get(item.supplier_id) : undefined;
                      return (
                        <div key={item.id} className="flex items-center justify-between gap-3 rounded p-3" style={{ backgroundColor: "var(--jms-bg)" }}>
                          <button onClick={() => openEditItemModal(item)} className="min-w-0 flex-1 text-left">
                            <p className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                              {item.name}
                            </p>
                            {supplier ? (
                              <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{supplier.name}</p>
                            ) : null}
                            {isLow ? (
                              <span
                                className="mt-1 inline-block rounded-full border px-2 py-0.5 font-bold"
                                style={{
                                  borderColor: quantity === 0 ? "var(--jms-danger)" : "var(--jms-warning)",
                                  color: quantity === 0 ? "var(--jms-danger)" : "var(--jms-warning)",
                                  fontSize: "var(--jms-font-label)",
                                }}
                              >
                                {quantity === 0 ? "Out of stock" : "Low stock"}
                              </span>
                            ) : null}
                          </button>
                          <div className="flex flex-shrink-0 items-center gap-3">
                            <button
                              onClick={() => adjustLevel.mutate({ item, delta: -1 })}
                              disabled={!selectedLocationId || quantity === 0}
                              className="flex h-8 w-8 items-center justify-center rounded-full text-lg font-bold disabled:opacity-40"
                              style={{ backgroundColor: "var(--jms-accent)", color: "var(--jms-bg)" }}
                            >
                              &minus;
                            </button>
                            <span className="w-6 text-center font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                              {quantity}
                            </span>
                            <button
                              onClick={() => adjustLevel.mutate({ item, delta: 1 })}
                              disabled={!selectedLocationId}
                              className="flex h-8 w-8 items-center justify-center rounded-full text-lg font-bold disabled:opacity-40"
                              style={{ backgroundColor: "var(--jms-accent)", color: "var(--jms-bg)" }}
                            >
                              +
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {(categories ?? []).length > 0 ? (
                  <div className="mt-3">
                    <ThemedButton variant="secondary" onClick={openNewItemModal} className="w-full">
                      + New item
                    </ThemedButton>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {(suppliers ?? []).length > 0 ? (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => setLowStockSupplierId(null)}
                className="rounded-full border px-3 py-1.5 font-semibold"
                style={
                  lowStockSupplierId === null
                    ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                    : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
                }
              >
                All suppliers
              </button>
              {(suppliers ?? []).map((supplier) => (
                <button
                  key={supplier.id}
                  onClick={() => setLowStockSupplierId(supplier.id)}
                  className="rounded-full border px-3 py-1.5 font-semibold"
                  style={
                    lowStockSupplierId === supplier.id
                      ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }
                      : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }
                  }
                >
                  {supplier.name}
                </button>
              ))}
            </div>
          ) : null}

          {lowStockItems.length > 0 ? (
            <div className="mb-3">
              <ThemedButton onClick={handleGenerateShoppingList} disabled={generatingList} style={{ paddingBlock: 10, paddingInline: 16 }}>
                {generatingList
                  ? "Generating..."
                  : lowStockSupplierId
                    ? `Generate Shopping List - ${supplierById.get(lowStockSupplierId)?.name ?? ""}`
                    : "Generate Shopping List"}
              </ThemedButton>
              {shoppingListError ? (
                <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
                  {shoppingListError}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
            {lowStockItems.length === 0 ? (
              <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                {lowStockSupplierId ? "Nothing low on stock from this supplier." : "Nothing is low on stock right now."}
              </p>
            ) : (
              <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
                <tbody>
                  {lowStockItems.map((item) => (
                    <tr key={item.inventory_level_id} className="last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                      <td className="px-4 py-3">
                        <p className="font-semibold" style={{ color: "var(--jms-text)" }}>
                          {item.item_name}
                        </p>
                        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                          {item.location_name}
                          {item.category_name ? ` · ${item.category_name}` : ""}
                          {item.subcategory_name ? ` · ${item.subcategory_name}` : ""}
                          {item.supplier_name ? ` · ${item.supplier_name}` : ""}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className="inline-block rounded-full border px-2 py-0.5 font-bold"
                          style={{
                            borderColor: item.quantity === 0 ? "var(--jms-danger)" : "var(--jms-warning)",
                            color: item.quantity === 0 ? "var(--jms-danger)" : "var(--jms-warning)",
                            fontSize: "var(--jms-font-label)",
                          }}
                        >
                          {item.quantity} / {item.reorder_threshold}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      <ThemedModal open={locationModalOpen} onClose={() => setLocationModalOpen(false)} title="New location">
        <ThemedFormField label="Name" value={newLocationName} onChange={(e) => setNewLocationName(e.target.value)} placeholder='e.g. "Ute 1" or "Main Warehouse"' />
        <ThemedFormField label="Type (optional)" value={newLocationType} onChange={(e) => setNewLocationType(e.target.value)} placeholder="e.g. vehicle, warehouse, shelf" />
        {locationError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {locationError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setLocationModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => createLocation.mutate()} disabled={createLocation.isPending}>
            {createLocation.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal open={itemModalOpen} onClose={() => setItemModalOpen(false)} title={editingItem ? "Edit item" : "New item"}>
        <ThemedFormField label="Name" value={newItemName} onChange={(e) => setNewItemName(e.target.value)} placeholder='e.g. "Silicone tube - clear"' />
        <ThemedSelectField
          label="Category"
          value={newItemCategoryId}
          onChange={(v) => {
            setNewItemCategoryId(v);
            setNewItemSubcategoryId("");
          }}
          options={(categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
          placeholder="Select a category"
        />
        {newItemSubcategoryOptions.length > 0 ? (
          <ThemedSelectField
            label="Subcategory (optional)"
            value={newItemSubcategoryId}
            onChange={setNewItemSubcategoryId}
            options={newItemSubcategoryOptions.map((s) => ({ value: s.id, label: s.name }))}
          />
        ) : null}
        <ThemedSelectField
          label="Supplier (optional)"
          value={newItemSupplierId}
          onChange={setNewItemSupplierId}
          options={(suppliers ?? []).map((s) => ({ value: s.id, label: s.name }))}
        />
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField
            label="Reorder threshold"
            type="number"
            value={newItemReorderThreshold}
            onChange={(e) => setNewItemReorderThreshold(e.target.value)}
            placeholder="5"
          />
          <ThemedFormField
            label="Ideal stock"
            type="number"
            value={newItemIdealStock}
            onChange={(e) => setNewItemIdealStock(e.target.value)}
            placeholder="10"
          />
        </div>
        <p className="mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Reorder threshold is when this item shows up in Out of Stock / Need to Order. Ideal stock is what a reorder
          should bring a location back up to.
        </p>
        {itemError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {itemError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setItemModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveItem.mutate()} disabled={saveItem.isPending}>
            {saveItem.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}

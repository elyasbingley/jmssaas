import { useEffect, useState } from "react";
import { Alert, FlatList, Image, ImageBackground, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import * as ImagePicker from "expo-image-picker";
import { decode as decodeBase64 } from "base64-arraybuffer";
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
import { useAuth } from "../../../../lib/auth-context";
import { useSupabaseFetch } from "../../../../lib/use-supabase-fetch";
import { supabase } from "../../../../lib/supabase";
import { buildShoppingListPdfHtml } from "../../../../lib/pdf";
import { exportPdf } from "../../../../lib/print";
import { getErrorMessage } from "../../../../lib/errors";
import { CenteredModal } from "../../../../components/CenteredModal";
import { FormField } from "../../../../components/FormField";
import { PickerModal } from "../../../../components/PickerModal";

const INVENTORY_IMAGE_BUCKET = "inventory-images";

// Multi-location stock tracking over inventory's own standalone catalogue
// (inventory_items, organised by inventory_categories/inventory_
// subcategories - see the inventory_material_categories migration; this
// used to be layered on the price book catalogue, which turned out to be
// the wrong fit - quote/invoice pricing items and physical materials/tools
// aren't the same thing). Browsing drills down Location > Category >
// Subcategory as filter chips on this one screen (matching the Jobs list's
// category/stage filter chip pattern) rather than separate routes per
// level. Everyone reads/writes quantities (small crew, same shape as
// clients/job_cards); creating a *location* or a new *item* is admin-gated
// - category/subcategory management itself lives in inventory-setup.tsx.
export default function InventoryScreen() {
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  const { data: locations } = useQuery<InventoryLocation>("SELECT * FROM inventory_locations ORDER BY name");
  const { data: levels } = useQuery<InventoryLevel>("SELECT * FROM inventory_levels");
  const { data: items } = useQuery<InventoryItem>("SELECT * FROM inventory_items ORDER BY name");
  const { data: categories } = useQuery<InventoryCategory>(
    "SELECT * FROM inventory_categories ORDER BY sort_order, name"
  );
  const { data: subcategories } = useQuery<InventorySubcategory>(
    "SELECT * FROM inventory_subcategories ORDER BY sort_order, name"
  );
  const { data: suppliers } = useQuery<InventorySupplier>("SELECT * FROM inventory_suppliers ORDER BY name");

  const { data: tenant } = useSupabaseFetch<Tenant>(async () => {
    const { data, error } = await supabase.from("tenants").select("*").eq("id", profile?.tenant_id).single();
    if (error) throw error;
    return data as Tenant;
  }, [profile?.tenant_id]);

  const [activeTab, setActiveTab] = useState<"stock" | "low-stock">("stock");
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [locationPickerVisible, setLocationPickerVisible] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [selectedSubcategoryId, setSelectedSubcategoryId] = useState<string | null>(null);
  // Low-Stock queue's own filter - independent of the Stock tab's
  // location/category/subcategory selection above, since Low Stock is
  // deliberately cross-location (see the tab's own filter row).
  const [lowStockSupplierId, setLowStockSupplierId] = useState<string | null>(null);

  // Default to the first location once locations have loaded - can't pick
  // one up front since this is a live PowerSync query, empty on first render.
  useEffect(() => {
    if (!selectedLocationId && locations.length > 0) {
      setSelectedLocationId(locations[0].id);
    }
  }, [locations, selectedLocationId]);

  // Dropping the subcategory filter whenever the category filter changes -
  // a subcategory selected under a previous category would otherwise stay
  // selected while showing a different category's items.
  useEffect(() => {
    setSelectedSubcategoryId(null);
  }, [selectedCategoryId]);

  const levelByKey = new Map(levels.map((level) => [`${level.location_id}:${level.item_id}`, level]));
  const itemById = new Map(items.map((item) => [item.id, item]));
  const locationById = new Map(locations.map((loc) => [loc.id, loc]));
  const selectedLocation = selectedLocationId ? (locationById.get(selectedLocationId) ?? null) : null;
  const categoryById = new Map(categories.map((cat) => [cat.id, cat]));
  const subcategoryById = new Map(subcategories.map((sub) => [sub.id, sub]));
  const supplierById = new Map(suppliers.map((sup) => [sup.id, sup]));

  const subcategoriesForSelectedCategory = selectedCategoryId
    ? subcategories.filter((s) => s.category_id === selectedCategoryId)
    : [];

  const visibleItems = items.filter((item) => {
    if (selectedCategoryId && item.category_id !== selectedCategoryId) return false;
    if (selectedSubcategoryId && item.subcategory_id !== selectedSubcategoryId) return false;
    return true;
  });

  const allLowStockItems: LowStockItem[] = levels
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

  // "All low stock" vs. "just what I'd order from Bunnings" - the supplier
  // filter chips below drive this, and both the on-screen list and the
  // Generate Shopping List button use this filtered set (see
  // handleGenerateShoppingList), so a supplier-scoped PDF is just "whatever
  // you're currently looking at".
  const lowStockItems = lowStockSupplierId
    ? allLowStockItems.filter((item) => item.supplier_id === lowStockSupplierId)
    : allLowStockItems;

  const handleAdjust = async (item: InventoryItem, delta: number) => {
    if (!selectedLocationId || !profile) return;
    const existing = levelByKey.get(`${selectedLocationId}:${item.id}`);
    const now = new Date().toISOString();
    if (existing) {
      const nextQuantity = Math.max(0, existing.quantity + delta);
      await powersync.execute("UPDATE inventory_levels SET quantity = ?, updated_at = ? WHERE id = ?", [
        nextQuantity,
        now,
        existing.id,
      ]);
    } else if (delta > 0) {
      await powersync.execute(
        `INSERT INTO inventory_levels (id, tenant_id, location_id, item_id, quantity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), profile.tenant_id, selectedLocationId, item.id, 1, now, now]
      );
    }
  };

  const [locationModalVisible, setLocationModalVisible] = useState(false);
  const [newLocationName, setNewLocationName] = useState("");
  const [newLocationType, setNewLocationType] = useState("");
  const [locationError, setLocationError] = useState<string | null>(null);

  const handleCreateLocation = async () => {
    const result = createInventoryLocationSchema.safeParse({ name: newLocationName, type: newLocationType || undefined });
    if (!result.success) {
      setLocationError(result.error.issues[0]?.message ?? "Invalid location");
      return;
    }
    if (!profile) return;
    const now = new Date().toISOString();
    const id = uuidv4();
    await powersync.execute(
      "INSERT INTO inventory_locations (id, tenant_id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, profile.tenant_id, result.data.name, result.data.type || null, now, now]
    );
    setSelectedLocationId(id);
    setNewLocationName("");
    setNewLocationType("");
    setLocationError(null);
    setLocationModalVisible(false);
  };

  // --- New/edit item (admin-only, catalogue entry - category/subcategory/
  // supplier themselves are managed in inventory-setup.tsx, not here).
  // Reused for both create and edit, same pattern as inventory-setup.tsx's
  // category/subcategory modals - editingItem set means "editing", null
  // means "creating". ---
  const [itemModalVisible, setItemModalVisible] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [newItemName, setNewItemName] = useState("");
  const [newItemCategory, setNewItemCategory] = useState<InventoryCategory | null>(null);
  const [newItemSubcategory, setNewItemSubcategory] = useState<InventorySubcategory | null>(null);
  const [newItemSupplier, setNewItemSupplier] = useState<InventorySupplier | null>(null);
  const [newItemReorderThreshold, setNewItemReorderThreshold] = useState("5");
  const [newItemIdealStock, setNewItemIdealStock] = useState("10");
  const [itemCategoryPickerVisible, setItemCategoryPickerVisible] = useState(false);
  const [itemSubcategoryPickerVisible, setItemSubcategoryPickerVisible] = useState(false);
  const [itemSupplierPickerVisible, setItemSupplierPickerVisible] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);

  // Tile image - deferred upload (only actually uploaded when Save is
  // pressed, same as desktop's price book category/item modals) rather
  // than uploading the moment a photo is picked, so cancelling the modal
  // never leaves an orphaned upload behind. `newItemImageAsset` is only
  // set when the admin picks a NEW photo this session; with nothing
  // picked, `editingItem?.image_url` (if any) is left untouched on save.
  const [newItemImageAsset, setNewItemImageAsset] = useState<{ uri: string; base64: string; mimeType: string } | null>(null);
  const [newItemImageRemoved, setNewItemImageRemoved] = useState(false);

  const openNewItemModal = () => {
    setEditingItem(null);
    setNewItemName("");
    setNewItemCategory(selectedCategoryId ? (categoryById.get(selectedCategoryId) ?? null) : null);
    setNewItemSubcategory(selectedSubcategoryId ? (subcategoryById.get(selectedSubcategoryId) ?? null) : null);
    setNewItemSupplier(null);
    setNewItemReorderThreshold("5");
    setNewItemIdealStock("10");
    setNewItemImageAsset(null);
    setNewItemImageRemoved(false);
    setItemError(null);
    setItemModalVisible(true);
  };

  const openEditItemModal = (item: InventoryItem) => {
    setEditingItem(item);
    setNewItemName(item.name);
    setNewItemCategory(categoryById.get(item.category_id) ?? null);
    setNewItemSubcategory(item.subcategory_id ? (subcategoryById.get(item.subcategory_id) ?? null) : null);
    setNewItemSupplier(item.supplier_id ? (supplierById.get(item.supplier_id) ?? null) : null);
    setNewItemReorderThreshold(String(item.reorder_threshold));
    setNewItemIdealStock(String(item.ideal_stock));
    setNewItemImageAsset(null);
    setNewItemImageRemoved(false);
    setItemError(null);
    setItemModalVisible(true);
  };

  const pickItemImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Enable photo access in Settings to attach a photo.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.7, allowsEditing: true });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset?.base64) return;
    setNewItemImageAsset({ uri: asset.uri, base64: asset.base64, mimeType: asset.mimeType ?? "image/jpeg" });
    setNewItemImageRemoved(false);
  };

  const newItemSubcategoryOptions = newItemCategory
    ? subcategories.filter((s) => s.category_id === newItemCategory.id)
    : [];

  const [savingItem, setSavingItem] = useState(false);

  const handleSaveItem = async () => {
    const result = createInventoryItemSchema.safeParse({
      name: newItemName,
      category_id: newItemCategory?.id,
      subcategory_id: newItemSubcategory?.id,
      supplier_id: newItemSupplier?.id,
      reorder_threshold: Number(newItemReorderThreshold),
      ideal_stock: Number(newItemIdealStock),
    });
    if (!result.success) {
      setItemError(newItemCategory ? (result.error.issues[0]?.message ?? "Invalid item") : "Pick a category first");
      return;
    }
    if (!profile) return;

    setSavingItem(true);
    setItemError(null);
    try {
      let imageUrl: string | null = newItemImageRemoved ? null : (editingItem?.image_url ?? null);
      if (newItemImageAsset) {
        const extension = newItemImageAsset.mimeType.includes("png") ? "png" : "jpg";
        const path = `${profile.tenant_id}/item-${Date.now()}.${extension}`;
        const { error: uploadError } = await supabase.storage
          .from(INVENTORY_IMAGE_BUCKET)
          .upload(path, decodeBase64(newItemImageAsset.base64), { contentType: newItemImageAsset.mimeType, upsert: true });
        if (uploadError) throw uploadError;
        imageUrl = supabase.storage.from(INVENTORY_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
      }

      const now = new Date().toISOString();
      if (editingItem) {
        await powersync.execute(
          `UPDATE inventory_items
           SET category_id = ?, subcategory_id = ?, supplier_id = ?, name = ?, reorder_threshold = ?, ideal_stock = ?, image_url = ?, updated_at = ?
           WHERE id = ?`,
          [
            result.data.category_id,
            result.data.subcategory_id ?? null,
            result.data.supplier_id ?? null,
            result.data.name,
            result.data.reorder_threshold,
            result.data.ideal_stock,
            imageUrl,
            now,
            editingItem.id,
          ]
        );
      } else {
        await powersync.execute(
          `INSERT INTO inventory_items (id, tenant_id, category_id, subcategory_id, supplier_id, name, reorder_threshold, ideal_stock, image_url, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            profile.tenant_id,
            result.data.category_id,
            result.data.subcategory_id ?? null,
            result.data.supplier_id ?? null,
            result.data.name,
            result.data.reorder_threshold,
            result.data.ideal_stock,
            imageUrl,
            now,
            now,
          ]
        );
      }
      setItemModalVisible(false);
    } catch (e) {
      console.error("[Inventory] Failed to save item", e);
      setItemError(getErrorMessage(e, "Failed to save item"));
    } finally {
      setSavingItem(false);
    }
  };

  const [generatingList, setGeneratingList] = useState(false);
  const [shoppingListError, setShoppingListError] = useState<string | null>(null);

  const handleGenerateShoppingList = async () => {
    if (!tenant) return;
    setGeneratingList(true);
    setShoppingListError(null);
    try {
      const html = buildShoppingListPdfHtml({ tenant, items: lowStockItems });
      await exportPdf(html, "Shopping List");
    } catch (e) {
      console.error("[Inventory] Failed to generate shopping list", e);
      setShoppingListError(getErrorMessage(e, "Failed to generate PDF (see console for details)"));
    } finally {
      setGeneratingList(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Inventory</Text>
        {activeTab === "stock" && locations.length > 0 ? (
          <View style={styles.headerLocationRow}>
            <Pressable style={styles.locationButton} onPress={() => setLocationPickerVisible(true)}>
              <Text style={styles.locationButtonText} numberOfLines={1}>
                📍 {selectedLocation?.name ?? "Select location"}
              </Text>
            </Pressable>
            {isAdmin ? (
              <Pressable style={styles.addLocationButton} onPress={() => setLocationModalVisible(true)}>
                <Text style={styles.addLocationButtonText}>+</Text>
              </Pressable>
            ) : null}
          </View>
        ) : activeTab === "stock" && isAdmin ? (
          <Pressable style={styles.addLocationButton} onPress={() => setLocationModalVisible(true)}>
            <Text style={styles.addLocationButtonText}>+</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.tabRow}>
        <Pressable
          style={[styles.tabButton, activeTab === "stock" && styles.tabButtonActive]}
          onPress={() => setActiveTab("stock")}
        >
          <Text style={[styles.tabButtonText, activeTab === "stock" && styles.tabButtonTextActive]}>Stock</Text>
        </Pressable>
        <Pressable
          style={[styles.tabButton, activeTab === "low-stock" && styles.tabButtonActive]}
          onPress={() => setActiveTab("low-stock")}
        >
          <View style={styles.tabButtonRow}>
            <Text style={[styles.tabButtonText, activeTab === "low-stock" && styles.tabButtonTextActive]}>
              Low Stock
            </Text>
            {allLowStockItems.length > 0 ? (
              <View style={styles.tabBadge}>
                <Text style={styles.tabBadgeText}>{allLowStockItems.length}</Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      </View>

      {activeTab === "stock" ? (
        <>
          {locations.length === 0 ? (
            <Text style={styles.empty}>
              {isAdmin ? "Add a location (e.g. \"Ute 1\") to start tracking stock." : "No locations yet - ask an admin to add one."}
            </Text>
          ) : (
            <>
              <View style={styles.categoryRow}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow} style={styles.categoryScroll}>
                  <Pressable
                    style={[styles.chip, selectedCategoryId === null && styles.chipActive]}
                    onPress={() => setSelectedCategoryId(null)}
                  >
                    <Text style={[styles.chipText, selectedCategoryId === null && styles.chipTextActive]}>All</Text>
                  </Pressable>
                  {categories.map((category) => (
                    <Pressable
                      key={category.id}
                      style={[styles.chip, selectedCategoryId === category.id && styles.chipActive]}
                      onPress={() => setSelectedCategoryId(category.id)}
                    >
                      <Text style={[styles.chipText, selectedCategoryId === category.id && styles.chipTextActive]}>
                        {category.name}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
                {isAdmin ? (
                  <Pressable style={styles.manageButton} onPress={() => router.push("/inventory-setup")}>
                    <Text style={styles.manageButtonText}>⚙</Text>
                  </Pressable>
                ) : null}
              </View>

              {categories.length === 0 ? (
                <Text style={styles.empty}>
                  {isAdmin
                    ? "No categories yet - tap ⚙ above to set up Material, Tools, etc. before adding items."
                    : "No categories yet - ask an admin to set some up."}
                </Text>
              ) : null}

              {subcategoriesForSelectedCategory.length > 0 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.subcategoryScroll} contentContainerStyle={styles.chipRow}>
                  <Pressable
                    style={[styles.subChip, selectedSubcategoryId === null && styles.chipActive]}
                    onPress={() => setSelectedSubcategoryId(null)}
                  >
                    <Text style={[styles.chipText, selectedSubcategoryId === null && styles.chipTextActive]}>All</Text>
                  </Pressable>
                  {subcategoriesForSelectedCategory.map((subcategory) => (
                    <Pressable
                      key={subcategory.id}
                      style={[styles.subChip, selectedSubcategoryId === subcategory.id && styles.chipActive]}
                      onPress={() => setSelectedSubcategoryId(subcategory.id)}
                    >
                      <Text
                        style={[styles.chipText, selectedSubcategoryId === subcategory.id && styles.chipTextActive]}
                      >
                        {subcategory.name}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : null}

              <FlatList
                data={visibleItems}
                keyExtractor={(item) => item.id}
                numColumns={2}
                columnWrapperStyle={styles.tileRow}
                contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
                renderItem={({ item }) => {
                  const level = selectedLocationId ? levelByKey.get(`${selectedLocationId}:${item.id}`) : undefined;
                  const quantity = level?.quantity ?? 0;
                  const isLow = level ? level.quantity <= item.reorder_threshold : false;
                  const supplier = item.supplier_id ? supplierById.get(item.supplier_id) : undefined;
                  return (
                    <View style={styles.tile}>
                      <Pressable
                        style={styles.tileTouchable}
                        onPress={isAdmin ? () => openEditItemModal(item) : undefined}
                        disabled={!isAdmin}
                      >
                        {item.image_url ? (
                          <ImageBackground source={{ uri: item.image_url }} style={styles.tileImageBg}>
                            <View style={styles.tileImageOverlay}>
                              <Text style={styles.tileImageLabel} numberOfLines={2}>
                                {item.name}
                              </Text>
                              {supplier ? <Text style={styles.tileImageMeta}>{supplier.name}</Text> : null}
                            </View>
                          </ImageBackground>
                        ) : (
                          <View style={styles.tilePlain}>
                            <Text style={styles.tileEmoji}>📦</Text>
                            <Text style={styles.tileLabel} numberOfLines={2}>
                              {item.name}
                            </Text>
                            {supplier ? <Text style={styles.itemMeta}>{supplier.name}</Text> : null}
                          </View>
                        )}
                        {isLow ? (
                          <View style={[styles.stockBadge, styles.tileStockBadge, quantity === 0 && styles.stockBadgeOut]}>
                            <Text style={[styles.stockBadgeText, quantity === 0 && styles.stockBadgeTextOut]}>
                              {quantity === 0 ? "Out of stock" : "Low stock"}
                            </Text>
                          </View>
                        ) : null}
                      </Pressable>
                      <View style={styles.qtyControls}>
                        <Pressable
                          style={styles.qtyButton}
                          onPress={() => handleAdjust(item, -1)}
                          disabled={!selectedLocationId || quantity === 0}
                        >
                          <Text style={styles.qtyButtonText}>-</Text>
                        </Pressable>
                        <Text style={styles.qtyValue}>{quantity}</Text>
                        <Pressable style={styles.qtyButton} onPress={() => handleAdjust(item, 1)} disabled={!selectedLocationId}>
                          <Text style={styles.qtyButtonText}>+</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                }}
                ListEmptyComponent={<Text style={styles.empty}>No items here yet.</Text>}
                ListFooterComponent={
                  isAdmin && categories.length > 0 ? (
                    <Pressable style={styles.newItemButton} onPress={openNewItemModal}>
                      <Text style={styles.newItemButtonText}>+ New item</Text>
                    </Pressable>
                  ) : null
                }
              />
            </>
          )}
        </>
      ) : (
        <>
          {suppliers.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              <Pressable
                style={[styles.chip, lowStockSupplierId === null && styles.chipActive]}
                onPress={() => setLowStockSupplierId(null)}
              >
                <Text style={[styles.chipText, lowStockSupplierId === null && styles.chipTextActive]}>
                  All suppliers
                </Text>
              </Pressable>
              {suppliers.map((supplier) => (
                <Pressable
                  key={supplier.id}
                  style={[styles.chip, lowStockSupplierId === supplier.id && styles.chipActive]}
                  onPress={() => setLowStockSupplierId(supplier.id)}
                >
                  <Text style={[styles.chipText, lowStockSupplierId === supplier.id && styles.chipTextActive]}>
                    {supplier.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}

          <FlatList
            data={lowStockItems}
            keyExtractor={(item) => item.inventory_level_id}
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            ListHeaderComponent={
              lowStockItems.length > 0 ? (
                <>
                  <Pressable style={styles.shoppingListButton} onPress={handleGenerateShoppingList} disabled={generatingList}>
                    <Text style={styles.shoppingListButtonText}>
                      {generatingList
                        ? "Generating..."
                        : lowStockSupplierId
                          ? `Generate Shopping List - ${supplierById.get(lowStockSupplierId)?.name ?? ""}`
                          : "Generate Shopping List"}
                    </Text>
                  </Pressable>
                  {shoppingListError ? <Text style={styles.error}>{shoppingListError}</Text> : null}
                </>
              ) : null
            }
            renderItem={({ item }) => (
              <View style={styles.lowStockRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName}>{item.item_name}</Text>
                  <Text style={styles.lowStockMeta}>
                    {item.location_name}
                    {item.category_name ? ` · ${item.category_name}` : ""}
                    {item.subcategory_name ? ` · ${item.subcategory_name}` : ""}
                    {item.supplier_name ? ` · ${item.supplier_name}` : ""}
                  </Text>
                </View>
                <View style={[styles.stockBadge, item.quantity === 0 && styles.stockBadgeOut]}>
                  <Text style={[styles.stockBadgeText, item.quantity === 0 && styles.stockBadgeTextOut]}>
                    {item.quantity} / {item.reorder_threshold}
                  </Text>
                </View>
              </View>
            )}
            ListEmptyComponent={
              <Text style={styles.empty}>
                {lowStockSupplierId ? "Nothing low on stock from this supplier." : "Nothing is low on stock right now."}
              </Text>
            }
          />
        </>
      )}

      <CenteredModal
        visible={locationModalVisible}
        onClose={() => {
          setLocationModalVisible(false);
          setLocationError(null);
        }}
      >
        <Text style={styles.modalTitle}>New location</Text>
        <FormField label="Name" placeholder='e.g. "Ute 1" or "Main Warehouse"' value={newLocationName} onChangeText={setNewLocationName} />
        <View style={styles.fieldSpacing}>
          <FormField
            label="Type (optional)"
            placeholder="e.g. vehicle, warehouse, shelf"
            value={newLocationType}
            onChangeText={setNewLocationType}
          />
        </View>
        {locationError ? <Text style={styles.error}>{locationError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable
            onPress={() => {
              setLocationModalVisible(false);
              setLocationError(null);
            }}
          >
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleCreateLocation}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <CenteredModal visible={itemModalVisible} onClose={() => setItemModalVisible(false)}>
        <Text style={styles.modalTitle}>{editingItem ? "Edit item" : "New item"}</Text>

        {newItemImageAsset ? (
          <Image source={{ uri: newItemImageAsset.uri }} style={styles.itemImagePreview} />
        ) : editingItem?.image_url && !newItemImageRemoved ? (
          <Image source={{ uri: editingItem.image_url }} style={styles.itemImagePreview} />
        ) : (
          <View style={[styles.itemImagePreview, styles.itemImagePreviewEmpty]}>
            <Text style={styles.itemImagePreviewEmptyText}>No photo</Text>
          </View>
        )}
        <View style={styles.itemImageActions}>
          <Pressable onPress={pickItemImage}>
            <Text style={styles.link}>{editingItem?.image_url || newItemImageAsset ? "Change photo" : "+ Add photo"}</Text>
          </Pressable>
          {(newItemImageAsset || (editingItem?.image_url && !newItemImageRemoved)) ? (
            <Pressable
              onPress={() => {
                setNewItemImageAsset(null);
                setNewItemImageRemoved(true);
              }}
            >
              <Text style={styles.removeLink}>Remove</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.fieldSpacing}>
          <FormField label="Name" placeholder='e.g. "Silicone tube - clear"' value={newItemName} onChangeText={setNewItemName} />
        </View>

        <View style={styles.fieldSpacing}>
          <Pressable style={styles.pickerField} onPress={() => setItemCategoryPickerVisible(true)}>
            <Text style={styles.pickerFieldLabel}>Category</Text>
            <Text style={newItemCategory ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
              {newItemCategory?.name ?? "Select a category"}
            </Text>
          </Pressable>
        </View>

        {newItemSubcategoryOptions.length > 0 ? (
          <View style={styles.fieldSpacing}>
            <Pressable style={styles.pickerField} onPress={() => setItemSubcategoryPickerVisible(true)}>
              <Text style={styles.pickerFieldLabel}>Subcategory (optional)</Text>
              <Text style={newItemSubcategory ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
                {newItemSubcategory?.name ?? "None"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.fieldSpacing}>
          <Pressable style={styles.pickerField} onPress={() => setItemSupplierPickerVisible(true)}>
            <Text style={styles.pickerFieldLabel}>Supplier (optional)</Text>
            <Text style={newItemSupplier ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
              {newItemSupplier?.name ?? "None"}
            </Text>
          </Pressable>
        </View>

        <View style={styles.targetFieldRow}>
          <View style={styles.targetField}>
            <FormField
              label="Reorder threshold"
              placeholder="5"
              value={newItemReorderThreshold}
              onChangeText={setNewItemReorderThreshold}
              keyboardType="number-pad"
            />
          </View>
          <View style={styles.targetField}>
            <FormField
              label="Ideal stock"
              placeholder="10"
              value={newItemIdealStock}
              onChangeText={setNewItemIdealStock}
              keyboardType="number-pad"
            />
          </View>
        </View>
        <Text style={styles.helperText}>
          Reorder threshold is when this item shows up in Out of Stock / Need to Order. Ideal stock is what a reorder
          should bring a location back up to.
        </Text>

        {itemError ? <Text style={styles.error}>{itemError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setItemModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleSaveItem} disabled={savingItem}>
            <Text style={styles.buttonText}>{savingItem ? "Saving..." : "Save"}</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <PickerModal
        visible={locationPickerVisible}
        title="Select location"
        items={locations}
        getKey={(l) => l.id}
        getLabel={(l) => l.name}
        onSelect={(location) => setSelectedLocationId(location.id)}
        onClose={() => setLocationPickerVisible(false)}
      />

      <PickerModal
        visible={itemCategoryPickerVisible}
        title="Select category"
        items={categories}
        getKey={(c) => c.id}
        getLabel={(c) => c.name}
        onSelect={(category) => {
          setNewItemCategory(category);
          setNewItemSubcategory(null);
        }}
        onClose={() => setItemCategoryPickerVisible(false)}
      />

      <PickerModal
        visible={itemSubcategoryPickerVisible}
        title="Select subcategory"
        items={newItemSubcategoryOptions}
        getKey={(s) => s.id}
        getLabel={(s) => s.name}
        onSelect={setNewItemSubcategory}
        onClose={() => setItemSubcategoryPickerVisible(false)}
      />

      <PickerModal
        visible={itemSupplierPickerVisible}
        title="Select supplier"
        items={suppliers}
        getKey={(s) => s.id}
        getLabel={(s) => s.name}
        onSelect={setNewItemSupplier}
        onClose={() => setItemSupplierPickerVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  title: { fontSize: 20, fontWeight: "700" },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    // SafeAreaView (edges=["top"]) already clears the status bar/notch -
    // this is just breathing room below that, not a substitute for it
    // (a flat paddingTop here previously stood in for the safe-area inset
    // entirely, which is wrong on any device with a taller status bar/
    // notch than whatever px value was guessed).
    paddingTop: 12,
    paddingBottom: 12,
    gap: 12,
  },
  headerLocationRow: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  locationButton: {
    backgroundColor: "#eef2ff",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    maxWidth: 170,
  },
  locationButtonText: { color: "#1d4ed8", fontWeight: "700", fontSize: 13 },
  addLocationButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#1d4ed8",
    alignItems: "center",
    justifyContent: "center",
  },
  addLocationButtonText: { color: "#fff", fontWeight: "800", fontSize: 16, lineHeight: 18 },
  tabRow: { flexDirection: "row", paddingHorizontal: 16, gap: 8 },
  tabButton: { flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: "#f3f4f6", alignItems: "center" },
  tabButtonActive: { backgroundColor: "#1d4ed8" },
  tabButtonRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  tabButtonText: { color: "#374151", fontWeight: "700", fontSize: 13 },
  tabButtonTextActive: { color: "#fff" },
  tabBadge: { backgroundColor: "#dc2626", borderRadius: 10, paddingHorizontal: 6, minWidth: 18, alignItems: "center" },
  tabBadgeText: { color: "#fff", fontWeight: "700", fontSize: 11 },
  chipRow: { paddingHorizontal: 16, paddingVertical: 10, gap: 8, alignItems: "center" },
  categoryRow: { flexDirection: "row", alignItems: "center" },
  categoryScroll: { flex: 1 },
  // The category row's own ScrollView got an explicit style (flexGrow via
  // categoryScroll's flex:1, needed to share the row with the pinned gear
  // button) and renders correctly; this row never got one - a horizontal
  // ScrollView with only contentContainerStyle set can size its own frame
  // wrong before content is measured, clipping the top of taller glyphs
  // (only visible on names with tall ascenders, e.g. "Roof"/"Blocking",
  // not short ones like "All"). An explicit style fixes it the same way.
  subcategoryScroll: { flexGrow: 0 },
  manageButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#f3f4f6",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 16,
  },
  manageButtonText: { fontSize: 15 },
  chip: { backgroundColor: "#f3f4f6", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  subChip: { backgroundColor: "#eef2ff", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: "#1d4ed8" },
  chipText: { color: "#374151", fontWeight: "600", fontSize: 13 },
  chipTextActive: { color: "#fff" },
  tileRow: { justifyContent: "space-between" },
  tile: { width: "48%", marginBottom: 12 },
  tileTouchable: {
    aspectRatio: 1.05,
    borderRadius: 16,
    overflow: "hidden",
  },
  tilePlain: {
    flex: 1,
    backgroundColor: "#f9fafb",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    padding: 10,
  },
  tileEmoji: { fontSize: 28 },
  tileLabel: { fontSize: 14, fontWeight: "700", color: "#111827", textAlign: "center" },
  tileImageBg: { flex: 1, justifyContent: "flex-end" },
  tileImageOverlay: { backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 6, gap: 2 },
  tileImageLabel: { fontSize: 14, fontWeight: "700", color: "#fff", textAlign: "center" },
  tileImageMeta: { fontSize: 11, color: "#e5e7eb", textAlign: "center" },
  tileStockBadge: { position: "absolute", top: 8, right: 8, marginTop: 0 },
  itemName: { fontSize: 15, fontWeight: "600", color: "#111827" },
  itemMeta: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  stockBadge: { alignSelf: "flex-start", backgroundColor: "#fef3c7", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, marginTop: 6 },
  stockBadgeOut: { backgroundColor: "#fee2e2" },
  stockBadgeText: { fontSize: 11, fontWeight: "700", color: "#92400e" },
  stockBadgeTextOut: { color: "#dc2626" },
  qtyControls: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 8 },
  qtyButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#1d4ed8",
    alignItems: "center",
    justifyContent: "center",
  },
  qtyButtonText: { color: "#fff", fontWeight: "800", fontSize: 18, lineHeight: 20 },
  qtyValue: { fontSize: 16, fontWeight: "700", color: "#111827", minWidth: 24, textAlign: "center" },
  newItemButton: { backgroundColor: "#f3f4f6", borderRadius: 8, padding: 12, alignItems: "center", marginTop: 4 },
  newItemButtonText: { color: "#1d4ed8", fontWeight: "700" },
  itemImagePreview: { width: "100%", height: 140, borderRadius: 12, backgroundColor: "#f3f4f6" },
  itemImagePreviewEmpty: { alignItems: "center", justifyContent: "center" },
  itemImagePreviewEmptyText: { color: "#9ca3af", fontSize: 13 },
  itemImageActions: { flexDirection: "row", gap: 20, marginTop: 8 },
  removeLink: { color: "#dc2626", fontWeight: "600" },
  lowStockRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
    gap: 8,
  },
  lowStockMeta: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  shoppingListButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginBottom: 16 },
  shoppingListButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  fieldSpacing: { marginTop: 16 },
  error: { color: "#dc2626", marginTop: 8 },
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, gap: 4 },
  pickerFieldLabel: { fontSize: 13, fontWeight: "600", color: "#374151" },
  pickerFieldText: { fontSize: 16, color: "#111827" },
  pickerFieldPlaceholder: { fontSize: 16, color: "#9ca3af" },
  targetFieldRow: { flexDirection: "row", gap: 12, marginTop: 16 },
  targetField: { flex: 1 },
  helperText: { color: "#9ca3af", fontSize: 12, marginTop: 6 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 16 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  link: { color: "#1d4ed8", fontWeight: "600" },
});

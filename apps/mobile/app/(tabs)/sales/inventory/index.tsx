import { useEffect, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  createInventoryLocationSchema,
  type InventoryLevel,
  type InventoryLocation,
  type LowStockItem,
  type PriceBookCategory,
  type PriceBookItem,
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

// Multi-location stock tracking, layered on the existing price book
// catalogue (inventory_levels.item_id points at a price_book_items row -
// see the inventory_stock_control migration) rather than a separate
// inventory item list. Everyone reads/writes quantities (small crew,
// same shape as clients/job_cards), only creating a *location* is
// admin-gated - see this screen's "+ New location" flow below.
export default function InventoryScreen() {
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  const { data: locations } = useQuery<InventoryLocation>("SELECT * FROM inventory_locations ORDER BY name");
  const { data: levels } = useQuery<InventoryLevel>("SELECT * FROM inventory_levels");
  const { data: items } = useQuery<PriceBookItem>("SELECT * FROM price_book_items ORDER BY description");
  const { data: categories } = useQuery<PriceBookCategory>(
    "SELECT * FROM price_book_categories ORDER BY sort_order, name"
  );

  const { data: tenant } = useSupabaseFetch<Tenant>(async () => {
    const { data, error } = await supabase.from("tenants").select("*").eq("id", profile?.tenant_id).single();
    if (error) throw error;
    return data as Tenant;
  }, [profile?.tenant_id]);

  const [activeTab, setActiveTab] = useState<"stock" | "low-stock">("stock");
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);

  // Default to the first location once locations have loaded - can't pick
  // one up front since this is a live PowerSync query, empty on first render.
  useEffect(() => {
    if (!selectedLocationId && locations.length > 0) {
      setSelectedLocationId(locations[0].id);
    }
  }, [locations, selectedLocationId]);

  const levelByKey = new Map(levels.map((level) => [`${level.location_id}:${level.item_id}`, level]));
  const itemById = new Map(items.map((item) => [item.id, item]));
  const locationById = new Map(locations.map((loc) => [loc.id, loc]));
  const categoryById = new Map(categories.map((cat) => [cat.id, cat]));

  const visibleItems = selectedCategoryId ? items.filter((item) => item.category_id === selectedCategoryId) : items;

  const lowStockItems: LowStockItem[] = levels
    .filter((level) => level.quantity <= level.reorder_threshold)
    .map((level) => {
      const item = itemById.get(level.item_id);
      const location = locationById.get(level.location_id);
      const category = item ? categoryById.get(item.category_id) : undefined;
      return {
        inventory_level_id: level.id,
        location_id: level.location_id,
        location_name: location?.name ?? "Unknown location",
        item_id: level.item_id,
        item_description: item?.description ?? "Unknown item",
        category_id: category?.id ?? null,
        category_name: category?.name ?? null,
        quantity: level.quantity,
        reorder_threshold: level.reorder_threshold,
      };
    })
    .sort((a, b) => a.quantity - b.quantity);

  const handleAdjust = async (item: PriceBookItem, delta: number) => {
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
        `INSERT INTO inventory_levels (id, tenant_id, location_id, item_id, quantity, reorder_threshold, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), profile.tenant_id, selectedLocationId, item.id, 1, 5, now, now]
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
    <View style={styles.container}>
      <Text style={styles.title}>Inventory</Text>

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
              Out of Stock / Need to Order
            </Text>
            {lowStockItems.length > 0 ? (
              <View style={styles.tabBadge}>
                <Text style={styles.tabBadgeText}>{lowStockItems.length}</Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      </View>

      {activeTab === "stock" ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {locations.map((location) => (
              <Pressable
                key={location.id}
                style={[styles.chip, selectedLocationId === location.id && styles.chipActive]}
                onPress={() => setSelectedLocationId(location.id)}
              >
                <Text style={[styles.chipText, selectedLocationId === location.id && styles.chipTextActive]}>
                  {location.name}
                </Text>
              </Pressable>
            ))}
            {isAdmin ? (
              <Pressable style={styles.chip} onPress={() => setLocationModalVisible(true)}>
                <Text style={styles.chipText}>+ New location</Text>
              </Pressable>
            ) : null}
          </ScrollView>
          {locations.length === 0 ? (
            <Text style={styles.empty}>
              {isAdmin ? "Add a location (e.g. \"Ute 1\") to start tracking stock." : "No locations yet - ask an admin to add one."}
            </Text>
          ) : (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
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

              <FlatList
                data={visibleItems}
                keyExtractor={(item) => item.id}
                contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
                renderItem={({ item }) => {
                  const level = selectedLocationId ? levelByKey.get(`${selectedLocationId}:${item.id}`) : undefined;
                  const quantity = level?.quantity ?? 0;
                  const isLow = level ? level.quantity <= level.reorder_threshold : false;
                  return (
                    <View style={styles.itemCard}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.itemName}>{item.description}</Text>
                        {isLow ? (
                          <View style={[styles.stockBadge, quantity === 0 && styles.stockBadgeOut]}>
                            <Text style={[styles.stockBadgeText, quantity === 0 && styles.stockBadgeTextOut]}>
                              {quantity === 0 ? "Out of stock" : "Low stock"}
                            </Text>
                          </View>
                        ) : null}
                      </View>
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
                ListEmptyComponent={<Text style={styles.empty}>No price book items yet.</Text>}
              />
            </>
          )}
        </>
      ) : (
        <FlatList
          data={lowStockItems}
          keyExtractor={(item) => item.inventory_level_id}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          ListHeaderComponent={
            lowStockItems.length > 0 ? (
              <>
                <Pressable style={styles.shoppingListButton} onPress={handleGenerateShoppingList} disabled={generatingList}>
                  <Text style={styles.shoppingListButtonText}>
                    {generatingList ? "Generating..." : "Generate Shopping List"}
                  </Text>
                </Pressable>
                {shoppingListError ? <Text style={styles.error}>{shoppingListError}</Text> : null}
              </>
            ) : null
          }
          renderItem={({ item }) => (
            <View style={styles.lowStockRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>{item.item_description}</Text>
                <Text style={styles.lowStockMeta}>
                  {item.location_name}
                  {item.category_name ? ` · ${item.category_name}` : ""}
                </Text>
              </View>
              <View style={[styles.stockBadge, item.quantity === 0 && styles.stockBadgeOut]}>
                <Text style={[styles.stockBadgeText, item.quantity === 0 && styles.stockBadgeTextOut]}>
                  {item.quantity} / {item.reorder_threshold}
                </Text>
              </View>
            </View>
          )}
          ListEmptyComponent={<Text style={styles.empty}>Nothing is low on stock right now.</Text>}
        />
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  title: { fontSize: 20, fontWeight: "700", padding: 20, paddingBottom: 8 },
  tabRow: { flexDirection: "row", paddingHorizontal: 16, gap: 8 },
  tabButton: { flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: "#f3f4f6", alignItems: "center" },
  tabButtonActive: { backgroundColor: "#1d4ed8" },
  tabButtonRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  tabButtonText: { color: "#374151", fontWeight: "700", fontSize: 13 },
  tabButtonTextActive: { color: "#fff" },
  tabBadge: { backgroundColor: "#dc2626", borderRadius: 10, paddingHorizontal: 6, minWidth: 18, alignItems: "center" },
  tabBadgeText: { color: "#fff", fontWeight: "700", fontSize: 11 },
  chipRow: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  chip: { backgroundColor: "#f3f4f6", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: "#1d4ed8" },
  chipText: { color: "#374151", fontWeight: "600", fontSize: 13 },
  chipTextActive: { color: "#fff" },
  itemCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    gap: 12,
  },
  itemName: { fontSize: 15, fontWeight: "600", color: "#111827" },
  stockBadge: { alignSelf: "flex-start", backgroundColor: "#fef3c7", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, marginTop: 6 },
  stockBadgeOut: { backgroundColor: "#fee2e2" },
  stockBadgeText: { fontSize: 11, fontWeight: "700", color: "#92400e" },
  stockBadgeTextOut: { color: "#dc2626" },
  qtyControls: { flexDirection: "row", alignItems: "center", gap: 10 },
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
  lowStockRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f0f0f0",
    gap: 8,
  },
  lowStockMeta: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  shoppingListButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginBottom: 16 },
  shoppingListButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  fieldSpacing: { marginTop: 16 },
  error: { color: "#dc2626", marginTop: 8 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 16 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  link: { color: "#1d4ed8", fontWeight: "600" },
});

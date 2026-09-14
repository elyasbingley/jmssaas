import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  createInventoryCategorySchema,
  createInventorySubcategorySchema,
  createInventorySupplierSchema,
  type InventoryCategory,
  type InventoryItem,
  type InventorySubcategory,
  type InventorySupplier,
} from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedFormField } from "../components/theme/ThemedFormField";
import { ThemedButton } from "../components/theme/ThemedButton";

// Reached via Settings > Inventory Setup, alongside Job Card Setup - same
// "occasional setup screen, not a daily tool" reasoning, and the same
// PowerSync-synced (offline-capable) shape as job-setup.tsx: reads via
// useQuery, writes via powersync.execute(), no connection gate.
//
// Manages the two-level category hierarchy (Material/Tools/First Aid
// Kit -> Roofing/Plumbing/Tapware, ...) and the flat supplier list
// (Bunnings, Reece, ...) - actual items ("Silicone tube - clear") are
// created inline from the main Inventory screen instead (a "+ New item"
// modal there, mirroring how Jobs creates a job inline while job-setup.tsx
// only manages categories/stages), so this screen stays scoped to setup
// data an item picks from, not items themselves.
export default function InventorySetupScreen() {
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

  const { data: categories } = useQuery<InventoryCategory>(
    "SELECT * FROM inventory_categories ORDER BY sort_order, name"
  );
  const { data: subcategories } = useQuery<InventorySubcategory>(
    "SELECT * FROM inventory_subcategories ORDER BY sort_order, name"
  );
  const { data: suppliers } = useQuery<InventorySupplier>("SELECT * FROM inventory_suppliers ORDER BY name");
  // Loaded only to show "this will also delete N items" counts in the
  // category delete confirmation below - not edited from this screen.
  const { data: items } = useQuery<InventoryItem>("SELECT * FROM inventory_items");

  const [categoryModalVisible, setCategoryModalVisible] = useState(false);
  const [editingCategory, setEditingCategory] = useState<InventoryCategory | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryColor, setCategoryColor] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const [subcategoryModalVisible, setSubcategoryModalVisible] = useState(false);
  const [editingSubcategory, setEditingSubcategory] = useState<InventorySubcategory | null>(null);
  const [subcategoryForCategoryId, setSubcategoryForCategoryId] = useState<string | null>(null);
  const [subcategoryName, setSubcategoryName] = useState("");
  const [subcategoryColor, setSubcategoryColor] = useState("");
  const [subcategoryError, setSubcategoryError] = useState<string | null>(null);

  const openNewCategory = () => {
    setEditingCategory(null);
    setCategoryName("");
    setCategoryColor("");
    setCategoryError(null);
    setCategoryModalVisible(true);
  };

  const openEditCategory = (category: InventoryCategory) => {
    setEditingCategory(category);
    setCategoryName(category.name);
    setCategoryColor(category.color ?? "");
    setCategoryError(null);
    setCategoryModalVisible(true);
  };

  const handleSaveCategory = async () => {
    const result = createInventoryCategorySchema.safeParse({
      name: categoryName,
      color: categoryColor || undefined,
      sort_order: editingCategory?.sort_order ?? categories.length,
    });
    if (!result.success) {
      setCategoryError(result.error.issues[0]?.message ?? "Invalid category");
      return;
    }
    if (!profile) return;

    const now = new Date().toISOString();
    if (editingCategory) {
      await powersync.execute(
        "UPDATE inventory_categories SET name = ?, color = ?, updated_at = ? WHERE id = ?",
        [result.data.name, result.data.color || null, now, editingCategory.id]
      );
    } else {
      await powersync.execute(
        "INSERT INTO inventory_categories (id, tenant_id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [uuidv4(), profile.tenant_id, result.data.name, result.data.color || null, result.data.sort_order, now, now]
      );
    }
    setCategoryModalVisible(false);
  };

  const handleDeleteCategory = (category: InventoryCategory) => {
    const subcategoryCount = subcategories.filter((s) => s.category_id === category.id).length;
    const itemCount = items.filter((i) => i.category_id === category.id).length;
    const consequences = [
      subcategoryCount > 0 ? `${subcategoryCount} subcategor${subcategoryCount === 1 ? "y" : "ies"}` : null,
      itemCount > 0 ? `${itemCount} item${itemCount === 1 ? "" : "s"} (and their stock records)` : null,
    ].filter(Boolean);
    const message =
      consequences.length > 0
        ? `Delete "${category.name}"? This will also delete ${consequences.join(" and ")}.`
        : `Delete "${category.name}"?`;
    Alert.alert("Delete category", message, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await powersync.execute("DELETE FROM inventory_categories WHERE id = ?", [category.id]);
        },
      },
    ]);
  };

  const openNewSubcategory = (categoryId: string) => {
    setEditingSubcategory(null);
    setSubcategoryForCategoryId(categoryId);
    setSubcategoryName("");
    setSubcategoryColor("");
    setSubcategoryError(null);
    setSubcategoryModalVisible(true);
  };

  const openEditSubcategory = (subcategory: InventorySubcategory) => {
    setEditingSubcategory(subcategory);
    setSubcategoryForCategoryId(subcategory.category_id);
    setSubcategoryName(subcategory.name);
    setSubcategoryColor(subcategory.color ?? "");
    setSubcategoryError(null);
    setSubcategoryModalVisible(true);
  };

  const handleSaveSubcategory = async () => {
    if (!subcategoryForCategoryId) return;
    const siblingCount = subcategories.filter((s) => s.category_id === subcategoryForCategoryId).length;
    const result = createInventorySubcategorySchema.safeParse({
      category_id: subcategoryForCategoryId,
      name: subcategoryName,
      color: subcategoryColor || undefined,
      sort_order: editingSubcategory?.sort_order ?? siblingCount,
    });
    if (!result.success) {
      setSubcategoryError(result.error.issues[0]?.message ?? "Invalid subcategory");
      return;
    }
    if (!profile) return;

    const now = new Date().toISOString();
    if (editingSubcategory) {
      await powersync.execute(
        "UPDATE inventory_subcategories SET name = ?, color = ?, updated_at = ? WHERE id = ?",
        [result.data.name, result.data.color || null, now, editingSubcategory.id]
      );
    } else {
      await powersync.execute(
        `INSERT INTO inventory_subcategories (id, tenant_id, category_id, name, color, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          profile.tenant_id,
          result.data.category_id,
          result.data.name,
          result.data.color || null,
          result.data.sort_order,
          now,
          now,
        ]
      );
    }
    setSubcategoryModalVisible(false);
  };

  const handleDeleteSubcategory = (subcategory: InventorySubcategory) => {
    const itemCount = items.filter((i) => i.subcategory_id === subcategory.id).length;
    const note = itemCount > 0 ? ` Items using it will just lose that tag, not be deleted.` : "";
    Alert.alert("Delete subcategory", `Delete "${subcategory.name}"?${note}`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await powersync.execute("DELETE FROM inventory_subcategories WHERE id = ?", [subcategory.id]);
        },
      },
    ]);
  };

  // --- Suppliers - flat list, no hierarchy, no color (just who an item
  // is sourced from) ---
  const [supplierModalVisible, setSupplierModalVisible] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<InventorySupplier | null>(null);
  const [supplierName, setSupplierName] = useState("");
  const [supplierError, setSupplierError] = useState<string | null>(null);

  const openNewSupplier = () => {
    setEditingSupplier(null);
    setSupplierName("");
    setSupplierError(null);
    setSupplierModalVisible(true);
  };

  const openEditSupplier = (supplier: InventorySupplier) => {
    setEditingSupplier(supplier);
    setSupplierName(supplier.name);
    setSupplierError(null);
    setSupplierModalVisible(true);
  };

  const handleSaveSupplier = async () => {
    const result = createInventorySupplierSchema.safeParse({ name: supplierName });
    if (!result.success) {
      setSupplierError(result.error.issues[0]?.message ?? "Invalid supplier");
      return;
    }
    if (!profile) return;

    const now = new Date().toISOString();
    if (editingSupplier) {
      await powersync.execute("UPDATE inventory_suppliers SET name = ?, updated_at = ? WHERE id = ?", [
        result.data.name,
        now,
        editingSupplier.id,
      ]);
    } else {
      await powersync.execute(
        "INSERT INTO inventory_suppliers (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [uuidv4(), profile.tenant_id, result.data.name, now, now]
      );
    }
    setSupplierModalVisible(false);
  };

  const handleDeleteSupplier = (supplier: InventorySupplier) => {
    const itemCount = items.filter((i) => i.supplier_id === supplier.id).length;
    const note = itemCount > 0 ? ` Items using it will just lose that tag, not be deleted.` : "";
    Alert.alert("Delete supplier", `Delete "${supplier.name}"?${note}`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await powersync.execute("DELETE FROM inventory_suppliers WHERE id = ?", [supplier.id]);
        },
      },
    ]);
  };

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Inventory Setup</Text>
        </View>

        {!isAdmin ? (
          <Text style={styles.empty}>Only admins can manage inventory setup.</Text>
        ) : (
          <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
            <Text style={styles.sectionTitle}>Categories</Text>
            <Text style={styles.subtitle}>
              "Material" and "Tools" as top-level categories, with "Roofing" or "Power Tools" as subcategories underneath.
            </Text>

            {categories.map((category) => {
              const categorySubcategories = subcategories.filter((s) => s.category_id === category.id);
              return (
                <View key={category.id} style={styles.categoryBlock}>
                  <View style={styles.row}>
                    <View style={styles.rowLabel}>
                      <View style={[styles.swatch, category.color ? { backgroundColor: category.color } : styles.swatchEmpty]} />
                      <Text style={styles.rowText}>{category.name}</Text>
                    </View>
                    <View style={styles.rowActions}>
                      <Pressable onPress={() => openEditCategory(category)}>
                        <Text style={styles.link}>Edit</Text>
                      </Pressable>
                      <Pressable onPress={() => handleDeleteCategory(category)}>
                        <Text style={styles.deleteLink}>Delete</Text>
                      </Pressable>
                    </View>
                  </View>

                  {categorySubcategories.map((subcategory) => (
                    <View key={subcategory.id} style={[styles.row, styles.subcategoryRow]}>
                      <View style={styles.rowLabel}>
                        <View
                          style={[styles.swatch, subcategory.color ? { backgroundColor: subcategory.color } : styles.swatchEmpty]}
                        />
                        <Text style={styles.rowText}>{subcategory.name}</Text>
                      </View>
                      <View style={styles.rowActions}>
                        <Pressable onPress={() => openEditSubcategory(subcategory)}>
                          <Text style={styles.link}>Edit</Text>
                        </Pressable>
                        <Pressable onPress={() => handleDeleteSubcategory(subcategory)}>
                          <Text style={styles.deleteLink}>Delete</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}

                  <Pressable style={styles.addSubcategoryButton} onPress={() => openNewSubcategory(category.id)}>
                    <Text style={styles.addSubcategoryButtonText}>+ Add subcategory</Text>
                  </Pressable>
                </View>
              );
            })}
            {categories.length === 0 ? <Text style={styles.empty}>No categories yet.</Text> : null}

            <Pressable style={styles.addButton} onPress={openNewCategory}>
              <Text style={styles.addButtonText}>+ New Category</Text>
            </Pressable>

            <Text style={[styles.sectionTitle, styles.secondSection]}>Suppliers</Text>
            <Text style={styles.subtitle}>Who you buy each item from - e.g. "Bunnings", "Reece".</Text>

            {suppliers.map((supplier) => (
              <View key={supplier.id} style={styles.row}>
                <Text style={styles.rowText}>{supplier.name}</Text>
                <View style={styles.rowActions}>
                  <Pressable onPress={() => openEditSupplier(supplier)}>
                    <Text style={styles.link}>Edit</Text>
                  </Pressable>
                  <Pressable onPress={() => handleDeleteSupplier(supplier)}>
                    <Text style={styles.deleteLink}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            ))}
            {suppliers.length === 0 ? <Text style={styles.empty}>No suppliers yet.</Text> : null}

            <Pressable style={styles.addButton} onPress={openNewSupplier}>
              <Text style={styles.addButtonText}>+ New Supplier</Text>
            </Pressable>
          </ScrollView>
        )}
      </SafeAreaView>

      <ThemedModal visible={categoryModalVisible} onClose={() => setCategoryModalVisible(false)}>
        <Text style={styles.modalTitle}>{editingCategory ? "Edit Category" : "New Category"}</Text>
        <ThemedFormField label="Name" placeholder="e.g. Material, Tools, First Aid Kit" value={categoryName} onChangeText={setCategoryName} />
        <View style={styles.fieldSpacing}>
          <ThemedFormField
            label="Color (optional hex, e.g. #1d4ed8)"
            placeholder="#1d4ed8"
            value={categoryColor}
            onChangeText={setCategoryColor}
            autoCapitalize="none"
          />
        </View>
        {categoryError ? <Text style={styles.error}>{categoryError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setCategoryModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label="Save" onPress={handleSaveCategory} />
        </View>
      </ThemedModal>

      <ThemedModal visible={subcategoryModalVisible} onClose={() => setSubcategoryModalVisible(false)}>
        <Text style={styles.modalTitle}>{editingSubcategory ? "Edit Subcategory" : "New Subcategory"}</Text>
        <ThemedFormField label="Name" placeholder="e.g. Roofing, Power Tools" value={subcategoryName} onChangeText={setSubcategoryName} />
        <View style={styles.fieldSpacing}>
          <ThemedFormField
            label="Color (optional hex, e.g. #1d4ed8)"
            placeholder="#1d4ed8"
            value={subcategoryColor}
            onChangeText={setSubcategoryColor}
            autoCapitalize="none"
          />
        </View>
        {subcategoryError ? <Text style={styles.error}>{subcategoryError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setSubcategoryModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label="Save" onPress={handleSaveSubcategory} />
        </View>
      </ThemedModal>

      <ThemedModal visible={supplierModalVisible} onClose={() => setSupplierModalVisible(false)}>
        <Text style={styles.modalTitle}>{editingSupplier ? "Edit Supplier" : "New Supplier"}</Text>
        <ThemedFormField label="Name" placeholder="e.g. Bunnings, Reece" value={supplierName} onChangeText={setSupplierName} />
        {supplierError ? <Text style={styles.error}>{supplierError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setSupplierModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label="Save" onPress={handleSaveSupplier} />
        </View>
      </ThemedModal>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    sectionTitle: {
      fontSize: font.label,
      fontWeight: "700" as const,
      color: tokens.accent,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    secondSection: { marginTop: 28 },
    subtitle: { color: tokens.textMuted, marginTop: 2, marginBottom: 16, fontSize: font.body - 1, ...mono },
    categoryBlock: { marginBottom: 8 },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
      gap: 8,
    },
    subcategoryRow: { paddingLeft: 20 },
    rowLabel: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexShrink: 1 },
    swatch: { width: 14, height: 14, borderRadius: 7 },
    swatchEmpty: { backgroundColor: tokens.border },
    rowText: { fontSize: font.body - 1, fontWeight: "600" as const, color: tokens.textPrimary, ...mono },
    rowActions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 14 },
    deleteLink: { color: tokens.danger, fontWeight: "600" as const, ...mono },
    addSubcategoryButton: { paddingLeft: 20, paddingVertical: 8 },
    addSubcategoryButtonText: { color: tokens.accent, fontWeight: "600" as const, fontSize: font.label, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 16, ...mono },
    addButton: {
      borderWidth: 1,
      borderColor: tokens.accent,
      backgroundColor: tokens.accentGlow,
      borderRadius: 3,
      padding: 14,
      alignItems: "center" as const,
      marginTop: 16,
    },
    addButtonText: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.body, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    fieldSpacing: { marginTop: 16 },
    error: { color: tokens.danger, marginTop: 12, ...mono },
    modalTitle: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      marginBottom: 4,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 20, marginTop: 16 },
  };
}

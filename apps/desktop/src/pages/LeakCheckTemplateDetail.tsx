import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { LeakCheckItemType, LeakCheckTemplate, LeakCheckTemplateCategory, LeakCheckTemplateItem } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField, ThemedTextAreaField } from "../components/theme/ThemedFormField";

interface LocalItem {
  id: string;
  item_type: LeakCheckItemType;
  label: string;
}

interface LocalCategory {
  id: string;
  name: string;
  items: LocalItem[];
}

async function fetchTemplate(id: string): Promise<LeakCheckTemplate> {
  const { data, error } = await supabase.from("leak_check_templates").select("*").eq("id", id).single();
  if (error) throw error;
  return data as LeakCheckTemplate;
}

async function fetchCategories(templateId: string): Promise<LeakCheckTemplateCategory[]> {
  const { data, error } = await supabase.from("leak_check_template_categories").select("*").eq("template_id", templateId).order("sort_order");
  if (error) throw error;
  return data as LeakCheckTemplateCategory[];
}

async function fetchItems(templateId: string): Promise<LeakCheckTemplateItem[]> {
  const { data, error } = await supabase.from("leak_check_template_items").select("*").eq("template_id", templateId).order("sort_order");
  if (error) throw error;
  return data as LeakCheckTemplateItem[];
}

function categoriesFromRows(categories: LeakCheckTemplateCategory[], items: LeakCheckTemplateItem[]): LocalCategory[] {
  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    items: items.filter((i) => i.category_id === c.id).map((i) => ({ id: i.id, item_type: i.item_type, label: i.label })),
  }));
}

export default function LeakCheckTemplateDetailPage() {
  const { id } = useParams<{ id: string }>();

  const { data: template } = useQuery({ queryKey: ["leak-check-template", id], queryFn: () => fetchTemplate(id!), enabled: !!id });
  const { data: categories } = useQuery({ queryKey: ["leak-check-template-categories", id], queryFn: () => fetchCategories(id!), enabled: !!id });
  const { data: items } = useQuery({ queryKey: ["leak-check-template-items", id], queryFn: () => fetchItems(id!), enabled: !!id });

  // Gate on all three fetches, not just `template`, before handing off to
  // the form below - which lazy-initializes its local category/item state
  // directly from props on its own first render rather than reseeding via
  // a post-mount effect. See PriceBookItem.tsx's own fix for why a reseed
  // effect is always one render too late once any field here (there are
  // none seed-once today, but this keeps the same safe shape as every
  // other job-tool/template editor in this app going forward).
  if (!template || !categories || !items) {
    return (
      <div className="p-8" style={{ color: "var(--jms-text-muted)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}>
        Loading...
      </div>
    );
  }

  return <LeakCheckTemplateForm key={id} id={id!} template={template} categories={categories} items={items} />;
}

function LeakCheckTemplateForm({
  id,
  template,
  categories,
  items,
}: {
  id: string;
  template: LeakCheckTemplate;
  categories: LeakCheckTemplateCategory[];
  items: LeakCheckTemplateItem[];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? "");
  const [localCategories, setLocalCategories] = useState<LocalCategory[]>(() => categoriesFromRows(categories, items));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const addCategory = () => setLocalCategories((prev) => [...prev, { id: crypto.randomUUID(), name: "", items: [] }]);
  const removeCategory = (categoryId: string) => setLocalCategories((prev) => prev.filter((c) => c.id !== categoryId));
  const renameCategory = (categoryId: string, nextName: string) =>
    setLocalCategories((prev) => prev.map((c) => (c.id === categoryId ? { ...c, name: nextName } : c)));

  const addItem = (categoryId: string) =>
    setLocalCategories((prev) =>
      prev.map((c) => (c.id === categoryId ? { ...c, items: [...c.items, { id: crypto.randomUUID(), item_type: "standard", label: "" }] } : c))
    );
  const removeItem = (categoryId: string, itemId: string) =>
    setLocalCategories((prev) => prev.map((c) => (c.id === categoryId ? { ...c, items: c.items.filter((i) => i.id !== itemId) } : c)));
  const updateItem = (categoryId: string, itemId: string, patch: Partial<LocalItem>) =>
    setLocalCategories((prev) =>
      prev.map((c) => (c.id === categoryId ? { ...c, items: c.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) } : c))
    );

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Name is required");
      for (const c of localCategories) {
        if (!c.name.trim()) throw new Error("Every category needs a name");
        for (const i of c.items) {
          if (!i.label.trim()) throw new Error("Every item needs a label");
        }
      }

      const { error: templateError } = await supabase
        .from("leak_check_templates")
        .update({ name: name.trim(), description: description.trim() || null })
        .eq("id", id);
      if (templateError) throw templateError;

      // Small, bounded nested child-row count (categories, and items within
      // them) - a plain delete-then-insert from the client, same convention
      // Price Book items/variations already use for their crew/materials
      // children (see PriceBookItem.tsx's splitPricingResult comment).
      // Deleting categories cascades their items automatically, so this
      // only needs to delete one level before reinserting both.
      const { error: deleteError } = await supabase.from("leak_check_template_categories").delete().eq("template_id", id);
      if (deleteError) throw deleteError;

      if (localCategories.length > 0) {
        const { error: categoriesError } = await supabase.from("leak_check_template_categories").insert(
          localCategories.map((c, i) => ({ id: c.id, template_id: id, name: c.name.trim(), sort_order: i }))
        );
        if (categoriesError) throw categoriesError;

        const allItems = localCategories.flatMap((c, ci) =>
          c.items.map((it, ii) => ({
            id: it.id,
            template_id: id,
            category_id: c.id,
            item_type: it.item_type,
            label: it.label.trim(),
            sort_order: ii + ci * 1000,
          }))
        );
        if (allItems.length > 0) {
          const { error: itemsError } = await supabase.from("leak_check_template_items").insert(allItems);
          if (itemsError) throw itemsError;
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leak-check-template", id] });
      queryClient.invalidateQueries({ queryKey: ["leak-check-template-categories", id] });
      queryClient.invalidateQueries({ queryKey: ["leak-check-template-items", id] });
      queryClient.invalidateQueries({ queryKey: ["leak-check-templates"] });
      setSaveError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save")),
  });

  const deleteTemplate = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("leak_check_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leak-check-templates"] });
      navigate("/settings/leak-check-templates");
    },
  });

  return (
    <div className="mx-auto max-w-2xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings/leak-check-templates" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Leak Check Templates
      </Link>

      <h1 className="mb-4 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        {template.name}
      </h1>

      <ThemedFormField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <ThemedTextAreaField label="Description (optional)" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />

      <h2 className="mb-2 mt-6 font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
        Categories
      </h2>

      {localCategories.length === 0 ? (
        <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          No categories yet - add one below (e.g. "Water Meter", "Taps", "Toilets").
        </p>
      ) : null}

      {localCategories.map((category) => (
        <div key={category.id} className="mb-4 rounded p-3" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <div className="mb-3 flex items-center gap-2">
            <input
              type="text"
              value={category.name}
              onChange={(e) => renameCategory(category.id, e.target.value)}
              placeholder="Category name"
              className="flex-1 rounded border px-3 py-2 font-semibold focus:outline-none"
              style={{
                backgroundColor: "var(--jms-bg)",
                borderColor: "var(--jms-border)",
                color: "var(--jms-text)",
                fontFamily: "var(--jms-font)",
                fontSize: "var(--jms-font-body)",
              }}
            />
            <button onClick={() => removeCategory(category.id)} style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
              &#10005;
            </button>
          </div>

          {category.items.map((item) => (
            <div key={item.id} className="mb-2 flex items-center gap-2">
              <input
                type="text"
                value={item.label}
                onChange={(e) => updateItem(category.id, item.id, { label: e.target.value })}
                placeholder="e.g. Kitchen tap"
                className="flex-1 rounded border px-3 py-2 focus:outline-none"
                style={{
                  backgroundColor: "var(--jms-bg)",
                  borderColor: "var(--jms-border)",
                  color: "var(--jms-text)",
                  fontFamily: "var(--jms-font)",
                  fontSize: "var(--jms-font-body)",
                }}
              />
              <select
                value={item.item_type}
                onChange={(e) => updateItem(category.id, item.id, { item_type: e.target.value as LeakCheckItemType })}
                className="rounded border px-2 py-2 focus:outline-none"
                style={{
                  backgroundColor: "var(--jms-bg)",
                  borderColor: "var(--jms-border)",
                  color: "var(--jms-text)",
                  fontFamily: "var(--jms-font)",
                  fontSize: "var(--jms-font-label)",
                }}
              >
                <option value="standard">Standard</option>
                <option value="water_meter">Water meter test</option>
              </select>
              <button onClick={() => removeItem(category.id, item.id)} style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
                &#10005;
              </button>
            </div>
          ))}

          <button onClick={() => addItem(category.id)} className="mt-1 font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
            + Add item
          </button>
        </div>
      ))}

      <button onClick={addCategory} className="mb-6 font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        + Add category
      </button>

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

      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => {
            if (window.confirm("Delete this template? This won't affect any leak checks already started from it.")) deleteTemplate.mutate();
          }}
          className="font-semibold"
          style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}
        >
          Delete template
        </button>
        <ThemedButton onClick={() => save.mutate()} disabled={save.isPending} style={{ paddingBlock: 12, paddingInline: 24 }}>
          {save.isPending ? "Saving..." : "Save changes"}
        </ThemedButton>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  JobLeakCheck,
  JobLeakCheckCategory,
  JobLeakCheckItem,
  JobLeakCheckItemFile,
  LeakCheckItemResult,
  LeakCheckItemType,
  LeakCheckTemplate,
  LeakCheckTemplateCategory,
  LeakCheckTemplateItem,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { uploadLeakCheckItemPhoto } from "../../lib/uploads";
import { ThemedButton } from "../theme/ThemedButton";
import { ThemedTextAreaField } from "../theme/ThemedFormField";

// Leak Check Checklist job tool - see the leak_check_checklist migration's
// own header comment for the full schema reasoning. Unlike most quote-
// tools (RoofAreaTool, ConcreteCalculator, ...), which fill out a form and
// batch-save it once, this is a progressive on-site checklist: every tick,
// note, or added fixture saves immediately as its own small mutation, same
// as a technician would expect ticking through a real paper checklist to
// just stick as they go - not something to lose by navigating away mid-
// check. Each leak check is its own append-style row (like job_
// measurements), so a property can legitimately be re-checked.

async function fetchLeakChecks(jobCardId: string): Promise<JobLeakCheck[]> {
  const { data, error } = await supabase.from("job_leak_checks").select("*").eq("job_card_id", jobCardId).order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobLeakCheck[];
}

async function fetchTemplates(): Promise<LeakCheckTemplate[]> {
  const { data, error } = await supabase.from("leak_check_templates").select("*").eq("is_archived", false).order("sort_order").order("name");
  if (error) throw error;
  return data as LeakCheckTemplate[];
}

export function LeakCheckTool({ jobCardId }: { jobCardId: string }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data: leakChecks } = useQuery({ queryKey: ["job-leak-checks", jobCardId], queryFn: () => fetchLeakChecks(jobCardId) });
  const { data: templates } = useQuery({ queryKey: ["leak-check-templates-active"], queryFn: fetchTemplates });

  const [activeId, setActiveId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string>("");
  const [startError, setStartError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const template = templates?.find((t) => t.id === templateId) ?? null;

      const { data: leakCheck, error: leakCheckError } = await supabase
        .from("job_leak_checks")
        .insert({
          tenant_id: profile.tenant_id,
          job_card_id: jobCardId,
          template_id: template?.id ?? null,
          title: template?.name ?? "Leak Check",
          created_by: profile.id,
        })
        .select("id")
        .single();
      if (leakCheckError) throw leakCheckError;
      const leakCheckId = leakCheck.id as string;

      if (template) {
        const { data: templateCategories, error: categoriesError } = await supabase
          .from("leak_check_template_categories")
          .select("*")
          .eq("template_id", template.id)
          .order("sort_order");
        if (categoriesError) throw categoriesError;
        const { data: templateItems, error: itemsError } = await supabase
          .from("leak_check_template_items")
          .select("*")
          .eq("template_id", template.id)
          .order("sort_order");
        if (itemsError) throw itemsError;

        const categoryIdMap = new Map<string, string>();
        const categoriesToInsert = (templateCategories as LeakCheckTemplateCategory[]).map((c, i) => {
          const newId = crypto.randomUUID();
          categoryIdMap.set(c.id, newId);
          return { id: newId, tenant_id: profile.tenant_id, leak_check_id: leakCheckId, job_card_id: jobCardId, name: c.name, sort_order: i };
        });
        if (categoriesToInsert.length > 0) {
          const { error } = await supabase.from("job_leak_check_categories").insert(categoriesToInsert);
          if (error) throw error;
        }

        const itemsToInsert = (templateItems as LeakCheckTemplateItem[])
          .filter((it) => categoryIdMap.has(it.category_id))
          .map((it, i) => ({
            tenant_id: profile.tenant_id,
            leak_check_id: leakCheckId,
            category_id: categoryIdMap.get(it.category_id)!,
            job_card_id: jobCardId,
            item_type: it.item_type,
            label: it.label,
            sort_order: i,
          }));
        if (itemsToInsert.length > 0) {
          const { error } = await supabase.from("job_leak_check_items").insert(itemsToInsert);
          if (error) throw error;
        }
      }

      return leakCheckId;
    },
    onSuccess: (leakCheckId) => {
      queryClient.invalidateQueries({ queryKey: ["job-leak-checks", jobCardId] });
      setStartError(null);
      setActiveId(leakCheckId);
    },
    onError: (e) => setStartError(getErrorMessage(e, "Failed to start leak check")),
  });

  if (activeId) {
    return <LeakCheckEditor leakCheckId={activeId} jobCardId={jobCardId} onBack={() => setActiveId(null)} />;
  }

  return (
    <div>
      {leakChecks && leakChecks.length > 0 ? (
        <div className="mb-4 space-y-2">
          {leakChecks.map((lc) => (
            <button
              key={lc.id}
              onClick={() => setActiveId(lc.id)}
              className="jms-nav-link flex w-full items-center justify-between rounded-lg p-3 text-left"
              style={{ border: "1px solid var(--jms-border)", fontSize: "var(--jms-font-body)" }}
            >
              <span className="font-semibold" style={{ color: "var(--jms-text)" }}>
                {lc.title}
              </span>
              <span className="flex items-center gap-3">
                <span style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  {new Date(lc.created_at).toLocaleDateString()}
                </span>
                <span
                  className="rounded px-2 py-0.5 font-bold uppercase tracking-wide"
                  style={
                    lc.status === "completed"
                      ? { backgroundColor: "var(--jms-accent-glow)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                      : { backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
                  }
                >
                  {lc.status === "completed" ? "Completed" : "In progress"}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          No leak checks started on this job yet.
        </p>
      )}

      <div className="rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)" }}>
        <p className="mb-2 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Start a new leak check
        </p>
        <div className="flex items-center gap-3">
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="flex-1 rounded border px-3 py-2 focus:outline-none"
            style={{
              backgroundColor: "var(--jms-surface)",
              borderColor: "var(--jms-border)",
              color: "var(--jms-text)",
              fontFamily: "var(--jms-font)",
              fontSize: "var(--jms-font-body)",
            }}
          >
            <option value="">Blank checklist (no template)</option>
            {(templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <ThemedButton onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? "Starting..." : "Start"}
          </ThemedButton>
        </div>
        {startError ? (
          <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {startError}
          </p>
        ) : null}
      </div>
    </div>
  );
}

async function fetchCategories(leakCheckId: string): Promise<JobLeakCheckCategory[]> {
  const { data, error } = await supabase.from("job_leak_check_categories").select("*").eq("leak_check_id", leakCheckId).order("sort_order");
  if (error) throw error;
  return data as JobLeakCheckCategory[];
}

async function fetchItems(leakCheckId: string): Promise<JobLeakCheckItem[]> {
  const { data, error } = await supabase.from("job_leak_check_items").select("*").eq("leak_check_id", leakCheckId).order("sort_order");
  if (error) throw error;
  return data as JobLeakCheckItem[];
}

async function fetchItemFiles(jobCardId: string): Promise<JobLeakCheckItemFile[]> {
  const { data, error } = await supabase.from("job_leak_check_item_files").select("*").eq("job_card_id", jobCardId).order("created_at");
  if (error) throw error;
  return data as JobLeakCheckItemFile[];
}

const RESULT_LABELS: Record<LeakCheckItemResult, string> = { pass: "Pass", fail: "Fail", na: "N/A" };

function LeakCheckEditor({ leakCheckId, jobCardId, onBack }: { leakCheckId: string; jobCardId: string; onBack: () => void }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: leakCheck } = useQuery({ queryKey: ["job-leak-check", leakCheckId], queryFn: async () => {
    const { data, error } = await supabase.from("job_leak_checks").select("*").eq("id", leakCheckId).single();
    if (error) throw error;
    return data as JobLeakCheck;
  } });
  const { data: categories } = useQuery({ queryKey: ["job-leak-check-categories", leakCheckId], queryFn: () => fetchCategories(leakCheckId) });
  const { data: items } = useQuery({ queryKey: ["job-leak-check-items", leakCheckId], queryFn: () => fetchItems(leakCheckId) });
  const { data: allFiles } = useQuery({ queryKey: ["job-leak-check-item-files", jobCardId], queryFn: () => fetchItemFiles(jobCardId) });

  const [newCategoryName, setNewCategoryName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const invalidateItems = () => queryClient.invalidateQueries({ queryKey: ["job-leak-check-items", leakCheckId] });
  const invalidateCategories = () => {
    queryClient.invalidateQueries({ queryKey: ["job-leak-check-categories", leakCheckId] });
    invalidateItems();
  };

  const addCategory = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      if (!newCategoryName.trim()) throw new Error("Category name is required");
      const { error } = await supabase.from("job_leak_check_categories").insert({
        tenant_id: profile.tenant_id,
        leak_check_id: leakCheckId,
        job_card_id: jobCardId,
        name: newCategoryName.trim(),
        sort_order: categories?.length ?? 0,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateCategories();
      setNewCategoryName("");
      setActionError(null);
    },
    onError: (e) => setActionError(getErrorMessage(e, "Failed to add category")),
  });

  const removeCategory = useMutation({
    mutationFn: async (categoryId: string) => {
      const { error } = await supabase.from("job_leak_check_categories").delete().eq("id", categoryId);
      if (error) throw error;
    },
    onSuccess: invalidateCategories,
  });

  const addItem = useMutation({
    mutationFn: async ({ categoryId, itemType }: { categoryId: string; itemType: LeakCheckItemType }) => {
      if (!profile) throw new Error("Not signed in");
      const { error } = await supabase.from("job_leak_check_items").insert({
        tenant_id: profile.tenant_id,
        leak_check_id: leakCheckId,
        category_id: categoryId,
        job_card_id: jobCardId,
        item_type: itemType,
        label: itemType === "water_meter" ? "Water meter test" : "",
        sort_order: items?.filter((i) => i.category_id === categoryId).length ?? 0,
      });
      if (error) throw error;
    },
    onSuccess: invalidateItems,
    onError: (e) => setActionError(getErrorMessage(e, "Failed to add item")),
  });

  const removeItem = useMutation({
    mutationFn: async (itemId: string) => {
      const { error } = await supabase.from("job_leak_check_items").delete().eq("id", itemId);
      if (error) throw error;
    },
    onSuccess: invalidateItems,
  });

  const updateItem = useMutation({
    mutationFn: async ({ itemId, patch }: { itemId: string; patch: Partial<JobLeakCheckItem> }) => {
      const { error } = await supabase.from("job_leak_check_items").update(patch).eq("id", itemId);
      if (error) throw error;
    },
    onSuccess: invalidateItems,
    onError: (e) => setActionError(getErrorMessage(e, "Failed to save")),
  });

  const uploadPhoto = useMutation({
    mutationFn: async ({ itemId, file }: { itemId: string; file: File }) => {
      if (!profile) throw new Error("Not signed in");
      await uploadLeakCheckItemPhoto({ tenantId: profile.tenant_id, itemId, jobCardId, uploadedBy: profile.id, file });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["job-leak-check-item-files", jobCardId] }),
    onError: (e) => setActionError(getErrorMessage(e, "Failed to upload photo")),
  });

  const removePhoto = useMutation({
    mutationFn: async (fileId: string) => {
      const { error } = await supabase.from("job_leak_check_item_files").delete().eq("id", fileId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["job-leak-check-item-files", jobCardId] }),
  });

  const setStatus = useMutation({
    mutationFn: async (status: "in_progress" | "completed") => {
      if (!profile) throw new Error("Not signed in");
      const { error } = await supabase
        .from("job_leak_checks")
        .update(
          status === "completed"
            ? { status, completed_at: new Date().toISOString(), completed_by: profile.id }
            : { status, completed_at: null, completed_by: null }
        )
        .eq("id", leakCheckId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["job-leak-check", leakCheckId] }),
  });

  if (!leakCheck || !categories || !items) {
    return (
      <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
    );
  }

  const failCount = items.filter((i) => i.result === "fail").length;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <button onClick={onBack} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
          &larr; All leak checks
        </button>
        <div className="flex items-center gap-3">
          {failCount > 0 ? (
            <span className="rounded px-2 py-1 font-bold uppercase tracking-wide" style={{ backgroundColor: "var(--jms-danger)", color: "var(--jms-bg)", fontSize: "var(--jms-font-label)" }}>
              {failCount} issue{failCount === 1 ? "" : "s"} found
            </span>
          ) : null}
          {leakCheck.status === "completed" ? (
            <button onClick={() => setStatus.mutate("in_progress")} className="font-semibold hover:underline" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              Reopen
            </button>
          ) : (
            <ThemedButton onClick={() => setStatus.mutate("completed")} disabled={setStatus.isPending}>
              Mark complete
            </ThemedButton>
          )}
        </div>
      </div>

      {actionError ? (
        <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          {actionError}
        </p>
      ) : null}

      {categories.map((category) => (
        <div key={category.id} className="mb-4 rounded-lg p-3" style={{ border: "1px solid var(--jms-border)" }}>
          <div className="mb-2 flex items-center justify-between">
            <span className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
              {category.name}
            </span>
            <button onClick={() => removeCategory.mutate(category.id)} style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
              Remove category
            </button>
          </div>

          {items
            .filter((i) => i.category_id === category.id)
            .map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                files={(allFiles ?? []).filter((f) => f.item_id === item.id)}
                onUpdate={(patch) => updateItem.mutate({ itemId: item.id, patch })}
                onRemove={() => removeItem.mutate(item.id)}
                onUploadPhoto={(file) => uploadPhoto.mutate({ itemId: item.id, file })}
                onRemovePhoto={(fileId) => removePhoto.mutate(fileId)}
              />
            ))}

          <div className="mt-2 flex gap-3">
            <button
              onClick={() => addItem.mutate({ categoryId: category.id, itemType: "standard" })}
              className="font-semibold hover:underline"
              style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
            >
              + Add fixture
            </button>
            <button
              onClick={() => addItem.mutate({ categoryId: category.id, itemType: "water_meter" })}
              className="font-semibold hover:underline"
              style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
            >
              + Add water meter test
            </button>
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3">
        <input
          type="text"
          value={newCategoryName}
          onChange={(e) => setNewCategoryName(e.target.value)}
          placeholder="e.g. Irrigation"
          className="flex-1 rounded border px-3 py-2 focus:outline-none"
          style={{
            backgroundColor: "var(--jms-bg)",
            borderColor: "var(--jms-border)",
            color: "var(--jms-text)",
            fontFamily: "var(--jms-font)",
            fontSize: "var(--jms-font-body)",
          }}
        />
        <ThemedButton onClick={() => addCategory.mutate()} disabled={addCategory.isPending || !newCategoryName.trim()}>
          + Add category
        </ThemedButton>
      </div>
    </div>
  );
}

function ItemRow({
  item,
  files,
  onUpdate,
  onRemove,
  onUploadPhoto,
  onRemovePhoto,
}: {
  item: JobLeakCheckItem;
  files: JobLeakCheckItemFile[];
  onUpdate: (patch: Partial<JobLeakCheckItem>) => void;
  onRemove: () => void;
  onUploadPhoto: (file: File) => void;
  onRemovePhoto: (fileId: string) => void;
}) {
  const { data: fileUrls } = useQuery({
    queryKey: ["job-leak-check-item-file-urls", files.map((f) => f.id).join(",")],
    queryFn: async () => {
      const entries = await Promise.all(
        files.map(async (f) => {
          const { data } = await supabase.storage.from("job-files").createSignedUrl(f.storage_path, 3600);
          return [f.id, data?.signedUrl ?? ""] as const;
        })
      );
      return Object.fromEntries(entries) as Record<string, string>;
    },
    enabled: files.length > 0,
  });

  const [label, setLabel] = useState(item.label);
  const [notes, setNotes] = useState(item.notes ?? "");
  const [meterStart, setMeterStart] = useState(item.meter_start_reading != null ? String(item.meter_start_reading) : "");
  const [meterEnd, setMeterEnd] = useState(item.meter_end_reading != null ? String(item.meter_end_reading) : "");
  const [meterWait, setMeterWait] = useState(item.meter_wait_minutes != null ? String(item.meter_wait_minutes) : "");

  const meterMoved = item.meter_start_reading != null && item.meter_end_reading != null && item.meter_start_reading !== item.meter_end_reading;

  return (
    <div className="mb-2 rounded p-2" style={{ backgroundColor: "var(--jms-surface)" }}>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            if (label !== item.label) onUpdate({ label });
          }}
          placeholder="e.g. Kitchen tap"
          disabled={item.item_type === "water_meter"}
          className="flex-1 rounded border px-2 py-1.5 focus:outline-none"
          style={{
            backgroundColor: "var(--jms-bg)",
            borderColor: "var(--jms-border)",
            color: "var(--jms-text)",
            fontFamily: "var(--jms-font)",
            fontSize: "var(--jms-font-body)",
          }}
        />
        {item.item_type === "standard" ? (
          <div className="flex gap-1">
            {(["pass", "fail", "na"] as LeakCheckItemResult[]).map((r) => (
              <button
                key={r}
                onClick={() => onUpdate({ result: r })}
                className="rounded px-2 py-1.5 font-semibold"
                style={
                  item.result === r
                    ? {
                        backgroundColor: r === "fail" ? "var(--jms-danger)" : "var(--jms-accent-glow)",
                        color: r === "fail" ? "var(--jms-bg)" : "var(--jms-accent)",
                        fontSize: "var(--jms-font-label)",
                      }
                    : { backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
                }
              >
                {RESULT_LABELS[r]}
              </button>
            ))}
          </div>
        ) : null}
        <button onClick={onRemove} style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
          &#10005;
        </button>
      </div>

      {item.item_type === "water_meter" ? (
        <div className="mt-2 grid grid-cols-3 gap-2">
          <input
            type="number"
            value={meterStart}
            onChange={(e) => setMeterStart(e.target.value)}
            onBlur={() => onUpdate({ meter_start_reading: meterStart === "" ? null : Number(meterStart) })}
            placeholder="Start reading"
            className="rounded border px-2 py-1.5 focus:outline-none"
            style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
          />
          <input
            type="number"
            value={meterEnd}
            onChange={(e) => setMeterEnd(e.target.value)}
            onBlur={() => onUpdate({ meter_end_reading: meterEnd === "" ? null : Number(meterEnd) })}
            placeholder="End reading"
            className="rounded border px-2 py-1.5 focus:outline-none"
            style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
          />
          <input
            type="number"
            value={meterWait}
            onChange={(e) => setMeterWait(e.target.value)}
            onBlur={() => onUpdate({ meter_wait_minutes: meterWait === "" ? null : Number(meterWait) })}
            placeholder="Wait (minutes)"
            className="rounded border px-2 py-1.5 focus:outline-none"
            style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
          />
          {meterStart !== "" && meterEnd !== "" ? (
            <p className="col-span-3" style={{ color: meterMoved ? "var(--jms-danger)" : "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
              {meterMoved ? "Meter moved - likely leak" : "Meter steady - no leak detected"}
            </p>
          ) : null}
        </div>
      ) : null}

      <ThemedTextAreaField
        label=""
        labelHidden
        rows={1}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => {
          if (notes !== (item.notes ?? "")) onUpdate({ notes: notes || null });
        }}
        placeholder="Notes"
        className="mt-2"
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {files.map((f) => (
          <div key={f.id} className="relative">
            {fileUrls?.[f.id] ? (
              <img src={fileUrls[f.id]} alt="" className="h-16 w-16 rounded object-cover" style={{ border: "1px solid var(--jms-border)" }} />
            ) : (
              <div className="h-16 w-16 rounded" style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)" }} />
            )}
            <button
              onClick={() => onRemovePhoto(f.id)}
              className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full"
              style={{ backgroundColor: "var(--jms-danger)", color: "var(--jms-bg)", fontSize: "10px" }}
            >
              &#10005;
            </button>
          </div>
        ))}
        <label className="cursor-pointer font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          + Add photo
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUploadPhoto(file);
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}

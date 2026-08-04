import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  createReportTemplateSchema,
  FIELD_TYPE_LABELS,
  type ReportFieldDefinition,
  type ReportFieldType,
  type ReportSectionDefinition,
  type ReportStructureSchema,
  type ReportSubcategory,
  type ReportTemplate,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { FormField, SelectField, TextAreaField } from "../components/FormField";

// Template Studio's form builder - the piece of the SafetyCulture-style
// spec that's genuinely complex enough to deserve its own page rather
// than a Modal (same reasoning PriceBookItem.tsx already applies to
// variations): an admin adds/removes/reorders sections and fields, picks
// each field's type, and toggles per-field options (required, "fail
// requires action+photo"). No drag-and-drop - up/down buttons only, same
// effort tradeoff as everywhere else a reorderable list exists in this
// app outside the one screen (Dispatch board) that specifically needed
// pointer-drag semantics.

const FIELD_TYPES: ReportFieldType[] = ["pass_fail", "risk_matrix", "photo", "text", "long_text", "meter_reading", "signature"];

function newId(): string {
  return crypto.randomUUID();
}

function newField(type: ReportFieldType): ReportFieldDefinition {
  return { id: newId(), type, label: "", required: false, requireActionOnFail: type === "pass_fail" ? true : undefined };
}

function newSection(): ReportSectionDefinition {
  return { id: newId(), title: "", fields: [] };
}

function moveItem<T>(arr: T[], index: number, direction: -1 | 1): T[] {
  const next = [...arr];
  const target = index + direction;
  if (target < 0 || target >= next.length) return next;
  const a = next[index];
  const b = next[target];
  if (a === undefined || b === undefined) return next;
  next[index] = b;
  next[target] = a;
  return next;
}

async function fetchSubcategories(): Promise<ReportSubcategory[]> {
  const { data, error } = await supabase.from("report_subcategories").select("*").order("name");
  if (error) throw error;
  return data as ReportSubcategory[];
}
async function fetchTemplate(id: string): Promise<ReportTemplate> {
  const { data, error } = await supabase.from("report_templates").select("*").eq("id", id).single();
  if (error) throw error;
  return data as ReportTemplate;
}

export default function ReportTemplateEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id;
  const [searchParams] = useSearchParams();
  const preselectedSubcategoryId = searchParams.get("subcategoryId") ?? "";
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: subcategories } = useQuery({ queryKey: ["report-subcategories"], queryFn: fetchSubcategories });
  const { data: template } = useQuery({
    queryKey: ["report-template", id],
    queryFn: () => fetchTemplate(id!),
    enabled: !isNew,
  });

  const [subcategoryId, setSubcategoryId] = useState(preselectedSubcategoryId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isSwms, setIsSwms] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [sections, setSections] = useState<ReportStructureSchema>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (template) {
      setSubcategoryId(template.subcategory_id);
      setTitle(template.title);
      setDescription(template.description ?? "");
      setIsSwms(template.is_swms);
      setIsActive(template.is_active);
      setSections(template.structure_schema);
    }
  }, [template]);

  const addSection = () => setSections((prev) => [...prev, newSection()]);
  const removeSection = (sectionId: string) => setSections((prev) => prev.filter((s) => s.id !== sectionId));
  const updateSection = (sectionId: string, patch: Partial<ReportSectionDefinition>) =>
    setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, ...patch } : s)));
  const moveSection = (index: number, direction: -1 | 1) => setSections((prev) => moveItem(prev, index, direction));

  const addField = (sectionId: string, type: ReportFieldType) =>
    setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, fields: [...s.fields, newField(type)] } : s)));
  const removeField = (sectionId: string, fieldId: string) =>
    setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, fields: s.fields.filter((f) => f.id !== fieldId) } : s)));
  const updateField = (sectionId: string, fieldId: string, patch: Partial<ReportFieldDefinition>) =>
    setSections((prev) =>
      prev.map((s) => (s.id === sectionId ? { ...s, fields: s.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)) } : s))
    );
  const moveField = (sectionId: string, index: number, direction: -1 | 1) =>
    setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, fields: moveItem(s.fields, index, direction) } : s)));

  const save = useMutation({
    mutationFn: async () => {
      const result = createReportTemplateSchema.safeParse({
        subcategory_id: subcategoryId,
        title,
        description,
        is_swms: isSwms,
        structure_schema: sections,
        is_active: isActive,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");
      if (!profile) throw new Error("Not signed in");

      if (isNew) {
        const { data, error } = await supabase
          .from("report_templates")
          .insert({ tenant_id: profile.tenant_id, ...result.data })
          .select("id")
          .single();
        if (error) throw error;
        return data.id as string;
      }
      const { error } = await supabase.from("report_templates").update(result.data).eq("id", id);
      if (error) throw error;
      return id!;
    },
    onSuccess: (savedId) => {
      queryClient.invalidateQueries({ queryKey: ["report-templates"] });
      queryClient.invalidateQueries({ queryKey: ["report-template", savedId] });
      setSaveError(null);
      if (isNew) navigate(`/reports/templates/${savedId}`);
      else {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save template")),
  });

  const deleteTemplate = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("report_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["report-templates"] });
      navigate("/reports");
    },
  });

  return (
    <div className="mx-auto max-w-3xl p-8">
      <Link to="/reports" className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to Reports
      </Link>
      <h1 className="mb-6 text-xl font-bold text-gray-900">{isNew ? "New report template" : "Edit report template"}</h1>

      <SelectField
        label="Subcategory"
        value={subcategoryId}
        onChange={setSubcategoryId}
        options={(subcategories ?? []).map((s) => ({ value: s.id, label: s.name }))}
        placeholder="Select subcategory"
      />
      <FormField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Roof Inspection Report" />
      <TextAreaField label="Description (optional)" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />

      <div className="mb-4 flex gap-6">
        <label className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <input type="checkbox" checked={isSwms} onChange={(e) => setIsSwms(e.target.checked)} />
          Requires SWMS worker sign-off roster
        </label>
        <label className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active (visible in New Report)
        </label>
      </div>

      <h2 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-gray-500">Sections</h2>
      <div className="space-y-4">
        {sections.map((section, sectionIndex) => (
          <div key={section.id} className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="mb-3 flex items-center gap-2">
              <input
                value={section.title}
                onChange={(e) => updateSection(section.id, { title: e.target.value })}
                placeholder="Section title"
                className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm font-semibold focus:border-blue-500 focus:outline-none"
              />
              <button onClick={() => moveSection(sectionIndex, -1)} disabled={sectionIndex === 0} className="px-2 text-gray-400 hover:text-gray-700 disabled:opacity-30">
                ↑
              </button>
              <button
                onClick={() => moveSection(sectionIndex, 1)}
                disabled={sectionIndex === sections.length - 1}
                className="px-2 text-gray-400 hover:text-gray-700 disabled:opacity-30"
              >
                ↓
              </button>
              <button onClick={() => removeSection(section.id)} className="text-sm font-semibold text-red-600 hover:underline">
                Remove
              </button>
            </div>

            <div className="space-y-2">
              {section.fields.map((field, fieldIndex) => (
                <div key={field.id} className="rounded-md bg-gray-50 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <input
                      value={field.label}
                      onChange={(e) => updateField(section.id, field.id, { label: e.target.value })}
                      placeholder="Field label / question"
                      className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <span className="whitespace-nowrap rounded-full bg-gray-200 px-2 py-1 text-xs font-semibold text-gray-700">
                      {FIELD_TYPE_LABELS[field.type]}
                    </span>
                    <button onClick={() => moveField(section.id, fieldIndex, -1)} disabled={fieldIndex === 0} className="px-1 text-gray-400 hover:text-gray-700 disabled:opacity-30">
                      ↑
                    </button>
                    <button
                      onClick={() => moveField(section.id, fieldIndex, 1)}
                      disabled={fieldIndex === section.fields.length - 1}
                      className="px-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button onClick={() => removeField(section.id, field.id)} className="text-xs font-semibold text-red-600 hover:underline">
                      Remove
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-1.5 text-xs text-gray-600">
                      <input
                        type="checkbox"
                        checked={field.required}
                        onChange={(e) => updateField(section.id, field.id, { required: e.target.checked })}
                      />
                      Required
                    </label>
                    {field.type === "pass_fail" ? (
                      <label className="flex items-center gap-1.5 text-xs text-gray-600">
                        <input
                          type="checkbox"
                          checked={field.requireActionOnFail ?? false}
                          onChange={(e) => updateField(section.id, field.id, { requireActionOnFail: e.target.checked })}
                        />
                        "Fail" requires action note + photo
                      </label>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap gap-1">
              {FIELD_TYPES.map((type) => (
                <button
                  key={type}
                  onClick={() => addField(section.id, type)}
                  className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                >
                  + {FIELD_TYPE_LABELS[type]}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <button onClick={addSection} className="mt-4 rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">
        + Add section
      </button>

      {saveError ? <p className="mb-2 mt-4 text-sm text-red-600">{saveError}</p> : null}
      {saved ? <p className="mb-2 mt-4 text-sm text-green-700">Saved.</p> : null}

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-md bg-blue-700 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {save.isPending ? "Saving..." : isNew ? "Create template" : "Save changes"}
        </button>
        {!isNew ? (
          <button
            onClick={() => {
              if (window.confirm(`Delete "${title}"? This does not delete reports already completed from it.`)) deleteTemplate.mutate();
            }}
            className="text-sm font-semibold text-red-600 hover:underline"
          >
            Delete template
          </button>
        ) : null}
      </div>
    </div>
  );
}

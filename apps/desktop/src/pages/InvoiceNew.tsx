import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { calculateDocumentTotals, createInvoiceSchema, type Client, type JobCard, type Template } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { emptyLineItem, normalizeLineItem } from "../lib/line-items";
import { LineItemEditor } from "../components/LineItemEditor";
import { SelectField, TextAreaField } from "../components/FormField";
import type { LineItemFormInput } from "@jmssaas/shared";

async function fetchClients(): Promise<Client[]> {
  const { data, error } = await supabase.from("clients").select("*").order("name");
  if (error) throw error;
  return data as Client[];
}

async function fetchInvoiceTemplates(): Promise<Template[]> {
  const { data, error } = await supabase.from("templates").select("*").eq("type", "invoice");
  if (error) throw error;
  return data as Template[];
}

export default function InvoiceNewPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [searchParams] = useSearchParams();
  const jobCardIdParam = searchParams.get("jobCardId");
  const clientIdParam = searchParams.get("clientId");
  const lockedFromJob = !!jobCardIdParam;

  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: fetchClients });
  const { data: templates } = useQuery({ queryKey: ["invoice-templates"], queryFn: fetchInvoiceTemplates });

  const [clientId, setClientId] = useState("");
  const [jobCardId, setJobCardId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [lineItems, setLineItems] = useState<LineItemFormInput[]>([emptyLineItem(0)]);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: clientJobs } = useQuery({
    queryKey: ["client-jobs", clientId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("job_cards")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as JobCard[];
    },
    enabled: !!clientId,
  });

  useEffect(() => {
    if (clientIdParam && !clientId) setClientId(clientIdParam);
  }, [clientIdParam, clientId]);
  useEffect(() => {
    if (jobCardIdParam && !jobCardId) setJobCardId(jobCardIdParam);
  }, [jobCardIdParam, jobCardId]);

  const createInvoice = useMutation({
    mutationFn: async () => {
      const result = createInvoiceSchema.safeParse({
        client_id: clientId,
        job_card_id: jobCardId || undefined,
        due_date: dueDate || undefined,
        notes,
        line_items: lineItems,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");
      if (!profile) throw new Error("Not signed in");

      const totals = calculateDocumentTotals(result.data.line_items);

      const { data: invoice, error: invoiceError } = await supabase
        .from("invoices")
        .insert({
          tenant_id: profile.tenant_id,
          client_id: result.data.client_id,
          job_card_id: result.data.job_card_id ?? null,
          status: "draft",
          issue_date: new Date().toISOString().slice(0, 10),
          due_date: result.data.due_date ?? null,
          subtotal_cents: totals.subtotal_cents,
          gst_cents: totals.gst_cents,
          total_cents: totals.total_cents,
          notes: result.data.notes || null,
          created_by: profile.id,
        })
        .select()
        .single();
      if (invoiceError) throw invoiceError;

      const { error: lineItemsError } = await supabase.from("invoice_line_items").insert(
        result.data.line_items.map((item, index) => ({
          tenant_id: profile.tenant_id,
          invoice_id: invoice.id,
          description: item.description,
          quantity: item.quantity,
          labour_rate_cents: item.labour_rate_cents,
          labour_hours: item.labour_hours,
          material_cost_cents: item.material_cost_cents,
          markup_percent: item.markup_percent,
          unit_price_cents: item.unit_price_cents,
          gst_applicable: item.gst_applicable,
          sort_order: index,
          is_callout_fee: item.is_callout_fee ?? false,
        }))
      );
      if (lineItemsError) throw lineItemsError;

      return invoice.id as string;
    },
    onSuccess: (invoiceId) => navigate(`/invoices/${invoiceId}`),
    onError: (e) => setFormError(getErrorMessage(e, "Failed to create invoice")),
  });

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-6 text-xl font-bold text-gray-900">New invoice</h1>

      <SelectField
        label="Client"
        value={clientId}
        onChange={(v) => {
          if (lockedFromJob) return;
          setClientId(v);
          setJobCardId("");
        }}
        options={(clients ?? []).map((c) => ({ value: c.id, label: c.name }))}
        placeholder="Select a client"
      />
      <SelectField
        label={`Linked job${lockedFromJob ? "" : " (optional)"}`}
        value={jobCardId}
        onChange={(v) => !lockedFromJob && setJobCardId(v)}
        options={(clientJobs ?? []).map((j) => ({ value: j.id, label: j.title }))}
        placeholder={clientId ? "Select a job" : "Pick a client first"}
      />

      <div className="mb-4">
        <label className="mb-1 block text-sm font-semibold text-gray-700">Due date (optional)</label>
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
      </div>

      {templates && templates.length > 0 ? (
        <SelectField
          label="Load from template (optional)"
          value={templateId}
          onChange={(v) => {
            setTemplateId(v);
            const template = templates.find((t) => t.id === v);
            if (template) setLineItems(template.default_line_items.map((item, index) => normalizeLineItem(item, index)));
          }}
          options={templates.map((t) => ({ value: t.id, label: t.name }))}
        />
      ) : null}

      <h2 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-gray-500">Line items</h2>
      <LineItemEditor items={lineItems} onChange={setLineItems} />

      <div className="mt-4">
        <TextAreaField label="Notes (optional)" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      {formError ? <p className="mb-4 text-sm text-red-600">{formError}</p> : null}

      <button
        onClick={() => createInvoice.mutate()}
        disabled={createInvoice.isPending}
        className="mt-2 rounded-md bg-blue-700 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
      >
        {createInvoice.isPending ? "Saving..." : "Create invoice"}
      </button>
    </div>
  );
}

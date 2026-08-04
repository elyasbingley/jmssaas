import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { calculateDocumentTotals, createQuoteSchema, type Client, type JobCard, type ReferralPartner, type Template } from "@jmssaas/shared";
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

async function fetchQuoteTemplates(): Promise<Template[]> {
  const { data, error } = await supabase.from("templates").select("*").eq("type", "quote");
  if (error) throw error;
  return data as Template[];
}

async function fetchReferralPartners(): Promise<ReferralPartner[]> {
  const { data, error } = await supabase.from("referral_partners").select("*").eq("status", "active").order("contact_first_name");
  if (error) throw error;
  return data as ReferralPartner[];
}

export default function QuoteNewPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  // Cross-linking: arriving here with ?jobCardId=...&clientId=... (e.g. from
  // a job card's "New quote for this job" action) pre-fills and locks the
  // client/job, mirroring apps/mobile/app/(tabs)/sales/quotes/new.tsx.
  const [searchParams] = useSearchParams();
  const jobCardIdParam = searchParams.get("jobCardId");
  const clientIdParam = searchParams.get("clientId");
  const lockedFromJob = !!jobCardIdParam;

  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: fetchClients });
  const { data: templates } = useQuery({ queryKey: ["quote-templates"], queryFn: fetchQuoteTemplates });
  const { data: referralPartners } = useQuery({ queryKey: ["referral-partners", "active"], queryFn: fetchReferralPartners });

  const [clientId, setClientId] = useState("");
  const [jobCardId, setJobCardId] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [referralPartnerId, setReferralPartnerId] = useState("");
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

  const createQuote = useMutation({
    mutationFn: async () => {
      const result = createQuoteSchema.safeParse({
        client_id: clientId,
        job_card_id: jobCardId || undefined,
        expiry_date: expiryDate || undefined,
        notes,
        line_items: lineItems,
        referral_partner_id: referralPartnerId || undefined,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");
      if (!profile) throw new Error("Not signed in");

      const totals = calculateDocumentTotals(result.data.line_items);

      const { data: quote, error: quoteError } = await supabase
        .from("quotes")
        .insert({
          tenant_id: profile.tenant_id,
          client_id: result.data.client_id,
          job_card_id: result.data.job_card_id ?? null,
          status: "draft",
          issue_date: new Date().toISOString().slice(0, 10),
          expiry_date: result.data.expiry_date ?? null,
          subtotal_cents: totals.subtotal_cents,
          gst_cents: totals.gst_cents,
          total_cents: totals.total_cents,
          notes: result.data.notes || null,
          referral_partner_id: result.data.referral_partner_id ?? null,
          created_by: profile.id,
        })
        .select()
        .single();
      if (quoteError) throw quoteError;

      const { error: lineItemsError } = await supabase.from("quote_line_items").insert(
        result.data.line_items.map((item, index) => ({
          tenant_id: profile.tenant_id,
          quote_id: quote.id,
          description: item.description,
          quantity: item.quantity,
          labour_rate_cents: item.labour_rate_cents,
          labour_hours: item.labour_hours,
          material_cost_cents: item.material_cost_cents,
          markup_percent: item.markup_percent,
          unit_price_cents: item.unit_price_cents,
          gst_applicable: item.gst_applicable,
          sort_order: index,
        }))
      );
      if (lineItemsError) throw lineItemsError;

      return quote.id as string;
    },
    onSuccess: (quoteId) => navigate(`/quotes/${quoteId}`),
    onError: (e) => setFormError(getErrorMessage(e, "Failed to create quote")),
  });

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-6 text-xl font-bold text-gray-900">New quote</h1>

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
        <label className="mb-1 block text-sm font-semibold text-gray-700">Expiry date (optional)</label>
        <input
          type="date"
          value={expiryDate}
          onChange={(e) => setExpiryDate(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
      </div>

      <SelectField
        label="Referral source (optional)"
        value={referralPartnerId}
        onChange={setReferralPartnerId}
        options={(referralPartners ?? []).map((p) => ({
          value: p.id,
          label: p.company_name ? `${p.company_name} (${[p.contact_first_name, p.contact_last_name].filter(Boolean).join(" ")})` : [p.contact_first_name, p.contact_last_name].filter(Boolean).join(" "),
        }))}
        placeholder="None"
      />

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
        onClick={() => createQuote.mutate()}
        disabled={createQuote.isPending}
        className="mt-2 rounded-md bg-blue-700 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
      >
        {createQuote.isPending ? "Saving..." : "Create quote"}
      </button>
    </div>
  );
}

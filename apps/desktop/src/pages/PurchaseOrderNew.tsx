import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { createPurchaseOrderSchema, type JobCard, type PoLineItemInput, type SubcontractorCompany, type SubcontractorContact } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { SelectField } from "../components/FormField";
import { PoLineItemEditor } from "../components/subcontractors/PoLineItemEditor";

async function fetchSubcontractor(id: string): Promise<SubcontractorCompany> {
  const { data, error } = await supabase.from("subcontractor_companies").select("*").eq("id", id).single();
  if (error) throw error;
  return data as SubcontractorCompany;
}
async function fetchContacts(id: string): Promise<SubcontractorContact[]> {
  const { data, error } = await supabase.from("subcontractor_contacts").select("*").eq("subcontractor_id", id).order("first_name");
  if (error) throw error;
  return data as SubcontractorContact[];
}
async function fetchJobs(): Promise<JobCard[]> {
  const { data, error } = await supabase.from("job_cards").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobCard[];
}

// Workflow 2 (Direct Work Order) and Workflow 3 (Quote Request) share this
// one creation form - the spec's own description of both flows overlaps
// almost entirely (pick a job, pick a subcontractor + contact, describe the
// scope of work), differing only in the is_quote_request flag this page
// sets from the ?quoteRequest= query param and in what happens next on the
// detail page (send-for-quote vs send-as-issued).
export default function PurchaseOrderNewPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [searchParams] = useSearchParams();
  const subcontractorIdParam = searchParams.get("subcontractorId") ?? "";
  const isQuoteRequest = searchParams.get("quoteRequest") === "true";
  // Arriving from a job's own "Assign Subcontractor" action (?jobCardId=...)
  // pre-fills and locks the job, mirroring QuoteNew's lockedFromJob pattern.
  const jobCardIdParam = searchParams.get("jobCardId") ?? "";
  const lockedFromJob = !!jobCardIdParam;

  const { data: subcontractor } = useQuery({
    queryKey: ["subcontractor", subcontractorIdParam],
    queryFn: () => fetchSubcontractor(subcontractorIdParam),
    enabled: !!subcontractorIdParam,
  });
  const { data: contacts } = useQuery({
    queryKey: ["subcontractor-contacts", subcontractorIdParam],
    queryFn: () => fetchContacts(subcontractorIdParam),
    enabled: !!subcontractorIdParam,
  });
  const { data: jobs } = useQuery({ queryKey: ["jobs"], queryFn: fetchJobs });

  const [jobCardId, setJobCardId] = useState(jobCardIdParam);
  const [contactId, setContactId] = useState("");
  const [lineItems, setLineItems] = useState<PoLineItemInput[]>([{ description: "", quantity: 1, unit_cost_cents: 0 }]);
  const [formError, setFormError] = useState<string | null>(null);

  const complianceHold = subcontractor?.status === "compliance_hold";

  const create = useMutation({
    mutationFn: async () => {
      if (complianceHold) throw new Error("This subcontractor is on compliance hold and cannot receive new orders.");
      const result = createPurchaseOrderSchema.safeParse({
        job_card_id: jobCardId,
        subcontractor_id: subcontractorIdParam,
        contact_id: contactId || undefined,
        is_quote_request: isQuoteRequest,
        line_items: lineItems.filter((item) => item.description.trim().length > 0),
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");
      if (!profile) throw new Error("Not signed in");

      const totalCents = result.data.line_items.reduce((sum, item) => sum + Math.round(item.quantity * item.unit_cost_cents), 0);

      const { data: po, error } = await supabase
        .from("purchase_orders")
        .insert({
          tenant_id: profile.tenant_id,
          job_card_id: result.data.job_card_id,
          subcontractor_id: result.data.subcontractor_id,
          contact_id: result.data.contact_id ?? null,
          is_quote_request: result.data.is_quote_request,
          status: "draft",
          line_items: result.data.line_items,
          total_cost_cents: totalCents,
        })
        .select("id")
        .single();
      if (error) throw error;
      return po.id as string;
    },
    onSuccess: (id) => navigate(`/subcontractors/purchase-orders/${id}`),
    onError: (e) => setFormError(getErrorMessage(e, "Failed to create purchase order")),
  });

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-1 text-xl font-bold text-gray-900">{isQuoteRequest ? "New quote request" : "New work order"}</h1>
      <p className="mb-6 text-sm text-gray-500">{subcontractor?.company_name ?? "..."}</p>

      {complianceHold ? (
        <p className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-800">
          This subcontractor is on compliance hold - resolve their expired compliance documents before issuing new orders.
        </p>
      ) : null}

      <SelectField
        label="Job"
        value={jobCardId}
        onChange={(v) => !lockedFromJob && setJobCardId(v)}
        options={(jobs ?? []).map((j) => ({ value: j.id, label: j.title }))}
        placeholder="Select a job"
      />
      <SelectField
        label="Contact (optional)"
        value={contactId}
        onChange={setContactId}
        options={(contacts ?? []).map((c) => ({ value: c.id, label: `${c.first_name} ${c.last_name ?? ""}`.trim() + (c.is_primary_contact ? " (Primary)" : "") }))}
        placeholder="Use primary contact"
      />

      <h2 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-gray-500">
        {isQuoteRequest ? "Scope of work" : "Line items"}
      </h2>
      <PoLineItemEditor items={lineItems} onChange={setLineItems} />

      {formError ? <p className="mt-4 text-sm text-red-600">{formError}</p> : null}

      <button
        onClick={() => create.mutate()}
        disabled={create.isPending || !jobCardId || complianceHold}
        className="mt-4 rounded-md bg-blue-700 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
      >
        {create.isPending ? "Saving..." : isQuoteRequest ? "Create quote request" : "Create work order"}
      </button>
    </div>
  );
}

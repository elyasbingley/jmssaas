import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  createComplianceDocSchema,
  createSubcontractorContactSchema,
  formatCentsAsAud,
  type JobCard,
  type PurchaseOrder,
  type SubcontractorComplianceDoc,
  type SubcontractorContact,
  type SubcontractorDocType,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField, ThemedSelectField } from "../components/theme/ThemedFormField";
import { STATUS_BADGE, TIER_LABELS, TRADE_LABELS } from "./Subcontractors";

const BUCKET = "subcontractor-files";

type DetailTab = "contacts" | "orders" | "compliance" | "financials";

async function fetchSubcontractor(id: string) {
  const { data, error } = await supabase.from("subcontractor_companies").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}
async function fetchContacts(id: string): Promise<SubcontractorContact[]> {
  const { data, error } = await supabase.from("subcontractor_contacts").select("*").eq("subcontractor_id", id).order("first_name");
  if (error) throw error;
  return data as SubcontractorContact[];
}
async function fetchComplianceDocs(id: string): Promise<SubcontractorComplianceDoc[]> {
  const { data, error } = await supabase
    .from("subcontractor_compliance_docs")
    .select("*")
    .eq("subcontractor_id", id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as SubcontractorComplianceDoc[];
}
async function fetchPurchaseOrders(id: string): Promise<PurchaseOrder[]> {
  const { data, error } = await supabase
    .from("purchase_orders")
    .select("*")
    .eq("subcontractor_id", id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as PurchaseOrder[];
}
async function fetchJobs(): Promise<JobCard[]> {
  const { data, error } = await supabase.from("job_cards").select("*");
  if (error) throw error;
  return data as JobCard[];
}

const DOC_TYPE_OPTIONS: { value: SubcontractorDocType; label: string }[] = [
  { value: "public_liability", label: "Public Liability Insurance" },
  { value: "workers_comp", label: "Workers Compensation" },
  { value: "trade_license", label: "Trade License" },
  { value: "white_card", label: "White Card" },
  { value: "safety_induction", label: "Safety Induction" },
  { value: "other", label: "Other" },
];

export default function SubcontractorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DetailTab>("contacts");

  const { data: sub } = useQuery({ queryKey: ["subcontractor", id], queryFn: () => fetchSubcontractor(id!), enabled: !!id });
  const { data: contacts } = useQuery({ queryKey: ["subcontractor-contacts", id], queryFn: () => fetchContacts(id!), enabled: !!id });
  const { data: complianceDocs } = useQuery({ queryKey: ["subcontractor-compliance-docs", id], queryFn: () => fetchComplianceDocs(id!), enabled: !!id });
  const { data: purchaseOrders } = useQuery({ queryKey: ["subcontractor-pos", id], queryFn: () => fetchPurchaseOrders(id!), enabled: !!id });
  const { data: jobs } = useQuery({ queryKey: ["jobs"], queryFn: fetchJobs });

  const updateTier = useMutation({
    mutationFn: async (tier: number) => {
      const { error } = await supabase.from("subcontractor_companies").update({ preference_tier: tier }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["subcontractor", id] }),
  });

  if (!sub) {
    return (
      <div className="p-8" style={{ color: "var(--jms-text-muted)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}>
        Loading...
      </div>
    );
  }

  return (
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/subcontractors" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Subcontractors
      </Link>

      <div className="mb-6 rounded p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
              {sub.company_name}
            </h1>
            {sub.abn ? <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>ABN {sub.abn}</p> : null}
            <div className="mt-2 flex flex-wrap gap-1">
              {(sub.trades as string[]).map((t) => (
                <span
                  key={t}
                  className="rounded-full px-2 py-0.5 text-xs font-semibold"
                  style={{ backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)" }}
                >
                  {TRADE_LABELS[t as keyof typeof TRADE_LABELS]}
                </span>
              ))}
            </div>
          </div>
          <div className="text-right">
            <select
              value={sub.preference_tier}
              onChange={(e) => updateTier.mutate(Number(e.target.value))}
              className="rounded-md border px-3 py-1.5 font-semibold"
              style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
            >
              {[1, 2, 3, 4, 5].map((t) => (
                <option key={t} value={t}>
                  {TIER_LABELS[t]}
                </option>
              ))}
            </select>
            <div className="mt-2">
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_BADGE[sub.status as keyof typeof STATUS_BADGE].classes}`}>
                {STATUS_BADGE[sub.status as keyof typeof STATUS_BADGE].label}
              </span>
            </div>
          </div>
        </div>
        {sub.status === "compliance_hold" ? (
          <p
            className="mt-3 rounded p-3"
            style={{ border: "1px solid var(--jms-danger)", backgroundColor: "var(--jms-bg)", color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}
          >
            This subcontractor cannot receive new Purchase Orders or Work Orders until their expired compliance documents are renewed.
          </p>
        ) : null}
      </div>

      <div className="mb-6 flex gap-1" style={{ borderBottom: "1px solid var(--jms-border)" }}>
        {(
          [
            { key: "contacts", label: "Contacts" },
            { key: "orders", label: "Work Orders & Quote Requests" },
            { key: "compliance", label: "Compliance Records" },
            { key: "financials", label: "Financials & Jobs" },
          ] as { key: DetailTab; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="border-b-2 px-4 py-2 font-semibold uppercase tracking-wide"
            style={
              tab === t.key
                ? { borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                : { borderColor: "transparent", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "contacts" ? (
        <ContactsTab subcontractorId={id!} contacts={contacts ?? []} />
      ) : tab === "orders" ? (
        <OrdersTab
          subcontractorId={id!}
          purchaseOrders={purchaseOrders ?? []}
          jobs={jobs ?? []}
          complianceHold={sub.status === "compliance_hold"}
          onCreate={(isQuoteRequest) => navigate(`/subcontractors/purchase-orders/new?subcontractorId=${id}&quoteRequest=${isQuoteRequest}`)}
        />
      ) : tab === "compliance" ? (
        <ComplianceRecordsTab subcontractorId={id!} docs={complianceDocs ?? []} />
      ) : (
        <FinancialsJobsTab purchaseOrders={purchaseOrders ?? []} jobs={jobs ?? []} />
      )}
    </div>
  );
}

// --- Tab A: Contacts ---
function ContactsTab({ subcontractorId, contacts }: { subcontractorId: string; contacts: SubcontractorContact[] }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [workPhone, setWorkPhone] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openNew = () => {
    setFirstName("");
    setLastName("");
    setRoleTitle("");
    setEmail("");
    setMobile("");
    setWorkPhone("");
    setIsPrimary(contacts.length === 0);
    setError(null);
    setModalOpen(true);
  };

  const createContact = useMutation({
    mutationFn: async () => {
      const result = createSubcontractorContactSchema.safeParse({
        subcontractor_id: subcontractorId,
        first_name: firstName,
        last_name: lastName,
        role_title: roleTitle,
        email,
        mobile,
        work_phone: workPhone,
        is_primary_contact: isPrimary,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid contact");
      if (!profile) throw new Error("Not signed in");

      // Only one primary contact per subcontractor - clear the flag on any
      // existing primary first (no DB constraint enforcing this, handled
      // here since it needs two statements in the right order).
      if (result.data.is_primary_contact) {
        await supabase.from("subcontractor_contacts").update({ is_primary_contact: false }).eq("subcontractor_id", subcontractorId);
      }

      const { error: insertError } = await supabase.from("subcontractor_contacts").insert({
        tenant_id: profile.tenant_id,
        subcontractor_id: result.data.subcontractor_id,
        first_name: result.data.first_name,
        last_name: result.data.last_name || null,
        role_title: result.data.role_title || null,
        email: result.data.email,
        mobile: result.data.mobile || null,
        work_phone: result.data.work_phone || null,
        is_primary_contact: result.data.is_primary_contact,
      });
      if (insertError) throw insertError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subcontractor-contacts", subcontractorId] });
      queryClient.invalidateQueries({ queryKey: ["subcontractor-contacts"] });
      setModalOpen(false);
    },
    onError: (e) => setError(getErrorMessage(e, "Failed to add contact")),
  });

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <ThemedButton onClick={openNew} style={{ paddingBlock: 6, paddingInline: 12 }}>
          + Add Contact
        </ThemedButton>
      </div>
      {contacts.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No contacts yet.</p>
      ) : (
        <div className="space-y-2">
          {contacts.map((c) => (
            <div key={c.id} className="rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold" style={{ color: "var(--jms-text)" }}>
                    {c.first_name} {c.last_name ?? ""}{" "}
                    {c.is_primary_contact ? (
                      <span className="ml-1 font-semibold" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                        (Primary)
                      </span>
                    ) : null}
                  </p>
                  {c.role_title ? <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{c.role_title}</p> : null}
                </div>
                <div className="flex gap-3" style={{ fontSize: "var(--jms-font-body)" }}>
                  <a href={`mailto:${c.email}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                    {c.email}
                  </a>
                  {c.mobile ? (
                    <a href={`tel:${c.mobile}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                      {c.mobile}
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ThemedModal open={modalOpen} onClose={() => setModalOpen(false)} title="New contact">
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField label="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          <ThemedFormField label="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </div>
        <ThemedFormField label="Role / title" value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} placeholder="e.g. Lead Estimator" />
        <ThemedFormField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField label="Mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} />
          <ThemedFormField label="Work phone" value={workPhone} onChange={(e) => setWorkPhone(e.target.value)} />
        </div>
        <label className="mb-4 flex items-center gap-2 font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
          <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
          Primary contact
        </label>
        {error ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => createContact.mutate()} disabled={createContact.isPending}>
            {createContact.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}

// --- Tab B: Work Orders & Quote Requests ---
function OrdersTab({
  purchaseOrders,
  jobs,
  complianceHold,
  onCreate,
}: {
  subcontractorId: string;
  purchaseOrders: PurchaseOrder[];
  jobs: JobCard[];
  complianceHold: boolean;
  onCreate: (isQuoteRequest: boolean) => void;
}) {
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  return (
    <div>
      <div className="mb-4 flex justify-end gap-2">
        <button
          onClick={() => onCreate(true)}
          disabled={complianceHold}
          title={complianceHold ? "Cannot send: subcontractor is on compliance hold" : undefined}
          className="rounded-md border px-3 py-1.5 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          style={{ borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
        >
          Send Quote Request
        </button>
        <ThemedButton
          onClick={() => onCreate(false)}
          disabled={complianceHold}
          title={complianceHold ? "Cannot issue: subcontractor is on compliance hold" : undefined}
          style={{ paddingBlock: 6, paddingInline: 12 }}
        >
          Issue PO / Work Order
        </ThemedButton>
      </div>

      {purchaseOrders.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No purchase orders or quote requests yet.</p>
      ) : (
        <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead
              className="uppercase"
              style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
              <tr>
                <th className="px-4 py-2 font-semibold">PO Number</th>
                <th className="px-4 py-2 font-semibold">Type</th>
                <th className="px-4 py-2 font-semibold">Job</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 text-right font-semibold">Cost</th>
              </tr>
            </thead>
            <tbody>
              {purchaseOrders.map((po) => (
                <tr key={po.id} className="jms-nav-link last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                  <td className="px-4 py-3" style={{ color: "var(--jms-accent)" }}>
                    <Link to={`/subcontractors/purchase-orders/${po.id}`} className="font-medium hover:underline">
                      {po.po_number ?? "Pending"}
                    </Link>
                  </td>
                  <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                    {po.is_quote_request ? "Quote Request" : "Work Order"}
                  </td>
                  <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                    {jobById.get(po.job_card_id)?.title ?? "-"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className="rounded-full px-2 py-0.5 text-xs font-semibold"
                      style={{ backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)" }}
                    >
                      {po.status.charAt(0).toUpperCase() + po.status.slice(1)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold" style={{ color: "var(--jms-text)" }}>
                    {formatCentsAsAud(po.total_cost_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Tab C: Compliance Records ---
function ComplianceRecordsTab({ subcontractorId, docs }: { subcontractorId: string; docs: SubcontractorComplianceDoc[] }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [docType, setDocType] = useState<SubcontractorDocType>("public_liability");
  const [docNumber, setDocNumber] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fileToUpload, setFileToUpload] = useState<File | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["subcontractor-compliance-docs", subcontractorId] });
    queryClient.invalidateQueries({ queryKey: ["subcontractor", subcontractorId] });
    queryClient.invalidateQueries({ queryKey: ["subcontractors"] });
  };

  const uploadDoc = useMutation({
    mutationFn: async () => {
      if (!fileToUpload) throw new Error("Choose a file to upload");
      const result = createComplianceDocSchema.safeParse({
        subcontractor_id: subcontractorId,
        doc_type: docType,
        doc_number: docNumber,
        issue_date: issueDate || undefined,
        expiry_date: expiryDate || undefined,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid document");
      if (!profile) throw new Error("Not signed in");

      const ext = fileToUpload.name.split(".").pop()?.toLowerCase() || "pdf";
      const storagePath = `${profile.tenant_id}/${subcontractorId}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, fileToUpload, {
        contentType: fileToUpload.type || undefined,
      });
      if (uploadError) throw uploadError;

      const { error: insertError } = await supabase.from("subcontractor_compliance_docs").insert({
        tenant_id: profile.tenant_id,
        subcontractor_id: result.data.subcontractor_id,
        doc_type: result.data.doc_type,
        doc_number: result.data.doc_number || null,
        storage_path: storagePath,
        issue_date: result.data.issue_date || null,
        expiry_date: result.data.expiry_date || null,
      });
      if (insertError) throw insertError;
    },
    onSuccess: () => {
      invalidate();
      setDocNumber("");
      setIssueDate("");
      setExpiryDate("");
      setFileToUpload(null);
      setError(null);
      setUploading(false);
    },
    onError: (e) => {
      setError(getErrorMessage(e, "Failed to upload document"));
      setUploading(false);
    },
  });

  const toggleVerified = useMutation({
    mutationFn: async (doc: SubcontractorComplianceDoc) => {
      const { error: updateError } = await supabase
        .from("subcontractor_compliance_docs")
        .update({ is_verified: !doc.is_verified })
        .eq("id", doc.id);
      if (updateError) throw updateError;
    },
    onSuccess: invalidate,
  });

  const deleteDoc = useMutation({
    mutationFn: async (doc: SubcontractorComplianceDoc) => {
      await supabase.storage.from(BUCKET).remove([doc.storage_path]);
      const { error: deleteError } = await supabase.from("subcontractor_compliance_docs").delete().eq("id", doc.id);
      if (deleteError) throw deleteError;
    },
    onSuccess: invalidate,
  });

  const downloadDoc = async (doc: SubcontractorComplianceDoc) => {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(doc.storage_path, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  };

  return (
    <div>
      <div className="mb-6 rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <h2 className="mb-3 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Upload compliance document
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <ThemedSelectField label="Document type" value={docType} onChange={(v) => setDocType(v as SubcontractorDocType)} options={DOC_TYPE_OPTIONS} />
          <ThemedFormField label="Doc / policy number (optional)" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <ThemedFormField label="Issue date (optional)" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          <ThemedFormField label="Expiry date" type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
        </div>
        <input
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => setFileToUpload(e.target.files?.[0] ?? null)}
          className="mb-3"
          style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
        />
        {error ? (
          <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {error}
          </p>
        ) : null}
        <ThemedButton
          onClick={() => {
            setUploading(true);
            uploadDoc.mutate();
          }}
          disabled={uploading || !fileToUpload}
        >
          {uploading ? "Uploading..." : "Upload"}
        </ThemedButton>
      </div>

      {docs.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No compliance documents uploaded yet.</p>
      ) : (
        <div className="space-y-2">
          {docs.map((doc) => {
            const expired = doc.expiry_date ? new Date(`${doc.expiry_date}T00:00:00`) < new Date(new Date().toDateString()) : false;
            return (
              <div
                key={doc.id}
                className="flex items-center justify-between rounded p-4"
                style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
              >
                <div>
                  <p className="font-semibold" style={{ color: "var(--jms-text)" }}>
                    {DOC_TYPE_OPTIONS.find((o) => o.value === doc.doc_type)?.label}
                  </p>
                  {doc.doc_number ? <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>#{doc.doc_number}</p> : null}
                  {doc.expiry_date ? (
                    <p
                      className={expired ? "font-semibold" : ""}
                      style={{ color: expired ? "var(--jms-danger)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                    >
                      Expires {new Date(`${doc.expiry_date}T00:00:00`).toLocaleDateString("en-AU")}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                    <input type="checkbox" checked={doc.is_verified} onChange={() => toggleVerified.mutate(doc)} />
                    Verified
                  </label>
                  <button onClick={() => downloadDoc(doc)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                    View
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm("Delete this document?")) deleteDoc.mutate(doc);
                    }}
                    className="font-semibold hover:underline"
                    style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- Tab D: Financials & Jobs ---
function FinancialsJobsTab({ purchaseOrders, jobs }: { purchaseOrders: PurchaseOrder[]; jobs: JobCard[] }) {
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const realPos = purchaseOrders.filter((po) => !po.is_quote_request);

  return (
    <div>
      {realPos.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No purchase orders linked to jobs yet.</p>
      ) : (
        <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead
              className="uppercase"
              style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
              <tr>
                <th className="px-4 py-2 font-semibold">Job</th>
                <th className="px-4 py-2 font-semibold">PO Number</th>
                <th className="px-4 py-2 text-right font-semibold">Cost Paid</th>
                <th className="px-4 py-2 text-right font-semibold">Client Billed</th>
                <th className="px-4 py-2 text-right font-semibold">Gross Profit</th>
              </tr>
            </thead>
            <tbody>
              {realPos.map((po) => {
                const job = jobById.get(po.job_card_id);
                const billed = po.billed_to_client_cents ?? 0;
                const profit = billed - po.total_cost_cents;
                return (
                  <tr key={po.id} className="last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                    <td className="px-4 py-3">
                      {job ? (
                        <Link to={`/jobs/${job.id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                          {job.title}
                        </Link>
                      ) : (
                        <span style={{ color: "var(--jms-text-muted)" }}>-</span>
                      )}
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                      {po.po_number ?? "-"}
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--jms-text)" }}>
                      {formatCentsAsAud(po.total_cost_cents)}
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--jms-text)" }}>
                      {po.billed_to_client_cents != null ? formatCentsAsAud(billed) : "-"}
                    </td>
                    <td
                      className="px-4 py-3 text-right font-semibold"
                      style={{ color: po.billed_to_client_cents == null ? "var(--jms-text)" : profit < 0 ? "var(--jms-danger)" : "var(--jms-accent)" }}
                    >
                      {po.billed_to_client_cents != null ? formatCentsAsAud(profit) : "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

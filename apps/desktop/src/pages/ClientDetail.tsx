import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  createClientContactSchema,
  createClientSchema,
  createClientSiteSchema,
  createJobCardSchema,
  type Client,
  type ClientContact,
  type ClientSite,
  type JobCard,
  type JobLifecycleStage,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { formatClientAddress } from "../lib/format";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField, ThemedTextAreaField } from "../components/theme/ThemedFormField";
import { CommunicationLog } from "../components/CommunicationLog";
import { ClientMembershipSection } from "../components/ClientMembershipSection";
import { AssetsSection } from "../components/AssetsSection";

async function fetchClient(id: string): Promise<Client> {
  const { data, error } = await supabase.from("clients").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Client;
}

async function fetchClientJobs(clientId: string): Promise<JobCard[]> {
  const { data, error } = await supabase
    .from("job_cards")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobCard[];
}

async function fetchStages(): Promise<JobLifecycleStage[]> {
  const { data, error } = await supabase.from("job_lifecycle_stages").select("*").order("position");
  if (error) throw error;
  return data as JobLifecycleStage[];
}

// Just whether this client currently has an active membership - drives
// the "same-day response" reminder banner on the New Job form.
async function fetchIsActiveMember(clientId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("client_memberships")
    .select("id")
    .eq("client_id", clientId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

async function fetchClientContacts(clientId: string): Promise<ClientContact[]> {
  const { data, error } = await supabase
    .from("client_contacts")
    .select("*")
    .eq("client_id", clientId)
    .order("is_primary", { ascending: false })
    .order("name");
  if (error) throw error;
  return data as ClientContact[];
}

async function fetchClientSites(clientId: string): Promise<ClientSite[]> {
  const { data, error } = await supabase
    .from("client_sites")
    .select("*")
    .eq("client_id", clientId)
    .order("is_primary", { ascending: false })
    .order("label");
  if (error) throw error;
  return data as ClientSite[];
}

function formatSiteAddress(site: Pick<ClientSite, "address_line1" | "address_line2" | "suburb" | "state" | "postcode">): string {
  return [site.address_line1, site.address_line2, [site.suburb, site.state, site.postcode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
}

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: client } = useQuery({
    queryKey: ["client", id],
    queryFn: () => fetchClient(id!),
    enabled: !!id,
  });
  const { data: jobs } = useQuery({
    queryKey: ["client-jobs", id],
    queryFn: () => fetchClientJobs(id!),
    enabled: !!id,
  });
  const { data: stages } = useQuery({ queryKey: ["job-lifecycle-stages"], queryFn: fetchStages });
  const stageById = new Map((stages ?? []).map((s) => [s.id, s]));
  const { data: contacts } = useQuery({ queryKey: ["client-contacts", id], queryFn: () => fetchClientContacts(id!), enabled: !!id });
  const { data: sites } = useQuery({ queryKey: ["client-sites", id], queryFn: () => fetchClientSites(id!), enabled: !!id });
  const { data: isActiveMember } = useQuery({ queryKey: ["client-is-active-member", id], queryFn: () => fetchIsActiveMember(id!), enabled: !!id });

  // Manual tick - no public API to detect an actual Google review being
  // left, so this is purely office-driven (see the Google Reviews module's
  // own comment). Now also captures a star rating (feeds Analytics'
  // Customer Feedback section) - recorded_at is when the office ticked
  // this, not when the client actually left the review on Google.
  // Invalidating "google-review-clients" too so marking it here
  // immediately drops this client off that module's worklist.
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [pendingStars, setPendingStars] = useState(5);

  const openReviewModal = () => {
    setPendingStars(client?.google_review_stars ?? 5);
    setReviewModalOpen(true);
  };

  const saveReview = useMutation({
    mutationFn: async (stars: number) => {
      if (!id) return;
      const { error } = await supabase
        .from("clients")
        .update({ left_google_review: true, google_review_stars: stars, google_review_recorded_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client", id] });
      queryClient.invalidateQueries({ queryKey: ["google-review-clients"] });
      setReviewModalOpen(false);
    },
  });

  const removeReview = useMutation({
    mutationFn: async () => {
      if (!id) return;
      const { error } = await supabase
        .from("clients")
        .update({ left_google_review: false, google_review_stars: null, google_review_recorded_at: null })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client", id] });
      queryClient.invalidateQueries({ queryKey: ["google-review-clients"] });
    },
  });

  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    client_type: "individual" as "individual" | "company",
    company_name: "",
    name: "",
    phone: "",
    email: "",
    notes: "",
    address_line1: "",
    address_line2: "",
    suburb: "",
    state: "",
    postcode: "",
    workdrive_url: "",
  });
  const [editError, setEditError] = useState<string | null>(null);

  const openEdit = () => {
    if (!client) return;
    setEditForm({
      client_type: client.client_type,
      company_name: client.company_name ?? "",
      name: client.name,
      phone: client.phone ?? "",
      email: client.email ?? "",
      notes: client.notes ?? "",
      address_line1: client.address_line1 ?? "",
      address_line2: client.address_line2 ?? "",
      suburb: client.suburb ?? "",
      state: client.state ?? "",
      postcode: client.postcode ?? "",
      workdrive_url: client.workdrive_url ?? "",
    });
    setEditError(null);
    setEditOpen(true);
  };

  const saveEdit = useMutation({
    mutationFn: async () => {
      const result = createClientSchema.safeParse(editForm);
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid client");

      const { error } = await supabase
        .from("clients")
        .update({
          client_type: result.data.client_type,
          company_name: result.data.client_type === "company" ? result.data.company_name || null : null,
          name: result.data.name,
          phone: result.data.phone || null,
          email: result.data.email || null,
          notes: result.data.notes || null,
          address_line1: result.data.address_line1 || null,
          address_line2: result.data.address_line2 || null,
          suburb: result.data.suburb || null,
          state: result.data.state || null,
          postcode: result.data.postcode || null,
          workdrive_url: result.data.workdrive_url || null,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client", id] });
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      setEditOpen(false);
    },
    onError: (e) => setEditError(getErrorMessage(e, "Failed to save client")),
  });

  // --- Contacts ---
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState({ name: "", role: "", email: "", phone: "", is_primary: false });
  const [contactError, setContactError] = useState<string | null>(null);

  const openEditContact = (contact: ClientContact) => {
    setEditingContactId(contact.id);
    setContactForm({
      name: contact.name,
      role: contact.role ?? "",
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      is_primary: contact.is_primary,
    });
    setContactError(null);
    setContactModalOpen(true);
  };

  const saveContact = useMutation({
    mutationFn: async () => {
      const result = createClientContactSchema.safeParse({ ...contactForm, client_id: id });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid contact");
      if (!profile) throw new Error("Not signed in");
      const payload = {
        name: result.data.name,
        role: result.data.role || null,
        email: result.data.email || null,
        phone: result.data.phone || null,
        is_primary: result.data.is_primary,
      };
      if (editingContactId) {
        const { error } = await supabase.from("client_contacts").update(payload).eq("id", editingContactId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("client_contacts").insert({ tenant_id: profile.tenant_id, client_id: id, ...payload });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-contacts", id] });
      setContactModalOpen(false);
      setEditingContactId(null);
      setContactForm({ name: "", role: "", email: "", phone: "", is_primary: false });
      setContactError(null);
    },
    onError: (e) => setContactError(getErrorMessage(e, "Failed to save contact")),
  });

  const deleteContact = useMutation({
    mutationFn: async (contactId: string) => {
      const { error } = await supabase.from("client_contacts").delete().eq("id", contactId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["client-contacts", id] }),
  });

  // --- Addresses (client sites) ---
  const [siteModalOpen, setSiteModalOpen] = useState(false);
  const [siteForm, setSiteForm] = useState({
    label: "",
    address_line1: "",
    address_line2: "",
    suburb: "",
    state: "",
    postcode: "",
    is_primary: false,
    notes: "",
  });
  const [siteError, setSiteError] = useState<string | null>(null);

  const saveSite = useMutation({
    mutationFn: async () => {
      const result = createClientSiteSchema.safeParse({ ...siteForm, client_id: id });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid address");
      if (!profile) throw new Error("Not signed in");
      const { error } = await supabase.from("client_sites").insert({
        tenant_id: profile.tenant_id,
        client_id: id,
        label: result.data.label || null,
        address_line1: result.data.address_line1,
        address_line2: result.data.address_line2 || null,
        suburb: result.data.suburb,
        state: result.data.state,
        postcode: result.data.postcode,
        is_primary: result.data.is_primary,
        notes: result.data.notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client-sites", id] });
      setSiteModalOpen(false);
      setSiteForm({ label: "", address_line1: "", address_line2: "", suburb: "", state: "", postcode: "", is_primary: false, notes: "" });
      setSiteError(null);
    },
    onError: (e) => setSiteError(getErrorMessage(e, "Failed to save address")),
  });

  const deleteSite = useMutation({
    mutationFn: async (siteId: string) => {
      const { error } = await supabase.from("client_sites").delete().eq("id", siteId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["client-sites", id] }),
  });

  const [newJobOpen, setNewJobOpen] = useState(false);
  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  // "" = use the client's primary address, "new" = show the inline address
  // fields below (saved to client_sites first), anything else = an existing
  // client_sites.id - the same "pick from the price book or add a new item"
  // pattern AddLineItemBar already uses, just for addresses instead of
  // catalogue items.
  const [jobSiteChoice, setJobSiteChoice] = useState<string>("");
  const [newSiteForm, setNewSiteForm] = useState({ label: "", address_line1: "", address_line2: "", suburb: "", state: "", postcode: "" });
  const [jobError, setJobError] = useState<string | null>(null);

  const createJob = useMutation({
    mutationFn: async () => {
      const result = createJobCardSchema.safeParse({ client_id: id, title: jobTitle, description: jobDescription });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid job");
      if (!profile) throw new Error("Not signed in");

      let siteId: string | null = jobSiteChoice && jobSiteChoice !== "new" ? jobSiteChoice : null;
      if (jobSiteChoice === "new") {
        const siteResult = createClientSiteSchema.safeParse({ ...newSiteForm, client_id: id });
        if (!siteResult.success) throw new Error(siteResult.error.issues[0]?.message ?? "Enter a valid new address");
        const { data: newSite, error: siteInsertError } = await supabase
          .from("client_sites")
          .insert({
            tenant_id: profile.tenant_id,
            client_id: id,
            label: siteResult.data.label || null,
            address_line1: siteResult.data.address_line1,
            address_line2: siteResult.data.address_line2 || null,
            suburb: siteResult.data.suburb,
            state: siteResult.data.state,
            postcode: siteResult.data.postcode,
          })
          .select("id")
          .single();
        if (siteInsertError) throw siteInsertError;
        siteId = newSite.id as string;
      }

      const { data, error } = await supabase
        .from("job_cards")
        .insert({
          tenant_id: profile.tenant_id,
          client_id: id,
          site_id: siteId,
          title: result.data.title,
          description: result.data.description || null,
          created_by: profile.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data as JobCard;
    },
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ["client-jobs", id] });
      queryClient.invalidateQueries({ queryKey: ["client-sites", id] });
      navigate(`/jobs/${job.id}`);
    },
    onError: (e) => setJobError(getErrorMessage(e, "Failed to create job")),
  });

  if (!client) {
    return (
      <div className="p-8" style={{ color: "var(--jms-text-muted)", fontFamily: "var(--jms-font)", fontSize: "var(--jms-font-body)" }}>
        Loading...
      </div>
    );
  }

  const address = formatClientAddress(client);

  return (
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/clients" className="mb-4 inline-block hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        &larr; Back to Clients
      </Link>

      <div className="mb-6 flex items-start justify-between rounded p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <div>
          {client.client_type === "company" && client.company_name ? (
            <>
              <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
                {client.company_name}
              </h1>
              <p className="font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                Primary contact: {client.name}
              </p>
            </>
          ) : (
            <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
              {client.name}
            </h1>
          )}
          {client.phone ? (
            <p className="mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              {client.phone}
            </p>
          ) : null}
          {client.email ? (
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>{client.email}</p>
          ) : null}
          {address ? <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>{address}</p> : null}
          {client.notes ? (
            <p className="mt-2" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
              {client.notes}
            </p>
          ) : null}
          {client.workdrive_url ? (
            <a
              href={client.workdrive_url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block font-semibold hover:underline"
              style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}
            >
              Open WorkDrive folder &rarr;
            </a>
          ) : null}
          <div className="mt-3 flex items-center gap-3">
            {client.left_google_review ? (
              <>
                <span className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                  Left a Google review{" "}
                  <span style={{ color: "var(--jms-warning)" }} title={`${client.google_review_stars ?? 0}/5 stars`}>
                    {"★".repeat(client.google_review_stars ?? 0)}
                    {"☆".repeat(5 - (client.google_review_stars ?? 0))}
                  </span>
                </span>
                <button onClick={openReviewModal} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
                  Change
                </button>
                <button onClick={() => removeReview.mutate()} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
                  Remove
                </button>
              </>
            ) : (
              <button onClick={openReviewModal} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
                Mark as left a Google review
              </button>
            )}
          </div>
        </div>
        <button onClick={openEdit} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
          Edit
        </button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4">
        <div className="rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
              Contacts
            </h2>
            <button
              onClick={() => {
                setEditingContactId(null);
                setContactForm({ name: "", role: "", email: "", phone: "", is_primary: false });
                setContactError(null);
                setContactModalOpen(true);
              }}
              className="font-semibold hover:underline"
              style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
            >
              + Add contact
            </button>
          </div>
          {!contacts || contacts.length === 0 ? (
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No extra contacts yet.</p>
          ) : (
            <div className="space-y-2">
              {contacts.map((contact) => (
                <div key={contact.id} className="flex items-start justify-between rounded p-2" style={{ backgroundColor: "var(--jms-bg)" }}>
                  <div>
                    <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                      {contact.name}
                      {contact.is_primary ? (
                        <span className="ml-1 font-normal" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                          (primary)
                        </span>
                      ) : null}
                    </p>
                    {contact.role ? <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{contact.role}</p> : null}
                    {contact.email ? <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{contact.email}</p> : null}
                    {contact.phone ? <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{contact.phone}</p> : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => openEditContact(contact)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                      Edit
                    </button>
                    <button onClick={() => deleteContact.mutate(contact.id)} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
              Addresses
            </h2>
            <button onClick={() => setSiteModalOpen(true)} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
              + Add address
            </button>
          </div>
          {address ? (
            <div className="mb-2 rounded p-2" style={{ backgroundColor: "var(--jms-bg)" }}>
              <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                Main address
              </p>
              <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{address}</p>
            </div>
          ) : null}
          {!sites || sites.length === 0 ? (
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No other addresses saved.</p>
          ) : (
            <div className="space-y-2">
              {sites.map((site) => (
                <div key={site.id} className="flex items-start justify-between rounded p-2" style={{ backgroundColor: "var(--jms-bg)" }}>
                  <div>
                    <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                      {site.label || "Site address"}
                      {site.is_primary ? (
                        <span className="ml-1 font-normal" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                          (primary)
                        </span>
                      ) : null}
                    </p>
                    <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{formatSiteAddress(site)}</p>
                  </div>
                  <button onClick={() => deleteSite.mutate(site.id)} className="font-semibold hover:underline" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
          Jobs
        </h2>
        <ThemedButton
          onClick={() => {
            setJobSiteChoice("");
            setNewJobOpen(true);
          }}
          style={{ paddingBlock: 6, paddingInline: 12 }}
        >
          + New job
        </ThemedButton>
      </div>

      <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {!jobs || jobs.length === 0 ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No jobs yet for this client.
          </p>
        ) : (
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead
              className="uppercase"
              style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
              <tr>
                <th className="px-4 py-2 font-semibold">Number</th>
                <th className="px-4 py-2 font-semibold">Title</th>
                <th className="px-4 py-2 font-semibold">Stage</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const stage = stageById.get(job.lifecycle_stage_id ?? "");
                return (
                  <tr key={job.id} className="jms-nav-link last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                    <td className="px-4 py-3" style={{ color: "var(--jms-accent)" }}>
                      <Link to={`/jobs/${job.id}`} className="hover:underline">
                        {job.number ?? "Pending"}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link to={`/jobs/${job.id}`} className="font-medium hover:underline" style={{ color: "var(--jms-text)" }}>
                        {job.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                      {stage?.name ?? ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <ClientMembershipSection clientId={id!} />

      <AssetsSection owner={{ type: "client", id: id! }} />

      <div className="mt-6 rounded p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        <h2 className="mb-3 font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
          Communication Log
        </h2>
        <CommunicationLog entities={(jobs ?? []).map((job) => ({ entityType: "job" as const, entityId: job.id }))} />
      </div>

      <ThemedModal open={editOpen} onClose={() => setEditOpen(false)} title="Edit client">
        <div className="mb-4 flex gap-2">
          <button
            type="button"
            onClick={() => setEditForm({ ...editForm, client_type: "individual" })}
            className="flex-1 rounded border px-3 py-2 font-semibold"
            style={
              editForm.client_type === "individual"
                ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)" }
                : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)" }
            }
          >
            Individual / COD
          </button>
          <button
            type="button"
            onClick={() => setEditForm({ ...editForm, client_type: "company" })}
            className="flex-1 rounded border px-3 py-2 font-semibold"
            style={
              editForm.client_type === "company"
                ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)" }
                : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)" }
            }
          >
            Company
          </button>
        </div>
        {editForm.client_type === "company" ? (
          <ThemedFormField
            label="Company name"
            value={editForm.company_name}
            onChange={(e) => setEditForm({ ...editForm, company_name: e.target.value })}
          />
        ) : null}
        <ThemedFormField
          label={editForm.client_type === "company" ? "Primary contact full name" : "Full name"}
          value={editForm.name}
          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
        />
        <ThemedFormField
          label="Phone"
          value={editForm.phone}
          onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
        />
        <ThemedFormField
          label="Email"
          type="email"
          value={editForm.email}
          onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
        />
        <ThemedFormField
          label="Address line 1"
          value={editForm.address_line1}
          onChange={(e) => setEditForm({ ...editForm, address_line1: e.target.value })}
        />
        <ThemedFormField
          label="Address line 2"
          value={editForm.address_line2}
          onChange={(e) => setEditForm({ ...editForm, address_line2: e.target.value })}
        />
        <div className="grid grid-cols-3 gap-3">
          <ThemedFormField
            label="Suburb"
            value={editForm.suburb}
            onChange={(e) => setEditForm({ ...editForm, suburb: e.target.value })}
          />
          <ThemedFormField
            label="State"
            value={editForm.state}
            onChange={(e) => setEditForm({ ...editForm, state: e.target.value })}
          />
          <ThemedFormField
            label="Postcode"
            value={editForm.postcode}
            onChange={(e) => setEditForm({ ...editForm, postcode: e.target.value })}
          />
        </div>
        <ThemedTextAreaField
          label="Notes"
          rows={3}
          value={editForm.notes}
          onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
        />
        <ThemedFormField
          label="WorkDrive link (optional)"
          value={editForm.workdrive_url}
          onChange={(e) => setEditForm({ ...editForm, workdrive_url: e.target.value })}
          placeholder="https://workdrive.zoho.com/..."
        />
        {editError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {editError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setEditOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveEdit.mutate()} disabled={saveEdit.isPending}>
            {saveEdit.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal
        open={contactModalOpen}
        onClose={() => {
          setContactModalOpen(false);
          setEditingContactId(null);
        }}
        title={editingContactId ? "Edit contact" : "Add contact"}
      >
        <ThemedFormField label="Name" value={contactForm.name} onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })} />
        <ThemedFormField
          label="Role (optional)"
          value={contactForm.role}
          onChange={(e) => setContactForm({ ...contactForm, role: e.target.value })}
          placeholder="e.g. Office manager"
        />
        <ThemedFormField
          label="Email"
          type="email"
          value={contactForm.email}
          onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
        />
        <ThemedFormField label="Phone" value={contactForm.phone} onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })} />
        <label className="mb-4 flex items-center gap-2 font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
          <input
            type="checkbox"
            checked={contactForm.is_primary}
            onChange={(e) => setContactForm({ ...contactForm, is_primary: e.target.checked })}
          />
          Primary contact
        </label>
        {contactError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {contactError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button
            onClick={() => {
              setContactModalOpen(false);
              setEditingContactId(null);
            }}
            className="px-4 py-2 font-semibold"
            style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
          >
            Cancel
          </button>
          <ThemedButton onClick={() => saveContact.mutate()} disabled={saveContact.isPending}>
            {saveContact.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal open={siteModalOpen} onClose={() => setSiteModalOpen(false)} title="Add address">
        <ThemedFormField
          label="Label (optional)"
          value={siteForm.label}
          onChange={(e) => setSiteForm({ ...siteForm, label: e.target.value })}
          placeholder="e.g. Warehouse, Shop 4"
        />
        <ThemedFormField
          label="Address line 1"
          value={siteForm.address_line1}
          onChange={(e) => setSiteForm({ ...siteForm, address_line1: e.target.value })}
        />
        <ThemedFormField
          label="Address line 2"
          value={siteForm.address_line2}
          onChange={(e) => setSiteForm({ ...siteForm, address_line2: e.target.value })}
        />
        <div className="grid grid-cols-3 gap-3">
          <ThemedFormField label="Suburb" value={siteForm.suburb} onChange={(e) => setSiteForm({ ...siteForm, suburb: e.target.value })} />
          <ThemedFormField label="State" value={siteForm.state} onChange={(e) => setSiteForm({ ...siteForm, state: e.target.value })} />
          <ThemedFormField
            label="Postcode"
            value={siteForm.postcode}
            onChange={(e) => setSiteForm({ ...siteForm, postcode: e.target.value })}
          />
        </div>
        <label className="mb-4 flex items-center gap-2 font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
          <input
            type="checkbox"
            checked={siteForm.is_primary}
            onChange={(e) => setSiteForm({ ...siteForm, is_primary: e.target.checked })}
          />
          Mark as primary site address
        </label>
        {siteError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {siteError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setSiteModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveSite.mutate()} disabled={saveSite.isPending}>
            {saveSite.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal open={newJobOpen} onClose={() => setNewJobOpen(false)} title="New job">
        <div className="mb-4 rounded p-3" style={{ backgroundColor: "var(--jms-bg)" }}>
          <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            {client.client_type === "company" && client.company_name ? client.company_name : client.name}
          </p>
          {client.phone ? <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{client.phone}</p> : null}
        </div>
        {isActiveMember ? (
          <p
            className="mb-4 rounded px-3 py-2 font-semibold"
            style={{ border: "1px solid var(--jms-accent)", backgroundColor: "var(--jms-accent-glow)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
          >
            This client is a Member - remember the same-day response guarantee.
          </p>
        ) : null}
        <ThemedFormField label="Title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
        <ThemedTextAreaField label="Description" rows={3} value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} />

        <div className="mb-4">
          <label className="mb-1 block font-semibold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            Job address
          </label>
          <select
            value={jobSiteChoice}
            onChange={(e) => setJobSiteChoice(e.target.value)}
            className="w-full rounded border px-3 py-2 focus:outline-none"
            style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
          >
            <option value="">{address ? `Client's main address (${address})` : "Client's main address (none on file)"}</option>
            {(sites ?? []).map((site) => (
              <option key={site.id} value={site.id}>
                {site.label || "Site"} - {formatSiteAddress(site)}
              </option>
            ))}
            <option value="new">+ Add a new address...</option>
          </select>
        </div>
        {jobSiteChoice === "new" ? (
          <div className="mb-4 rounded p-3" style={{ border: "1px solid var(--jms-border)" }}>
            <p className="mb-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              This address will be saved to {client.client_type === "company" && client.company_name ? client.company_name : client.name}'s card.
            </p>
            <ThemedFormField
              label="Label (optional)"
              value={newSiteForm.label}
              onChange={(e) => setNewSiteForm({ ...newSiteForm, label: e.target.value })}
              placeholder="e.g. Warehouse, Shop 4"
            />
            <ThemedFormField
              label="Address line 1"
              value={newSiteForm.address_line1}
              onChange={(e) => setNewSiteForm({ ...newSiteForm, address_line1: e.target.value })}
            />
            <ThemedFormField
              label="Address line 2"
              value={newSiteForm.address_line2}
              onChange={(e) => setNewSiteForm({ ...newSiteForm, address_line2: e.target.value })}
            />
            <div className="grid grid-cols-3 gap-3">
              <ThemedFormField
                label="Suburb"
                value={newSiteForm.suburb}
                onChange={(e) => setNewSiteForm({ ...newSiteForm, suburb: e.target.value })}
              />
              <ThemedFormField
                label="State"
                value={newSiteForm.state}
                onChange={(e) => setNewSiteForm({ ...newSiteForm, state: e.target.value })}
              />
              <ThemedFormField
                label="Postcode"
                value={newSiteForm.postcode}
                onChange={(e) => setNewSiteForm({ ...newSiteForm, postcode: e.target.value })}
              />
            </div>
          </div>
        ) : null}

        {jobError ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {jobError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setNewJobOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => createJob.mutate()} disabled={createJob.isPending}>
            {createJob.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>

      <ThemedModal open={reviewModalOpen} onClose={() => setReviewModalOpen(false)} title="Google review rating">
        <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          How many stars did this client leave?
        </p>
        <div className="mb-4 flex justify-center gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => setPendingStars(n)}
              className="text-3xl"
              style={{ color: n <= pendingStars ? "var(--jms-warning)" : "var(--jms-border)" }}
              aria-label={`${n} star${n === 1 ? "" : "s"}`}
            >
              ★
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-3">
          <button onClick={() => setReviewModalOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={() => saveReview.mutate(pendingStars)} disabled={saveReview.isPending}>
            {saveReview.isPending ? "Saving..." : "Save"}
          </ThemedButton>
        </div>
      </ThemedModal>
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createClientSchema, createJobCardSchema, type Client, type JobCard, type JobStatus } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { formatClientAddress } from "../lib/format";
import { Modal } from "../components/Modal";
import { FormField, TextAreaField } from "../components/FormField";

const STATUS_LABELS: Record<JobStatus, string> = {
  new: "New",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  invoiced: "Invoiced",
};

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

  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    phone: "",
    email: "",
    notes: "",
    address_line1: "",
    address_line2: "",
    suburb: "",
    state: "",
    postcode: "",
  });
  const [editError, setEditError] = useState<string | null>(null);

  const openEdit = () => {
    if (!client) return;
    setEditForm({
      name: client.name,
      phone: client.phone ?? "",
      email: client.email ?? "",
      notes: client.notes ?? "",
      address_line1: client.address_line1 ?? "",
      address_line2: client.address_line2 ?? "",
      suburb: client.suburb ?? "",
      state: client.state ?? "",
      postcode: client.postcode ?? "",
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
          name: result.data.name,
          phone: result.data.phone || null,
          email: result.data.email || null,
          notes: result.data.notes || null,
          address_line1: result.data.address_line1 || null,
          address_line2: result.data.address_line2 || null,
          suburb: result.data.suburb || null,
          state: result.data.state || null,
          postcode: result.data.postcode || null,
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

  const [newJobOpen, setNewJobOpen] = useState(false);
  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [jobError, setJobError] = useState<string | null>(null);

  const createJob = useMutation({
    mutationFn: async () => {
      const result = createJobCardSchema.safeParse({ client_id: id, title: jobTitle, description: jobDescription });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid job");
      if (!profile) throw new Error("Not signed in");

      const { data, error } = await supabase
        .from("job_cards")
        .insert({
          tenant_id: profile.tenant_id,
          client_id: id,
          title: result.data.title,
          description: result.data.description || null,
          status: "new",
          created_by: profile.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data as JobCard;
    },
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ["client-jobs", id] });
      navigate(`/jobs/${job.id}`);
    },
    onError: (e) => setJobError(getErrorMessage(e, "Failed to create job")),
  });

  if (!client) {
    return <div className="p-8 text-sm text-gray-500">Loading...</div>;
  }

  const address = formatClientAddress(client);

  return (
    <div className="p-8">
      <Link to="/clients" className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to Clients
      </Link>

      <div className="mb-6 flex items-start justify-between rounded-lg border border-gray-200 bg-white p-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{client.name}</h1>
          {client.phone ? <p className="mt-1 text-sm text-gray-600">{client.phone}</p> : null}
          {client.email ? <p className="text-sm text-gray-600">{client.email}</p> : null}
          {address ? <p className="text-sm text-gray-600">{address}</p> : null}
          {client.notes ? <p className="mt-2 text-sm text-gray-700">{client.notes}</p> : null}
        </div>
        <button onClick={openEdit} className="text-sm font-semibold text-blue-700 hover:underline">
          Edit
        </button>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Jobs</h2>
        <button
          onClick={() => setNewJobOpen(true)}
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + New job
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {!jobs || jobs.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No jobs yet for this client.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Number</th>
                <th className="px-4 py-2 font-semibold">Title</th>
                <th className="px-4 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-blue-700">
                    <Link to={`/jobs/${job.id}`} className="hover:underline">
                      {job.number ?? "Pending"}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/jobs/${job.id}`} className="font-medium hover:underline">
                      {job.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{STATUS_LABELS[job.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit client">
        <FormField label="Name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
        <FormField
          label="Phone"
          value={editForm.phone}
          onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
        />
        <FormField
          label="Email"
          type="email"
          value={editForm.email}
          onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
        />
        <FormField
          label="Address line 1"
          value={editForm.address_line1}
          onChange={(e) => setEditForm({ ...editForm, address_line1: e.target.value })}
        />
        <FormField
          label="Address line 2"
          value={editForm.address_line2}
          onChange={(e) => setEditForm({ ...editForm, address_line2: e.target.value })}
        />
        <div className="grid grid-cols-3 gap-3">
          <FormField
            label="Suburb"
            value={editForm.suburb}
            onChange={(e) => setEditForm({ ...editForm, suburb: e.target.value })}
          />
          <FormField
            label="State"
            value={editForm.state}
            onChange={(e) => setEditForm({ ...editForm, state: e.target.value })}
          />
          <FormField
            label="Postcode"
            value={editForm.postcode}
            onChange={(e) => setEditForm({ ...editForm, postcode: e.target.value })}
          />
        </div>
        <TextAreaField
          label="Notes"
          rows={3}
          value={editForm.notes}
          onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
        />
        {editError ? <p className="mb-4 text-sm text-red-600">{editError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setEditOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveEdit.mutate()}
            disabled={saveEdit.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveEdit.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal open={newJobOpen} onClose={() => setNewJobOpen(false)} title="New job">
        <div className="mb-4 rounded-md bg-gray-50 p-3 text-sm">
          <p className="font-semibold text-gray-900">{client.name}</p>
          {client.phone ? <p className="text-gray-600">{client.phone}</p> : null}
        </div>
        <FormField label="Title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
        <TextAreaField label="Description" rows={3} value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} />
        {jobError ? <p className="mb-4 text-sm text-red-600">{jobError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setNewJobOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createJob.mutate()}
            disabled={createJob.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createJob.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

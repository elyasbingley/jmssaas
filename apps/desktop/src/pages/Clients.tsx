import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createClientSchema, type Client } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField } from "../components/FormField";

async function fetchClients(): Promise<Client[]> {
  const { data, error } = await supabase.from("clients").select("*").order("name");
  if (error) throw error;
  return data as Client[];
}

const emptyForm = {
  client_type: "individual" as "individual" | "company",
  company_name: "",
  name: "",
  phone: "",
  email: "",
  address_line1: "",
  address_line2: "",
  suburb: "",
  state: "",
  postcode: "",
  workdrive_url: "",
};

export default function ClientsPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data: clients, isLoading } = useQuery({ queryKey: ["clients"], queryFn: fetchClients });

  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const createClient = useMutation({
    mutationFn: async () => {
      const result = createClientSchema.safeParse(form);
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid client");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("clients").insert({
        tenant_id: profile.tenant_id,
        client_type: result.data.client_type,
        company_name: result.data.client_type === "company" ? result.data.company_name || null : null,
        name: result.data.name,
        phone: result.data.phone || null,
        email: result.data.email || null,
        address_line1: result.data.address_line1 || null,
        address_line2: result.data.address_line2 || null,
        suburb: result.data.suburb || null,
        state: result.data.state || null,
        postcode: result.data.postcode || null,
        workdrive_url: result.data.workdrive_url || null,
        created_by: profile.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      setModalOpen(false);
      setForm(emptyForm);
      setFormError(null);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to create client")),
  });

  const filteredClients = (clients ?? []).filter((c) =>
    `${c.company_name ?? ""} ${c.name}`.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Clients</h1>
          <p className="text-sm text-gray-500">{clients?.length ?? 0} clients</p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + New client
        </button>
      </div>

      <input
        type="text"
        placeholder="Search clients..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-4 w-full max-w-sm rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />

      <div className="overflow-hidden rounded-lg border border-gray-300 bg-white">
        {isLoading ? (
          <p className="p-6 text-sm text-gray-500">Loading...</p>
        ) : filteredClients.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No clients found.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-300 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Name</th>
                <th className="px-4 py-2 font-semibold">Phone</th>
                <th className="px-4 py-2 font-semibold">Email</th>
              </tr>
            </thead>
            <tbody>
              {filteredClients.map((client) => (
                <tr key={client.id} className="border-b border-gray-200 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link to={`/clients/${client.id}`} className="font-medium text-blue-700 hover:underline">
                      {client.client_type === "company" && client.company_name ? client.company_name : client.name}
                    </Link>
                    {client.client_type === "company" ? (
                      <p className="text-xs text-gray-500">Contact: {client.name}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{client.phone ?? "-"}</td>
                  <td className="px-4 py-3 text-gray-600">{client.email ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New client">
        <div className="mb-4 flex gap-2">
          <button
            type="button"
            onClick={() => setForm({ ...form, client_type: "individual" })}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-semibold ${
              form.client_type === "individual" ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"
            }`}
          >
            Individual / COD
          </button>
          <button
            type="button"
            onClick={() => setForm({ ...form, client_type: "company" })}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-semibold ${
              form.client_type === "company" ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"
            }`}
          >
            Company
          </button>
        </div>
        {form.client_type === "company" ? (
          <FormField
            label="Company name"
            value={form.company_name}
            onChange={(e) => setForm({ ...form, company_name: e.target.value })}
            placeholder="e.g. Copano Property Services"
          />
        ) : null}
        <FormField
          label={form.client_type === "company" ? "Primary contact full name" : "Full name"}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder={form.client_type === "company" ? "e.g. Andrew Smith" : undefined}
        />
        <FormField label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <FormField
          label="Email"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <FormField
          label="Address line 1"
          value={form.address_line1}
          onChange={(e) => setForm({ ...form, address_line1: e.target.value })}
        />
        <FormField
          label="Address line 2"
          value={form.address_line2}
          onChange={(e) => setForm({ ...form, address_line2: e.target.value })}
        />
        <div className="grid grid-cols-3 gap-3">
          <FormField label="Suburb" value={form.suburb} onChange={(e) => setForm({ ...form, suburb: e.target.value })} />
          <FormField label="State" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
          <FormField
            label="Postcode"
            value={form.postcode}
            onChange={(e) => setForm({ ...form, postcode: e.target.value })}
          />
        </div>
        <FormField
          label="WorkDrive link (optional)"
          value={form.workdrive_url}
          onChange={(e) => setForm({ ...form, workdrive_url: e.target.value })}
          placeholder="https://workdrive.zoho.com/..."
        />
        {formError ? <p className="mb-4 text-sm text-red-600">{formError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createClient.mutate()}
            disabled={createClient.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createClient.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

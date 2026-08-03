import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { createTechnicianSchema, type Profile } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField } from "../components/FormField";

async function fetchTechnicians(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").eq("role", "technician").order("full_name");
  if (error) throw error;
  return data as Profile[];
}

const emptyForm = { fullName: "", email: "", password: "" };

export default function TeamPage() {
  const queryClient = useQueryClient();
  const { data: technicians, isLoading } = useQuery({ queryKey: ["technicians"], queryFn: fetchTechnicians });

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const createTechnician = useMutation({
    mutationFn: async () => {
      const result = createTechnicianSchema.safeParse({ full_name: form.fullName, email: form.email, password: form.password });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");

      const { error } = await supabase.functions.invoke("create-technician", { body: result.data });
      if (error) {
        // FunctionsHttpError means the function itself ran and returned a
        // structured {error: "..."} body (see
        // supabase/functions/create-technician) - map the cases an admin
        // will actually hit to a clear message. Never log the password.
        let code: string | undefined;
        if (error instanceof FunctionsHttpError) {
          try {
            const body = await error.context.json();
            code = body?.error;
          } catch {
            // response wasn't JSON - fall through to the generic message
          }
        }
        if (code === "email_taken") throw new Error("That email is already in use by another account.");
        if (code === "weak_password") throw new Error("Choose a stronger password.");
        if (code === "forbidden" || code === "unauthorized") throw new Error("You don't have permission to create technicians.");
        throw new Error(getErrorMessage(error, "Failed to create technician"));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["technicians"] });
      setModalOpen(false);
      setForm(emptyForm);
      setFormError(null);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to create technician")),
  });

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Team</h1>
          <p className="text-sm text-gray-500">Technicians who can sign in to the mobile app.</p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + New technician
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {isLoading ? (
          <p className="p-6 text-sm text-gray-500">Loading...</p>
        ) : !technicians || technicians.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No technicians yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Name</th>
                <th className="px-4 py-2 font-semibold">Email</th>
              </tr>
            </thead>
            <tbody>
              {technicians.map((tech) => (
                <tr key={tech.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 font-medium text-gray-900">{tech.full_name}</td>
                  <td className="px-4 py-3 text-gray-600">{tech.email}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setFormError(null);
        }}
        title="New technician"
      >
        <FormField label="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} placeholder="e.g. Sam Taylor" />
        <FormField
          label="Email"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder="sam@example.com"
        />
        <FormField
          label="Password"
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          placeholder="At least 8 characters"
        />
        {formError ? <p className="mb-4 text-sm text-red-600">{formError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createTechnician.mutate()}
            disabled={createTechnician.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createTechnician.isPending ? "Creating..." : "Create"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

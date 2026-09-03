import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { createTechnicianSchema, type Profile } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField } from "../components/FormField";

async function fetchTeamMembers(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").order("full_name");
  if (error) throw error;
  return data as Profile[];
}

const emptyForm = { fullName: "", email: "", password: "" };
const ROLE_LABELS: Record<Profile["role"], string> = { admin: "Admin", technician: "Technician" };

export default function TeamPage() {
  const queryClient = useQueryClient();
  const { data: teamMembers, isLoading } = useQuery({ queryKey: ["team-members"], queryFn: fetchTeamMembers });

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const [editingMember, setEditingMember] = useState<Profile | null>(null);
  const [editName, setEditName] = useState("");
  const [editJobTitle, setEditJobTitle] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const openEditModal = (member: Profile) => {
    setEditingMember(member);
    setEditName(member.full_name);
    setEditJobTitle(member.job_title ?? "");
    setEditError(null);
  };

  const saveEdit = useMutation({
    mutationFn: async () => {
      if (!editingMember) throw new Error("No team member selected");
      if (!editName.trim()) throw new Error("Name is required");
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: editName.trim(), job_title: editJobTitle.trim() || null })
        .eq("id", editingMember.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-members"] });
      setEditingMember(null);
    },
    onError: (e) => setEditError(getErrorMessage(e, "Failed to save")),
  });

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
      queryClient.invalidateQueries({ queryKey: ["team-members"] });
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
          <p className="text-sm text-gray-500">Everyone with sign-in access, and their role in the company.</p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + New technician
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-300 bg-white">
        {isLoading ? (
          <p className="p-6 text-sm text-gray-500">Loading...</p>
        ) : !teamMembers || teamMembers.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No team members yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-300 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Name</th>
                <th className="px-4 py-2 font-semibold">Job title</th>
                <th className="px-4 py-2 font-semibold">Role</th>
                <th className="px-4 py-2 font-semibold">Email</th>
                <th className="px-4 py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {teamMembers.map((member) => (
                <tr key={member.id} className="border-b border-gray-200 last:border-0">
                  <td className="px-4 py-3 font-medium text-gray-900">{member.full_name}</td>
                  <td className="px-4 py-3 text-gray-600">{member.job_title ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        member.role === "admin" ? "bg-blue-100 text-blue-800" : "bg-gray-200 text-gray-700"
                      }`}
                    >
                      {ROLE_LABELS[member.role]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{member.email}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openEditModal(member)} className="text-xs font-semibold text-blue-700 hover:underline">
                      Edit
                    </button>
                  </td>
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

      <Modal open={!!editingMember} onClose={() => setEditingMember(null)} title="Edit team member">
        <FormField label="Full name" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="e.g. Sam Taylor" />
        <FormField
          label="Job title (optional)"
          value={editJobTitle}
          onChange={(e) => setEditJobTitle(e.target.value)}
          placeholder="e.g. Foreman, Office Manager, Apprentice"
        />
        {editError ? <p className="mb-4 text-sm text-red-600">{editError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setEditingMember(null)} className="px-4 py-2 text-sm font-semibold text-gray-600">
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
    </div>
  );
}

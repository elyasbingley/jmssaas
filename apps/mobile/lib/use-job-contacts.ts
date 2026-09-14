import { useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { usePowerSync, useQuery } from "@powersync/react";
import { createJobContactSchema, type JobContact } from "@jmssaas/shared";
import { useAuth } from "./auth-context";

// A job's contacts beyond the client itself (a second homeowner, a tenant,
// an on-site foreman...) - works for any job, not just Real Estate & Strata
// ones (which get their own agency/property manager contact separately).
export function useJobContacts(jobCardId: string) {
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const { data: contacts } = useQuery<JobContact>(
    "SELECT * FROM job_contacts WHERE job_card_id = ? ORDER BY created_at ASC",
    [jobCardId]
  );

  const [name, setName] = useState("");
  const [roleLabel, setRoleLabel] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addContact = async () => {
    const result = createJobContactSchema.safeParse({
      job_card_id: jobCardId,
      name,
      role_label: roleLabel,
      phone,
      email,
    });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Check the contact details");
      return false;
    }
    if (!profile) return false;

    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO job_contacts (id, tenant_id, job_card_id, name, role_label, phone, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        profile.tenant_id,
        jobCardId,
        result.data.name,
        result.data.role_label || null,
        result.data.phone || null,
        result.data.email || null,
        now,
        now,
      ]
    );
    setName("");
    setRoleLabel("");
    setPhone("");
    setEmail("");
    setError(null);
    return true;
  };

  const removeContact = async (contactId: string) => {
    await powersync.execute("DELETE FROM job_contacts WHERE id = ?", [contactId]);
  };

  return { contacts, name, setName, roleLabel, setRoleLabel, phone, setPhone, email, setEmail, error, addContact, removeContact };
}

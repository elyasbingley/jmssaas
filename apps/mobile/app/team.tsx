import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { createTechnicianSchema, type Profile } from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { useIsOnline } from "../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../lib/use-supabase-fetch";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { RequiresConnectionNotice } from "../components/RequiresConnectionNotice";
import { CenteredModal } from "../components/CenteredModal";
import { FormField } from "../components/FormField";

// Reached via a small admin-only "Team" link on Home, alongside "Company
// Settings" rather than as a tile of its own (see Home's tile grid) -
// both are occasional setup/administration screens a person visits when
// onboarding someone or configuring the business, not a daily operational
// tool the way Sales/Tasks/Calendar/Schedule are, so they share that
// header-link treatment rather than spending tile-grid space on them.
const ROLE_LABELS: Record<Profile["role"], string> = { admin: "Admin", technician: "Technician" };

export default function TeamScreen() {
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";

  const { data: teamMembers, refetch } = useSupabaseFetch<Profile[]>(async () => {
    const { data, error } = await supabase.from("profiles").select("*").order("full_name");
    if (error) throw error;
    return (data ?? []) as Profile[];
  }, [isOnline]);
  useRefetchOnFocus(refetch);

  const [modalVisible, setModalVisible] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [editingMember, setEditingMember] = useState<Profile | null>(null);
  const [editName, setEditName] = useState("");
  const [editJobTitle, setEditJobTitle] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const openEditModal = (member: Profile) => {
    setEditingMember(member);
    setEditName(member.full_name);
    setEditJobTitle(member.job_title ?? "");
    setEditError(null);
  };

  const handleSaveEdit = async () => {
    if (!editingMember || !editName.trim()) {
      setEditError("Name is required");
      return;
    }
    setEditSaving(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: editName.trim(), job_title: editJobTitle.trim() || null })
        .eq("id", editingMember.id);
      if (error) throw error;
      setEditingMember(null);
      refetch();
    } catch (e) {
      setEditError(getErrorMessage(e, "Failed to save"));
    } finally {
      setEditSaving(false);
    }
  };

  const resetForm = () => {
    setFullName("");
    setEmail("");
    setPassword("");
    setFormError(null);
  };

  const handleCreate = async () => {
    const result = createTechnicianSchema.safeParse({ full_name: fullName, email, password });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Check the form for errors");
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const { error } = await supabase.functions.invoke("create-technician", { body: result.data });
      if (error) {
        // FunctionsHttpError means the function itself ran and returned a
        // structured {error: "..."} body (see
        // supabase/functions/create-technician) - map the two cases an
        // admin will actually hit to a clear message rather than a raw
        // Auth/network error. Never log the password here.
        let code: string | undefined;
        if (error instanceof FunctionsHttpError) {
          try {
            const body = await error.context.json();
            code = body?.error;
          } catch {
            // response wasn't JSON - fall through to the generic message
          }
        }
        if (code === "email_taken") {
          setFormError("That email is already in use by another account.");
        } else if (code === "weak_password") {
          setFormError("Choose a stronger password.");
        } else if (code === "forbidden" || code === "unauthorized") {
          setFormError("You don't have permission to create technicians.");
        } else {
          console.error("[Team] Failed to create technician", error);
          setFormError(getErrorMessage(error, "Failed to create technician (see console for details)"));
        }
        return;
      }

      resetForm();
      setModalVisible(false);
      refetch();
    } catch (e) {
      console.error("[Team] Failed to create technician", e);
      setFormError(getErrorMessage(e, "Failed to create technician (see console for details)"));
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Team/Staff" />
      </View>
    );
  }

  if (!isAdmin) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Only admins can view the team.</Text>
      </View>
    );
  }

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={styles.subtitle}>Everyone with sign-in access, and their role in the company.</Text>

        {(teamMembers ?? []).map((member) => (
          <Pressable key={member.id} style={styles.techRow} onPress={() => openEditModal(member)}>
            <View style={styles.techRowTop}>
              <Text style={styles.techName}>{member.full_name}</Text>
              <View style={[styles.roleBadge, member.role === "admin" && styles.roleBadgeAdmin]}>
                <Text style={[styles.roleBadgeText, member.role === "admin" && styles.roleBadgeTextAdmin]}>
                  {ROLE_LABELS[member.role]}
                </Text>
              </View>
            </View>
            {member.job_title ? <Text style={styles.techJobTitle}>{member.job_title}</Text> : null}
            <Text style={styles.techEmail}>{member.email}</Text>
          </Pressable>
        ))}
        {(teamMembers ?? []).length === 0 ? <Text style={styles.empty}>No team members yet.</Text> : null}

        <Pressable style={styles.addButton} onPress={() => setModalVisible(true)}>
          <Text style={styles.addButtonText}>+ New technician</Text>
        </Pressable>
      </ScrollView>

      <CenteredModal
        visible={modalVisible}
        onClose={() => {
          setModalVisible(false);
          resetForm();
        }}
      >
        <Text style={styles.modalTitle}>New technician</Text>
        <FormField label="Full name" placeholder="e.g. Sam Taylor" value={fullName} onChangeText={setFullName} />
        <View style={styles.fieldSpacing}>
          <FormField
            label="Email"
            placeholder="sam@example.com"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />
        </View>
        <View style={styles.fieldSpacing}>
          <FormField
            label="Password"
            placeholder="At least 8 characters"
            value={password}
            onChangeText={setPassword}
            autoCapitalize="none"
            secureTextEntry
          />
        </View>
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable
            onPress={() => {
              setModalVisible(false);
              resetForm();
            }}
          >
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleCreate} disabled={submitting}>
            <Text style={styles.buttonText}>{submitting ? "Creating..." : "Create"}</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <CenteredModal visible={!!editingMember} onClose={() => setEditingMember(null)}>
        <Text style={styles.modalTitle}>Edit team member</Text>
        <FormField label="Full name" placeholder="e.g. Sam Taylor" value={editName} onChangeText={setEditName} />
        <View style={styles.fieldSpacing}>
          <FormField
            label="Job title (optional)"
            placeholder="e.g. Foreman, Office Manager, Apprentice"
            value={editJobTitle}
            onChangeText={setEditJobTitle}
          />
        </View>
        {editError ? <Text style={styles.error}>{editError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setEditingMember(null)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleSaveEdit} disabled={editSaving}>
            <Text style={styles.buttonText}>{editSaving ? "Saving..." : "Save"}</Text>
          </Pressable>
        </View>
      </CenteredModal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  subtitle: { color: "#6b7280", marginBottom: 16 },
  techRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
  },
  techRowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  techName: { fontSize: 16, fontWeight: "600", color: "#111827" },
  techJobTitle: { fontSize: 13, color: "#374151", marginTop: 2 },
  techEmail: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  roleBadge: { borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: "#e5e7eb" },
  roleBadgeAdmin: { backgroundColor: "#dbeafe" },
  roleBadgeText: { fontSize: 11, fontWeight: "700", color: "#374151" },
  roleBadgeTextAdmin: { color: "#1e40af" },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
  addButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 20 },
  addButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  fieldSpacing: { marginTop: 16 },
  error: { color: "#dc2626", marginTop: 12 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 16 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  link: { color: "#1d4ed8", fontWeight: "600" },
});

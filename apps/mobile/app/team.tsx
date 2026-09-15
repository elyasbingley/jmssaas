import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { createTechnicianSchema, type Profile } from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { useIsOnline } from "../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../lib/use-supabase-fetch";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../components/theme/ThemedRequiresConnectionNotice";
import { ThemedModal } from "../components/theme/ThemedModal";
import { ThemedFormField } from "../components/theme/ThemedFormField";
import { ThemedButton } from "../components/theme/ThemedButton";

// Reached via More > Team/Staff - an occasional setup/administration
// screen a person visits when onboarding someone, not a daily operational
// tool.
const ROLE_LABELS: Record<Profile["role"], string> = { admin: "Admin", technician: "Technician" };

export default function TeamScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const isAdmin = profile?.role === "admin";
  const styles = useThemedStyles(createStyles);

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

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Text style={styles.link}>‹ Back</Text>
      </Pressable>
      <Text style={styles.title}>Team / Staff</Text>
    </View>
  );

  if (!isOnline) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
          {header}
          <ThemedRequiresConnectionNotice label="Team/Staff" />
        </SafeAreaView>
      </>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
          {header}
          <Text style={styles.empty}>Only admins can view the team.</Text>
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        {header}
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
            <Text style={styles.addButtonText}>+ New Technician</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>

      <ThemedModal
        visible={modalVisible}
        onClose={() => {
          setModalVisible(false);
          resetForm();
        }}
      >
        <Text style={styles.modalTitle}>New Technician</Text>
        <ThemedFormField label="Full name" placeholder="e.g. Sam Taylor" value={fullName} onChangeText={setFullName} />
        <View style={styles.fieldSpacing}>
          <ThemedFormField
            label="Email"
            placeholder="sam@example.com"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />
        </View>
        <View style={styles.fieldSpacing}>
          <ThemedFormField
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
          <ThemedButton label={submitting ? "Creating..." : "Create"} onPress={handleCreate} disabled={submitting} />
        </View>
      </ThemedModal>

      <ThemedModal visible={!!editingMember} onClose={() => setEditingMember(null)}>
        <Text style={styles.modalTitle}>Edit Team Member</Text>
        <ThemedFormField label="Full name" placeholder="e.g. Sam Taylor" value={editName} onChangeText={setEditName} />
        <View style={styles.fieldSpacing}>
          <ThemedFormField
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
          <ThemedButton label={editSaving ? "Saving..." : "Save"} onPress={handleSaveEdit} disabled={editSaving} />
        </View>
      </ThemedModal>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    subtitle: { color: tokens.textMuted, marginBottom: 16, fontSize: font.body - 1, ...mono },
    techRow: {
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    // Not justifyContent: "space-between" with two auto-width children - see
    // LineItemEditor.tsx's totalsRow comment for why that silently clips a
    // long name with no ellipsis on some devices. techName gets flex: 1 (it
    // absorbs the row's leftover width after the badge's own natural size)
    // and roleBadge stays flexShrink: 0 at its fixed intrinsic width.
    techRowTop: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    techName: { fontSize: font.body, fontWeight: "600" as const, color: tokens.textPrimary, flex: 1, ...mono },
    techJobTitle: { fontSize: font.label, color: tokens.textPrimary, marginTop: 2, ...mono },
    techEmail: { fontSize: font.label, color: tokens.textMuted, marginTop: 2, ...mono },
    roleBadge: { borderRadius: 3, borderWidth: 1, borderColor: tokens.border, paddingHorizontal: 8, paddingVertical: 2, flexShrink: 0 },
    roleBadgeAdmin: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    roleBadgeText: { fontSize: font.label - 1, fontWeight: "700" as const, color: tokens.textMuted, ...mono },
    roleBadgeTextAdmin: { color: tokens.accent },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 24, ...mono },
    addButton: {
      borderWidth: 1,
      borderColor: tokens.accent,
      backgroundColor: tokens.accentGlow,
      borderRadius: 3,
      padding: 14,
      alignItems: "center" as const,
      marginTop: 20,
    },
    addButtonText: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.body, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    fieldSpacing: { marginTop: 16 },
    error: { color: tokens.danger, marginTop: 12, ...mono },
    modalTitle: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      marginBottom: 4,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 20, marginTop: 16 },
  };
}

import { useEffect, useState } from "react";
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import type { EmailAttachment, KnowledgeArticle, Tenant } from "@jmssaas/shared";
import { supabase } from "../../../lib/supabase";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../../lib/errors";
import { triggerImmediateDispatch } from "../../../lib/dispatch-now";
import { buildKnowledgeArticlePdfHtml } from "../../../lib/knowledge-pdf";
import { exportPdf, buildPdfDataUri } from "../../../lib/print";
import { RequiresConnectionNotice } from "../../../components/RequiresConnectionNotice";
import { EmailComposeModal } from "../../../components/EmailComposeModal";

const BUCKET = "knowledge-files";

function ImageBlockView({ storagePath, caption }: { storagePath: string; caption?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!storagePath) return;
    supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, 3600)
      .then(({ data }) => {
        if (!cancelled) setUrl(data?.signedUrl ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [storagePath]);

  return (
    <View style={styles.block}>
      {url ? <Image source={{ uri: url }} style={styles.image} resizeMode="contain" /> : null}
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </View>
  );
}

export default function KnowledgeArticleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useAuth();
  const isOnline = useIsOnline();

  const { data: article } = useSupabaseFetch<KnowledgeArticle | null>(async () => {
    if (!isOnline) return null;
    const { data, error } = await supabase.from("knowledge_articles").select("*").eq("id", id).single();
    if (error) throw error;
    return data as KnowledgeArticle;
  }, [isOnline, id]);
  const { data: tenant } = useSupabaseFetch<Tenant | null>(async () => {
    if (!isOnline || !profile?.tenant_id) return null;
    const { data, error } = await supabase.from("tenants").select("*").eq("id", profile.tenant_id).single();
    if (error) throw error;
    return data as Tenant;
  }, [isOnline, profile?.tenant_id]);

  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const downloadPdf = async () => {
    if (!tenant || !article) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      const html = await buildKnowledgeArticlePdfHtml({ tenant, article });
      await exportPdf(html, article.title);
    } catch (e) {
      setPdfError(getErrorMessage(e, "Failed to generate PDF"));
    } finally {
      setPdfBusy(false);
    }
  };

  const [emailModalVisible, setEmailModalVisible] = useState(false);
  const [emailAttachments, setEmailAttachments] = useState<EmailAttachment[]>([]);

  const openEmailModal = async () => {
    if (!tenant || !article) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      const html = await buildKnowledgeArticlePdfHtml({ tenant, article });
      const dataUri = await buildPdfDataUri(html);
      setEmailAttachments([{ filename: `${article.title}.pdf`, content: dataUri }]);
      setEmailModalVisible(true);
    } catch (e) {
      setPdfError(getErrorMessage(e, "Failed to generate PDF"));
    } finally {
      setPdfBusy(false);
    }
  };

  const handleSendEmail = async (payload: { to: string; cc: string; bcc: string; subject: string; body: string; attachments: EmailAttachment[] }) => {
    if (!profile || !article) throw new Error("Not signed in");
    if (!isOnline) throw new Error("Sending an email needs an internet connection.");
    const { data: row, error: insertError } = await supabase
      .from("scheduled_communications")
      .insert({
        tenant_id: profile.tenant_id,
        entity_type: "knowledge_article",
        entity_id: article.id,
        trigger_key: "manual_email",
        template_id: null,
        channel: "email",
        recipient_phone_or_email: payload.to,
        cc_emails: payload.cc ? payload.cc.split(",").map((s) => s.trim()).filter(Boolean) : [],
        bcc_emails: payload.bcc ? payload.bcc.split(",").map((s) => s.trim()).filter(Boolean) : [],
        rendered_subject: payload.subject,
        rendered_body: payload.body,
        attachments: payload.attachments,
        scheduled_for: new Date().toISOString(),
        status: "pending",
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    await triggerImmediateDispatch(row.id);
  };

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Knowledge" />
      </View>
    );
  }
  if (!article) {
    return <View style={styles.container} />;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <Text style={styles.title}>{article.title}</Text>

      {article.content_blocks.map((block) => {
        if (block.type === "text") {
          return (
            <Text key={block.id} style={styles.body}>
              {block.body}
            </Text>
          );
        }
        if (block.type === "image") {
          return <ImageBlockView key={block.id} storagePath={block.storagePath} caption={block.caption} />;
        }
        return (
          <Pressable key={block.id} style={styles.block} onPress={() => Linking.openURL(block.url)}>
            <Text style={styles.videoLink}>▶ Watch video</Text>
            {block.caption ? <Text style={styles.caption}>{block.caption}</Text> : null}
          </Pressable>
        );
      })}

      {pdfError ? <Text style={styles.error}>{pdfError}</Text> : null}

      <View style={styles.actions}>
        <Pressable style={styles.actionButton} onPress={downloadPdf} disabled={pdfBusy}>
          <Text style={styles.actionButtonText}>{pdfBusy ? "Preparing..." : "Download PDF"}</Text>
        </Pressable>
        <Pressable style={styles.actionButton} onPress={openEmailModal} disabled={pdfBusy}>
          <Text style={styles.actionButtonText}>{pdfBusy ? "Preparing..." : "Email PDF"}</Text>
        </Pressable>
      </View>

      <EmailComposeModal
        visible={emailModalVisible}
        onClose={() => setEmailModalVisible(false)}
        title="Email article as PDF"
        defaultTo=""
        defaultSubject={article.title}
        defaultBody={`Please find attached: ${article.title}`}
        recipientOptions={[]}
        defaultAttachments={emailAttachments}
        onSend={handleSendEmail}
        sendLabel="Send"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  title: { fontSize: 20, fontWeight: "700", color: "#111827", marginBottom: 16 },
  body: { fontSize: 15, lineHeight: 22, color: "#1f2937", marginBottom: 12 },
  block: { marginBottom: 16 },
  image: { width: "100%", height: 220, borderRadius: 8, backgroundColor: "#f3f4f6" },
  caption: { fontSize: 12, color: "#6b7280", marginTop: 4 },
  videoLink: { fontSize: 15, fontWeight: "700", color: "#1d4ed8" },
  error: { color: "#dc2626", marginBottom: 12 },
  actions: { flexDirection: "row", gap: 12, marginTop: 8 },
  actionButton: { flex: 1, borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, paddingVertical: 12, alignItems: "center" },
  actionButtonText: { fontSize: 14, fontWeight: "700", color: "#374151" },
});

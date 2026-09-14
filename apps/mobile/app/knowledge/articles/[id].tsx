import { useEffect, useState } from "react";
import { Image, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { EmailAttachment, KnowledgeArticle, Tenant } from "@jmssaas/shared";
import { supabase } from "../../../lib/supabase";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { getErrorMessage } from "../../../lib/errors";
import { triggerImmediateDispatch } from "../../../lib/dispatch-now";
import { buildKnowledgeArticlePdfHtml } from "../../../lib/knowledge-pdf";
import { exportPdf, buildPdfDataUri } from "../../../lib/print";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../../components/theme/ThemedRequiresConnectionNotice";
import { EmailComposeModal } from "../../../components/EmailComposeModal";

const BUCKET = "knowledge-files";

function ImageBlockView({ storagePath, caption, styles }: { storagePath: string; caption?: string; styles: ReturnType<typeof createStyles> }) {
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
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();
  const styles = useThemedStyles(createStyles);

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

  const header = (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Text style={styles.link}>‹ Back</Text>
      </Pressable>
      <Text style={styles.headerTitle}>Article</Text>
    </View>
  );

  if (!isOnline) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
          {header}
          <ThemedRequiresConnectionNotice label="Knowledge" />
        </SafeAreaView>
      </>
    );
  }
  if (!article) {
    return (
      <>
        <StatusBar style="light" />
        <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
          {header}
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        {header}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
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
              return <ImageBlockView key={block.id} storagePath={block.storagePath} caption={block.caption} styles={styles} />;
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
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    headerTitle: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title, fontWeight: "700" as const, color: tokens.accent, letterSpacing: 1, marginBottom: 16, ...mono },
    body: { fontSize: font.body, lineHeight: 22, color: tokens.textPrimary, marginBottom: 12, ...mono },
    block: { marginBottom: 16 },
    image: { width: "100%" as const, height: 220, borderRadius: 4, backgroundColor: tokens.surface },
    caption: { fontSize: font.label, color: tokens.textMuted, marginTop: 4, ...mono },
    videoLink: { fontSize: font.body, fontWeight: "700" as const, color: tokens.accent, ...mono },
    error: { color: tokens.danger, marginBottom: 12, ...mono },
    actions: { flexDirection: "row" as const, gap: 12, marginTop: 8 },
    actionButton: { flex: 1, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, borderRadius: 3, paddingVertical: 12, alignItems: "center" as const },
    actionButtonText: { fontSize: font.body - 1, fontWeight: "700" as const, color: tokens.accent, ...mono },
  };
}

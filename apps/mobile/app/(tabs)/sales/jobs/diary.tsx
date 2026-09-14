import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@powersync/react";
import type { JobCard } from "@jmssaas/shared";
import { useJobNotes } from "../../../../lib/use-job-notes";
import { useThemedStyles, type StyleTheme } from "../../../../lib/use-themed-styles";
import { Panel } from "../../../../components/theme/Panel";
import { ThemedButton } from "../../../../components/theme/ThemedButton";
import { ThemedFormField } from "../../../../components/theme/ThemedFormField";
import { ThemedPhotoAttachments } from "../../../../components/theme/ThemedPhotoAttachments";
import { addJobPhoto } from "../../../../lib/powersync";
import { useAuth } from "../../../../lib/auth-context";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { useState } from "react";

interface JobFileWithLocalUri {
  id: string;
  local_uri: string | null;
}

// The consolidated Job Card notes/photos/files entry point ("Diary" in the
// spec) - a job_files row IS what's rendered as a photo elsewhere in this
// app (see the [id] screen's own former Photos section), so "photos and
// files" here is one PhotoAttachments grid against that same table, not
// two separate lists - there's no separate document/PDF upload flow in
// this app yet to make a genuinely distinct "files" list from.
export default function JobDiaryScreen() {
  const { jobCardId } = useLocalSearchParams<{ jobCardId: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const styles = useThemedStyles(createStyles);

  const { data: jobRows } = useQuery<JobCard>("SELECT * FROM job_cards WHERE id = ?", [jobCardId]);
  const job = jobRows[0];

  const { data: files } = useQuery<JobFileWithLocalUri>(
    `SELECT jf.id, a.local_uri
       FROM job_files jf
       LEFT JOIN attachments a ON a.id = jf.id
      WHERE jf.job_card_id = ?
      ORDER BY jf.created_at DESC`,
    [jobCardId]
  );

  const { notes, noteText, setNoteText, noteError, addNote } = useJobNotes(jobCardId);
  const [uploading, setUploading] = useState(false);

  const handleUploadPhoto = async (photo: { base64: string; mimeType: string; fileExtension: string }) => {
    if (!profile || !jobCardId) return;
    setUploading(true);
    try {
      await addJobPhoto({
        tenantId: profile.tenant_id,
        jobCardId,
        uploadedBy: profile.id,
        imageArrayBuffer: decodeBase64(photo.base64),
        mediaType: photo.mimeType,
        fileExtension: photo.fileExtension,
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.backLink}>‹ BACK</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Diary</Text>
        <View style={{ width: 60 }} />
      </View>
      {job ? <Text style={styles.jobTitle}>{job.title}</Text> : null}

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Panel title="Photos & Files">
          <ThemedPhotoAttachments photos={files} uploading={uploading} onUpload={handleUploadPhoto} />
        </Panel>

        <Panel title="Notes">
          <ThemedFormField
            label="Add a note"
            placeholder="Note"
            value={noteText}
            onChangeText={setNoteText}
            multiline
            style={styles.multiline}
          />
          {noteError ? <Text style={styles.dangerText}>{noteError}</Text> : null}
          <ThemedButton label="Add Note" onPress={addNote} />

          {notes.map((note) => (
            <View key={note.id} style={styles.noteRow}>
              <Text style={styles.noteBody}>{note.body}</Text>
              <Text style={styles.noteMeta}>{new Date(note.created_at).toLocaleString()}</Text>
            </View>
          ))}
          {notes.length === 0 ? <Text style={styles.empty}>No notes yet.</Text> : null}
        </Panel>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingHorizontal: 16,
      paddingTop: 12,
    },
    backLink: { color: tokens.accent, fontFamily: fontFamily.mobileFontFamily, fontSize: font.body, letterSpacing: 1 },
    headerTitle: {
      color: tokens.textPrimary,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.title,
      letterSpacing: 2,
      textTransform: "uppercase" as const,
    },
    jobTitle: {
      color: tokens.textMuted,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.label,
      textAlign: "center" as const,
      paddingBottom: 8,
    },
    multiline: { minHeight: 70, textAlignVertical: "top" as const },
    dangerText: { color: tokens.danger, marginTop: 6, fontFamily: fontFamily.mobileFontFamily, fontSize: font.label },
    noteRow: { marginTop: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: tokens.border },
    noteBody: { fontSize: font.body, color: tokens.textPrimary, fontFamily: fontFamily.mobileFontFamily },
    noteMeta: { fontSize: font.label - 1, color: tokens.textMuted, marginTop: 4, fontFamily: fontFamily.mobileFontFamily },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 12, fontFamily: fontFamily.mobileFontFamily },
  };
}

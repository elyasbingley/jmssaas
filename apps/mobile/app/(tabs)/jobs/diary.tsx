import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@powersync/react";
import type { JobCard } from "@jmssaas/shared";
import { useJobNotes } from "../../../lib/use-job-notes";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { Panel } from "../../../components/theme/Panel";
import { ThemedButton } from "../../../components/theme/ThemedButton";
import { ThemedFormField } from "../../../components/theme/ThemedFormField";
import { ThemedPhotoAttachments } from "../../../components/theme/ThemedPhotoAttachments";
import { addJobPhoto } from "../../../lib/powersync";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { getErrorMessage } from "../../../lib/errors";
import { flagPhotoForMarketing, unflagPhotoForMarketing } from "../../../lib/marketing-photo";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { useState } from "react";

interface JobFileWithLocalUri {
  id: string;
  local_uri: string | null;
  file_name: string | null;
  mime_type: string | null;
  upload_state: number | null;
  marketing_ok: number | null;
  used_in_post_id: string | null;
}

// The consolidated Job Card notes/photos/files entry point ("Diary" in the
// spec) - a job_files row IS what's rendered as a photo elsewhere in this
// app (see the [id] screen's own former Photos section), so "photos and
// files" here is one ThemedPhotoAttachments grid against that same table,
// not two separate lists. That component now also handles any file type
// (PDF, Word doc, etc.) via its own "Attach File" picker, same table/
// storage, just a non-image mime_type.
export default function JobDiaryScreen() {
  const { jobCardId } = useLocalSearchParams<{ jobCardId: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const styles = useThemedStyles(createStyles);

  const { data: jobRows } = useQuery<JobCard>("SELECT * FROM job_cards WHERE id = ?", [jobCardId]);
  const job = jobRows[0];

  const { data: files } = useQuery<JobFileWithLocalUri>(
    `SELECT jf.id, jf.file_name, jf.mime_type, jf.marketing_ok, jf.used_in_post_id, a.local_uri, a.state AS upload_state
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

  // Hold a photo: "OK for marketing" (Google Business Profile posts). Makes
  // a copy without location data in the marketing bucket, so it needs a
  // connection; the flag syncs back down like any other change.
  const isOnline = useIsOnline();
  const [marketingBusy, setMarketingBusy] = useState(false);
  const handleMarketing = (item: { id: string; local_uri: string | null }) => {
    const file = files.find((f) => f.id === item.id);
    if (!file || !profile || !item.local_uri || marketingBusy) return;
    const flagged = !!file.marketing_ok;
    if (!isOnline) {
      Alert.alert("You're offline", "Connect to the internet to change whether this photo can be used for marketing.");
      return;
    }
    const run = async () => {
      setMarketingBusy(true);
      try {
        if (flagged) await unflagPhotoForMarketing({ tenantId: profile.tenant_id, jobFileId: file.id });
        else await flagPhotoForMarketing({ tenantId: profile.tenant_id, jobFileId: file.id, sourceUri: item.local_uri! });
      } catch (e) {
        Alert.alert("Couldn't change it", getErrorMessage(e, "Something went wrong. Try again."));
      } finally {
        setMarketingBusy(false);
      }
    };
    Alert.alert(
      flagged ? "Stop using this photo for marketing?" : "OK for marketing?",
      flagged
        ? file.used_in_post_id
          ? "It's already been used in a Google post, which stays. It won't be used again."
          : "It won't be used in Google posts or blog posts."
        : "It may be used in Google posts and website blog posts. A copy is made without the photo's location data. Check there's no house number, number plate or face in it.",
      [
        { text: "Cancel", style: "cancel" },
        { text: flagged ? "Stop using it" : "OK for marketing", style: flagged ? "destructive" : "default", onPress: () => void run() },
      ]
    );
  };

  // "Mark all for marketing": flags every photo on the job that isn't
  // already, one at a time, so the ones not wanted can be unticked after
  // (hold a photo). Only photos that are on this phone can be copied.
  const [markAllProgress, setMarkAllProgress] = useState<string | null>(null);
  const unflaggedPhotos = files.filter((f) => !f.marketing_ok && isPhoto(f));
  const handleMarkAll = () => {
    if (!profile || markAllProgress || marketingBusy) return;
    if (!isOnline) {
      Alert.alert("You're offline", "Connect to the internet to mark photos for marketing.");
      return;
    }
    const ready = unflaggedPhotos.filter((f) => !!f.local_uri);
    const notHere = unflaggedPhotos.length - ready.length;
    if (!ready.length) {
      Alert.alert("Photos still downloading", "These photos aren't on this phone yet. Try again in a minute.");
      return;
    }
    const run = async () => {
      let failed = 0;
      for (let i = 0; i < ready.length; i++) {
        setMarkAllProgress(`${i + 1} of ${ready.length}`);
        try {
          await flagPhotoForMarketing({ tenantId: profile.tenant_id, jobFileId: ready[i]!.id, sourceUri: ready[i]!.local_uri! });
        } catch {
          failed++;
        }
      }
      setMarkAllProgress(null);
      const missed = failed + notHere;
      if (missed) Alert.alert("Some photos weren't marked", `${missed} of ${unflaggedPhotos.length} couldn't be marked. Hold each one to try it on its own.`);
    };
    Alert.alert(
      `Mark ${ready.length} photo${ready.length === 1 ? "" : "s"} OK for marketing?`,
      "They may be used in Google posts and website blog posts. Copies are made without location data. Afterwards, hold any you don't want (house numbers, number plates, faces) to untick them." +
        (notHere ? `\n\n${notHere} more aren't on this phone yet and will be left out.` : ""),
      [
        { text: "Cancel", style: "cancel" },
        { text: "Mark all", onPress: () => void run() },
      ]
    );
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
          <ThemedPhotoAttachments
            photos={files}
            uploading={uploading || marketingBusy || !!markAllProgress}
            onUpload={handleUploadPhoto}
            onLongPressPhoto={handleMarketing}
            hint="Hold a photo to mark it OK for marketing (📣), or to untick it."
          />
          {unflaggedPhotos.length > 0 || markAllProgress ? (
            <View style={{ marginTop: 10 }}>
              <ThemedButton
                label={markAllProgress ? `📣 Marking ${markAllProgress}...` : "📣 Mark all for marketing"}
                variant="secondary"
                onPress={handleMarkAll}
                disabled={!!markAllProgress || marketingBusy}
              />
            </View>
          ) : null}
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

// Only real photos can be made into marketing copies (not PDFs or SVGs).
function isPhoto(f: { mime_type: string | null; file_name: string | null }): boolean {
  const mime = f.mime_type ?? "";
  if (mime.includes("svg") || /\.svg$/i.test(f.file_name ?? "")) return false;
  return mime.startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(f.file_name ?? "");
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

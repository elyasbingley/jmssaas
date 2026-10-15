import { useState } from "react";
import { Alert, FlatList, Image, Pressable, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { AttachmentState } from "@powersync/common";
import { MultiCaptureCamera, type CapturedPhoto } from "../MultiCaptureCamera";
import { FullScreenImageViewer } from "../FullScreenImageViewer";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

export interface ThemedPhotoAttachmentItem {
  id: string;
  local_uri: string | null;
  // The matching row's state in PowerSync's local `attachments` table
  // (AttachmentState - QUEUED_UPLOAD/QUEUED_DOWNLOAD/QUEUED_DELETE/SYNCED/
  // ARCHIVED), via `a.state AS upload_state` in the caller's own query.
  // Optional/nullable so a caller that hasn't added that column yet just
  // never shows the pending badge, rather than erroring.
  upload_state?: number | null;
}

interface UploadInput {
  base64: string;
  mimeType: string;
  fileExtension: string;
}

interface ThemedPhotoAttachmentsProps {
  photos: ThemedPhotoAttachmentItem[];
  uploading: boolean;
  onUpload: (photo: UploadInput) => Promise<void>;
}

// The actual job/task photo upload UI (Job Card Diary, Task detail) - both
// screens are fully CRT-themed, so this is the component that's really
// live, not components/PhotoAttachments.tsx (that one has no remaining
// call sites anywhere in the app - it predates the full CRT retheme and
// was never deleted, see that file's own header comment for the one
// generic-file-upload feature it still has that this component doesn't).
export function ThemedPhotoAttachments({ photos, uploading, onUpload }: ThemedPhotoAttachmentsProps) {
  const [cameraVisible, setCameraVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const styles = useThemedStyles(createStyles);

  const handleCameraDone = async (captured: CapturedPhoto[]) => {
    setCameraVisible(false);
    for (const photo of captured) {
      await onUpload({ base64: photo.base64, mimeType: photo.mimeType, fileExtension: "jpg" });
    }
  };

  const openCamera = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Enable camera access in Settings to take photos.");
      return;
    }
    setCameraVisible(true);
  };

  const pickFromLibrary = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Enable photo access in Settings to attach photos.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.6,
      allowsMultipleSelection: true,
      selectionLimit: 30,
    });
    if (result.canceled) return;

    for (const asset of result.assets) {
      // Re-encoded through expo-image-manipulator rather than relying on
      // ImagePicker's own `base64: true` option. That option is two
      // separate problems: (1) it's unreliable once `allowsMultipleSelection`
      // triggers the native multi-select picker, often coming back with no
      // base64 data per asset with no error surfaced, which used to
      // silently skip every photo here; (2) even when it does return data,
      // its `mimeType` is only a best-effort label - the Photos library
      // commonly stores originals as HEIC even when the picker reports
      // "image/jpeg", which iOS decodes fine locally but desktop browsers
      // can't decode in an <img> tag at all. manipulate().renderAsync()
      // reads straight from asset.uri (sidestepping problem 1) and
      // saveAsync({format: SaveFormat.JPEG}) always produces genuine JPEG
      // bytes regardless of source format (sidestepping problem 2) - a
      // no-op in practice for a photo that was already a real JPEG, e.g.
      // the in-app camera path above.
      try {
        const rendered = await ImageManipulator.manipulate(asset.uri).renderAsync();
        const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
        if (!saved.base64) throw new Error("No base64 data returned");
        await onUpload({ base64: saved.base64, mimeType: "image/jpeg", fileExtension: "jpg" });
      } catch (e) {
        console.error("[ThemedPhotoAttachments] Failed to read picked photo", e);
        Alert.alert("Failed to attach photo", asset.fileName ?? "One of the selected photos couldn't be read.");
      }
    }
  };

  const viewableImages = photos.filter((p) => p.local_uri).map((p) => ({ uri: p.local_uri! }));

  return (
    <View>
      <FlatList
        horizontal
        data={photos}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => {
          const viewableIndex = viewableImages.findIndex((v) => v.uri === item.local_uri);
          // Distinct from the "Syncing..." placeholder below (which means
          // this device hasn't *downloaded* the photo yet) - this means the
          // opposite: the photo is on this device but hasn't been *uploaded*
          // to the server yet, so nobody else (desktop included) can see it
          // until that finishes. Previously this failure was completely
          // silent - a photo could sit "taken but never backed up" forever
          // with no indication anywhere in the app.
          const notYetUploaded = item.upload_state != null && item.upload_state !== AttachmentState.SYNCED;
          return item.local_uri ? (
            <Pressable
              onPress={() => {
                if (notYetUploaded) {
                  Alert.alert(
                    "Not backed up yet",
                    "This photo hasn't finished uploading to the server, so it won't show up anywhere else yet (including on desktop). Keep the app open with a good connection for a minute to let it finish."
                  );
                  return;
                }
                if (viewableIndex >= 0) setViewerIndex(viewableIndex);
              }}
            >
              <Image source={{ uri: item.local_uri }} style={styles.photo} />
              {notYetUploaded ? (
                <View style={styles.pendingBadge}>
                  <Text style={styles.pendingBadgeText}>⏳</Text>
                </View>
              ) : null}
            </Pressable>
          ) : (
            <View style={[styles.photo, styles.photoPending]}>
              <Text style={styles.photoPendingText}>Syncing...</Text>
            </View>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No photos yet.</Text>}
      />
      <View style={styles.photoActions}>
        <Pressable style={styles.button} onPress={openCamera}>
          <Text style={styles.buttonText}>Take Photos</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.buttonSecondary]} onPress={pickFromLibrary}>
          <Text style={[styles.buttonText, styles.buttonSecondaryText]}>Choose Photos</Text>
        </Pressable>
      </View>
      {uploading ? <Text style={styles.uploadingText}>Uploading...</Text> : null}

      <MultiCaptureCamera visible={cameraVisible} onClose={() => setCameraVisible(false)} onDone={handleCameraDone} />
      <FullScreenImageViewer
        visible={viewerIndex !== null}
        images={viewableImages}
        imageIndex={viewerIndex ?? 0}
        onRequestClose={() => setViewerIndex(null)}
      />
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    photo: { width: 96, height: 96, borderRadius: 3, marginRight: 8, backgroundColor: tokens.background, borderWidth: 1, borderColor: tokens.border },
    photoPending: { alignItems: "center" as const, justifyContent: "center" as const },
    photoPendingText: { fontSize: font.label, color: tokens.textMuted, fontFamily: fontFamily.mobileFontFamily },
    pendingBadge: {
      position: "absolute" as const,
      top: 4,
      right: 12,
      backgroundColor: tokens.background,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: tokens.accent,
      width: 20,
      height: 20,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    pendingBadgeText: { fontSize: 11, lineHeight: 13 },
    photoActions: { flexDirection: "row" as const, gap: 12, marginTop: 12 },
    button: { backgroundColor: tokens.accent, borderRadius: 3, paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1, borderColor: tokens.accent },
    buttonSecondary: { backgroundColor: "transparent", borderColor: tokens.border },
    buttonText: {
      color: tokens.background,
      fontWeight: "700" as const,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.button,
      letterSpacing: 0.5,
      textTransform: "uppercase" as const,
    },
    buttonSecondaryText: { color: tokens.accent },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 12, fontFamily: fontFamily.mobileFontFamily },
    uploadingText: { color: tokens.textMuted, fontSize: font.label, marginTop: 6, fontFamily: fontFamily.mobileFontFamily },
  };
}

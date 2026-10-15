import { useState } from "react";
import { Alert, FlatList, Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { MultiCaptureCamera, type CapturedPhoto } from "./MultiCaptureCamera";
import { FullScreenImageViewer } from "./FullScreenImageViewer";

export interface PhotoAttachmentItem {
  id: string;
  local_uri: string | null;
  // Both nullable for older rows synced before this column selection
  // existed on the caller's query - null is treated as "assume image",
  // the same fallback these attachments always rendered as before file
  // support existed.
  file_name?: string | null;
  mime_type?: string | null;
}

interface UploadInput {
  base64: string;
  mimeType: string;
  fileExtension: string;
}

interface PhotoAttachmentsProps {
  photos: PhotoAttachmentItem[];
  uploading: boolean;
  onUpload: (photo: UploadInput) => Promise<void>;
}

function isImageMime(mimeType: string | null | undefined): boolean {
  return !mimeType || mimeType.startsWith("image/");
}

// Shared by job card and task file attachments - same underlying camera
// (multi-shot, section 8), bulk gallery picker (up to 30 at once) and
// full-screen viewer (section 10) for photos, plus a generic document
// picker for anything else (PDFs, Word docs, etc. - matching desktop's
// JobDetail.tsx, which dropped its image-only restriction the same way).
// Non-image files render as a document icon + filename instead of an
// (impossible) thumbnail. Parameterized by the entity's own upload
// function (addJobPhoto / addTaskPhoto) - the underlying job_files/
// task_files rows and storage were already MIME-agnostic before this
// change, only this component enforced images.
export function PhotoAttachments({ photos, uploading, onUpload }: PhotoAttachmentsProps) {
  const [cameraVisible, setCameraVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

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

  // Reads each picked asset back off disk (via expo-image-manipulator,
  // see below) rather than relying on ImagePicker's own `base64: true`
  // option - that option is unreliable once `allowsMultipleSelection`
  // triggers the native multi-select picker (iOS 14+/Android), often
  // coming back with no base64 data per asset with no error surfaced,
  // which silently skipped every photo here (the "Choose photos button
  // not working" bug - nothing visibly happened because the loop just
  // `continue`d past every asset).
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
      // Re-encoded through expo-image-manipulator rather than read as raw
      // bytes off disk - iOS's Photos library often stores originals as
      // HEIC even when the picker reports mimeType "image/jpeg" (a best-
      // effort guess, not a guarantee the bytes actually match). iOS
      // decodes that mismatch fine locally (so it displayed on mobile),
      // but desktop browsers can't decode HEIC in an <img> tag at all, so
      // an un-normalized HEIC photo rendered as a generic broken-image
      // icon there. manipulate().renderAsync().saveAsync() always
      // produces genuine JPEG bytes regardless of the source format - a
      // no-op in practice for a photo that was already a real JPEG (e.g.
      // the in-app camera path below, which never goes through the Photos
      // library and needs no re-encode) - and reads straight from
      // asset.uri the same way FileSystem.readAsStringAsync below does,
      // so it's unaffected by the unreliable-base64-field bug this
      // try/catch was originally added for.
      try {
        const rendered = await ImageManipulator.manipulate(asset.uri).renderAsync();
        const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
        if (!saved.base64) throw new Error("No base64 data returned");
        await onUpload({ base64: saved.base64, mimeType: "image/jpeg", fileExtension: "jpg" });
      } catch (e) {
        console.error("[PhotoAttachments] Failed to read picked photo", e);
        Alert.alert("Failed to attach photo", asset.fileName ?? "One of the selected photos couldn't be read.");
      }
    }
  };

  // Any file type (PDF, Word doc, etc.) - reads it back off disk as
  // base64 (DocumentPicker itself only returns a file:// uri, unlike
  // ImagePicker's optional base64 field) then hands it to the same
  // onUpload used by photos.
  const pickDocument = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;

    for (const asset of result.assets) {
      try {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
        const extension = asset.name.includes(".") ? asset.name.split(".").pop()!.toLowerCase() : "bin";
        await onUpload({
          base64,
          mimeType: asset.mimeType ?? "application/octet-stream",
          fileExtension: extension,
        });
      } catch (e) {
        console.error("[PhotoAttachments] Failed to read picked file", e);
        Alert.alert("Failed to attach file", asset.name);
      }
    }
  };

  const imagePhotos = photos.filter((p) => isImageMime(p.mime_type));
  const viewableImages = imagePhotos.filter((p) => p.local_uri).map((p) => ({ uri: p.local_uri! }));

  const openFile = (item: PhotoAttachmentItem) => {
    if (!item.local_uri) return;
    Linking.openURL(item.local_uri).catch(() => Alert.alert("Can't open this file", item.file_name ?? ""));
  };

  return (
    <View>
      <FlatList
        horizontal
        data={photos}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => {
          if (isImageMime(item.mime_type)) {
            const viewableIndex = viewableImages.findIndex((v) => v.uri === item.local_uri);
            return item.local_uri ? (
              <Pressable onPress={() => viewableIndex >= 0 && setViewerIndex(viewableIndex)}>
                <Image source={{ uri: item.local_uri }} style={styles.photo} />
              </Pressable>
            ) : (
              <View style={[styles.photo, styles.photoPending]}>
                <Text style={styles.photoPendingText}>Syncing...</Text>
              </View>
            );
          }
          return (
            <Pressable style={[styles.photo, styles.fileTile]} onPress={() => openFile(item)}>
              <Text style={styles.fileIcon}>📄</Text>
              <Text style={styles.fileName} numberOfLines={2}>
                {item.file_name ?? "File"}
              </Text>
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No files yet.</Text>}
      />
      <View style={styles.photoActions}>
        <Pressable style={styles.button} onPress={openCamera}>
          <Text style={styles.buttonText}>Take photos</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.buttonSecondary]} onPress={pickFromLibrary}>
          <Text style={[styles.buttonText, styles.buttonSecondaryText]}>Choose photos</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.buttonSecondary]} onPress={pickDocument}>
          <Text style={[styles.buttonText, styles.buttonSecondaryText]}>Attach file</Text>
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

const styles = StyleSheet.create({
  photo: { width: 96, height: 96, borderRadius: 8, marginRight: 8, backgroundColor: "#e5e7eb" },
  photoPending: { alignItems: "center", justifyContent: "center" },
  photoPendingText: { fontSize: 11, color: "#6b7280" },
  fileTile: { alignItems: "center", justifyContent: "center", padding: 6, gap: 4 },
  fileIcon: { fontSize: 24 },
  fileName: { fontSize: 10, color: "#374151", textAlign: "center" },
  photoActions: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 12 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  buttonSecondary: { backgroundColor: "#f3f4f6" },
  buttonText: { color: "#fff", fontWeight: "600" },
  buttonSecondaryText: { color: "#1d4ed8" },
  empty: { textAlign: "center", color: "#6b7280", padding: 12 },
  uploadingText: { color: "#6b7280", fontSize: 12, marginTop: 6 },
});

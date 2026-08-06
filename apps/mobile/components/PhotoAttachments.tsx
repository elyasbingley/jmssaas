import { useState } from "react";
import { Alert, FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { MultiCaptureCamera, type CapturedPhoto } from "./MultiCaptureCamera";
import { FullScreenImageViewer } from "./FullScreenImageViewer";

export interface PhotoAttachmentItem {
  id: string;
  local_uri: string | null;
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

function extensionFor(mimeType: string | undefined): string {
  return mimeType?.includes("png") ? "png" : "jpg";
}

// Shared by job card and task photo attachments - same underlying camera
// (multi-shot, section 8), bulk gallery picker (up to 30 at once) and
// full-screen viewer (section 10), just parameterized by the entity's own
// upload function (addJobPhoto / addTaskPhoto).
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

  const pickFromLibrary = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Enable photo access in Settings to attach photos.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      base64: true,
      quality: 0.6,
      allowsMultipleSelection: true,
      selectionLimit: 30,
    });
    if (result.canceled) return;

    for (const asset of result.assets) {
      if (!asset.base64) continue;
      await onUpload({
        base64: asset.base64,
        mimeType: asset.mimeType ?? "image/jpeg",
        fileExtension: extensionFor(asset.mimeType),
      });
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
          return item.local_uri ? (
            <Pressable onPress={() => viewableIndex >= 0 && setViewerIndex(viewableIndex)}>
              <Image source={{ uri: item.local_uri }} style={styles.photo} />
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
          <Text style={styles.buttonText}>Take photos</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.buttonSecondary]} onPress={pickFromLibrary}>
          <Text style={[styles.buttonText, styles.buttonSecondaryText]}>Choose photos</Text>
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
  photoActions: { flexDirection: "row", gap: 12, marginTop: 12 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  buttonSecondary: { backgroundColor: "#f3f4f6" },
  buttonText: { color: "#fff", fontWeight: "600" },
  buttonSecondaryText: { color: "#1d4ed8" },
  empty: { textAlign: "center", color: "#6b7280", padding: 12 },
  uploadingText: { color: "#6b7280", fontSize: 12, marginTop: 6 },
});

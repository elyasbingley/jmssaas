import { useState } from "react";
import { Alert, FlatList, Image, Pressable, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { MultiCaptureCamera, type CapturedPhoto } from "../MultiCaptureCamera";
import { FullScreenImageViewer } from "../FullScreenImageViewer";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

export interface ThemedPhotoAttachmentItem {
  id: string;
  local_uri: string | null;
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

function extensionFor(mimeType: string | undefined): string {
  return mimeType?.includes("png") ? "png" : "jpg";
}

// Theme-aware sibling of components/PhotoAttachments.tsx - identical
// camera/library/upload behaviour, only the styling changes. See
// ThemedModal.tsx for why this isn't just a retheme of the shared original
// (PhotoAttachments is also used by the (unthemed) Tasks screen).
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

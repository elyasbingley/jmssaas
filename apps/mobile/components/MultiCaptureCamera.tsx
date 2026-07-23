import { useRef, useState } from "react";
import { FlatList, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

export interface CapturedPhoto {
  uri: string;
  base64: string;
  mimeType: string;
}

interface MultiCaptureCameraProps {
  visible: boolean;
  onClose: () => void;
  onDone: (photos: CapturedPhoto[]) => void;
}

// Custom camera screen replacing expo-image-picker's launchCameraAsync,
// which closes after every single shot by design (a picker, not a camera
// session). This keeps one camera session open across multiple captures
// (ServiceM8-style) - each shot adds a thumbnail to a strip at the bottom;
// "Done" hands the whole batch back to the caller at once.
export function MultiCaptureCamera({ visible, onClose, onDone }: MultiCaptureCameraProps) {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [capturing, setCapturing] = useState(false);

  if (!visible) return null;

  const handleClose = () => {
    setPhotos([]);
    onClose();
  };

  const handleCapture = async () => {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.6 });
      if (photo?.base64) {
        setPhotos((prev) => [...prev, { uri: photo.uri, base64: photo.base64!, mimeType: "image/jpeg" }]);
      }
    } finally {
      setCapturing(false);
    }
  };

  const handleDone = () => {
    const captured = photos;
    setPhotos([]);
    onDone(captured);
  };

  if (!permission) return null;

  if (!permission.granted) {
    return (
      <Modal visible={visible} animationType="slide">
        <View style={styles.permissionContainer}>
          <Text style={styles.permissionText}>Camera access is needed to take photos.</Text>
          <Pressable style={styles.permissionButton} onPress={requestPermission}>
            <Text style={styles.permissionButtonText}>Grant access</Text>
          </Pressable>
          <Pressable onPress={handleClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible={visible} animationType="slide">
      <View style={styles.container}>
        <CameraView ref={cameraRef} style={styles.camera} facing="back" />
        <View style={styles.controls}>
          {photos.length > 0 ? (
            <FlatList
              horizontal
              data={photos}
              keyExtractor={(_, i) => String(i)}
              style={styles.thumbStrip}
              renderItem={({ item }) => <Image source={{ uri: item.uri }} style={styles.thumb} />}
            />
          ) : null}
          <View style={styles.buttonRow}>
            <Pressable style={styles.sideButton} onPress={handleClose}>
              <Text style={styles.sideButtonText}>Cancel</Text>
            </Pressable>
            <Pressable style={styles.shutterButton} onPress={handleCapture} disabled={capturing} />
            <Pressable style={styles.sideButton} onPress={handleDone} disabled={photos.length === 0}>
              <Text style={[styles.sideButtonText, photos.length === 0 && styles.sideButtonTextDisabled]}>
                Done ({photos.length})
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  camera: { flex: 1 },
  controls: { backgroundColor: "#000", paddingBottom: 24, paddingTop: 12 },
  thumbStrip: { maxHeight: 64, marginBottom: 12 },
  thumb: { width: 52, height: 52, borderRadius: 6, marginHorizontal: 4, backgroundColor: "#333" },
  buttonRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 24 },
  shutterButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "#fff",
    borderWidth: 4,
    borderColor: "#9ca3af",
  },
  sideButton: { minWidth: 70 },
  sideButtonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  sideButtonTextDisabled: { color: "#6b7280" },
  permissionContainer: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  permissionText: { fontSize: 16, textAlign: "center" },
  permissionButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 12 },
  permissionButtonText: { color: "#fff", fontWeight: "700" },
  cancelText: { color: "#6b7280", fontWeight: "600" },
});

import { useRef, useState } from "react";
import { FlatList, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions, type CameraType, type FlashMode } from "expo-camera";

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

// Zoom presets as fractions of expo-camera's `zoom` prop (0-1, "a percentage
// of device's max zoom" per its own docs - not a true optical multiplier).
// There's no cross-device API to learn the device's actual max zoom factor,
// so these are an approximation, not a calibrated 0.5x/2x/5x. In particular
// "0.5x" (wider-than-normal) can't be represented at all - expo-camera's
// zoom prop only zooms in from the default lens, it can't switch to an
// ultra-wide lens - so 0.5x is mapped to the same value as 1x rather than
// omitted, since a normal camera app always shows a 0.5x button even if this
// device/lens can't actually go wider.
const ZOOM_PRESETS: { label: string; value: number }[] = [
  { label: "0.5x", value: 0 },
  { label: "1x", value: 0 },
  { label: "2x", value: 0.25 },
  { label: "5x", value: 0.6 },
];

const FLASH_CYCLE: FlashMode[] = ["off", "on", "auto"];
const FLASH_LABELS: Record<FlashMode, string> = { off: "Off", on: "On", auto: "Auto", screen: "Screen" };

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
  const [facing, setFacing] = useState<CameraType>("back");
  const [flash, setFlash] = useState<FlashMode>("off");
  const [zoomLabel, setZoomLabel] = useState("1x");

  if (!visible) return null;

  const zoomValue = ZOOM_PRESETS.find((p) => p.label === zoomLabel)?.value ?? 0;

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

  const toggleFacing = () => setFacing((prev) => (prev === "back" ? "front" : "back"));
  const cycleFlash = () => setFlash((prev) => FLASH_CYCLE[(FLASH_CYCLE.indexOf(prev) + 1) % FLASH_CYCLE.length]);

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
        <CameraView ref={cameraRef} style={styles.camera} facing={facing} flash={flash} zoom={zoomValue}>
          <View style={styles.topControls}>
            <Pressable style={styles.topButton} onPress={cycleFlash}>
              <Text style={styles.topButtonText}>Flash: {FLASH_LABELS[flash]}</Text>
            </Pressable>
            <Pressable style={styles.topButton} onPress={toggleFacing}>
              <Text style={styles.topButtonText}>{facing === "back" ? "Front" : "Back"} camera</Text>
            </Pressable>
          </View>
        </CameraView>
        <View style={styles.controls}>
          <View style={styles.zoomRow}>
            {ZOOM_PRESETS.map((preset) => (
              <Pressable
                key={preset.label}
                style={[styles.zoomButton, zoomLabel === preset.label && styles.zoomButtonActive]}
                onPress={() => setZoomLabel(preset.label)}
              >
                <Text style={[styles.zoomButtonText, zoomLabel === preset.label && styles.zoomButtonTextActive]}>
                  {preset.label}
                </Text>
              </Pressable>
            ))}
          </View>
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
  topControls: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  topButton: {
    backgroundColor: "rgba(0,0,0,0.45)",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  topButtonText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  controls: { backgroundColor: "#000", paddingBottom: 24, paddingTop: 12 },
  zoomRow: { flexDirection: "row", justifyContent: "center", gap: 10, marginBottom: 12 },
  zoomButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  zoomButtonActive: { backgroundColor: "#fff" },
  zoomButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  zoomButtonTextActive: { color: "#000" },
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

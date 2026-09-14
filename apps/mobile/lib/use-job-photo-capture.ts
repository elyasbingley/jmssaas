import { useState } from "react";
import { Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { decode as decodeBase64 } from "base64-arraybuffer";
import type { CapturedPhoto } from "../components/MultiCaptureCamera";
import { addJobPhoto } from "./powersync";
import { useAuth } from "./auth-context";

function extensionFor(mimeType: string | undefined): string {
  return mimeType?.includes("png") ? "png" : "jpg";
}

// Headless (no thumbnail grid) camera/library capture for a job - same
// upload behaviour as components/theme/ThemedPhotoAttachments (used by the
// Diary screen's full Photos panel), extracted separately so the Job Card's
// Camera/Photo Library quick actions can trigger a capture directly from
// the bottom toolbar without needing that panel mounted.
export function useJobPhotoCapture(jobCardId: string) {
  const { profile } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [cameraVisible, setCameraVisible] = useState(false);

  const upload = async (photo: { base64: string; mimeType: string; fileExtension: string }) => {
    if (!profile) return;
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

  const handleCameraDone = async (captured: CapturedPhoto[]) => {
    setCameraVisible(false);
    for (const photo of captured) {
      await upload({ base64: photo.base64, mimeType: photo.mimeType, fileExtension: "jpg" });
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
      await upload({ base64: asset.base64, mimeType: asset.mimeType ?? "image/jpeg", fileExtension: extensionFor(asset.mimeType) });
    }
  };

  return { openCamera, pickFromLibrary, cameraVisible, setCameraVisible, handleCameraDone, uploading };
}

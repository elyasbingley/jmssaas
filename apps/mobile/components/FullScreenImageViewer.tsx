import ImageViewing from "react-native-image-viewing";

interface FullScreenImageViewerProps {
  visible: boolean;
  images: { uri: string }[];
  imageIndex: number;
  onRequestClose: () => void;
}

// Tap any job card / task photo to view it full-screen with pinch-to-zoom
// and swipe-to-dismiss, backed by react-native-image-viewing rather than a
// hand-rolled modal + Image.
export function FullScreenImageViewer({ visible, images, imageIndex, onRequestClose }: FullScreenImageViewerProps) {
  return <ImageViewing images={images} imageIndex={imageIndex} visible={visible} onRequestClose={onRequestClose} />;
}

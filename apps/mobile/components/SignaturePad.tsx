import { useRef, useState } from "react";
import { Image, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import ViewShot from "react-native-view-shot";

// Touch-based signature capture - the RN equivalent of desktop's canvas-based
// SignaturePad.tsx. There's no <canvas> in React Native, so strokes are
// tracked as PanResponder touch points, rendered live as an SVG Path, then
// rasterized to a PNG data URI via react-native-view-shot once the finger
// lifts - same output shape (a base64 PNG data URI, stored in
// report_signatures.signature_svg_data / a signature answer's svgData,
// despite the column name) as desktop's canvas.toDataURL("image/png").
//
// Unlike desktop, an existing `value` is shown as a static preview rather
// than a live canvas new strokes get added on top of - re-signing means
// clearing first. A deliberate simplification, not an oversight: a single
// continuous signature capture per sign-off is the real-world use case here.
export function SignaturePad({ value, onChange }: { value: string; onChange: (dataUrl: string) => void }) {
  const shotRef = useRef<ViewShot>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [capturing, setCapturing] = useState(false);

  const capture = async () => {
    if (!shotRef.current?.capture) return;
    setCapturing(true);
    try {
      const dataUri = await shotRef.current.capture();
      onChange(dataUri);
    } finally {
      setCapturing(false);
    }
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const { locationX, locationY } = e.nativeEvent;
        setPaths((prev) => [...prev, `M${locationX.toFixed(1)},${locationY.toFixed(1)}`]);
      },
      onPanResponderMove: (e) => {
        const { locationX, locationY } = e.nativeEvent;
        setPaths((prev) => {
          if (prev.length === 0) return prev;
          const next = [...prev];
          next[next.length - 1] = `${next[next.length - 1]} L${locationX.toFixed(1)},${locationY.toFixed(1)}`;
          return next;
        });
      },
      onPanResponderRelease: () => {
        capture();
      },
    })
  ).current;

  const clear = () => {
    setPaths([]);
    onChange("");
  };

  const showingExisting = !!value && paths.length === 0;

  return (
    <View>
      {showingExisting ? (
        <View style={styles.pad}>
          <Image source={{ uri: value }} style={styles.preview} resizeMode="contain" />
        </View>
      ) : (
        <ViewShot ref={shotRef} options={{ format: "png", result: "data-uri" }} style={styles.pad}>
          <View style={styles.padInner} {...panResponder.panHandlers}>
            <Svg style={StyleSheet.absoluteFill}>
              {paths.map((d, i) => (
                <Path key={i} d={d} stroke="#1f2937" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              ))}
            </Svg>
          </View>
        </ViewShot>
      )}
      <View style={styles.footer}>
        <Text style={styles.hint}>{capturing ? "Saving..." : "Sign above"}</Text>
        {value || paths.length > 0 ? (
          <Pressable onPress={clear}>
            <Text style={styles.clear}>Clear</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { width: "100%", height: 150, borderRadius: 8, borderWidth: 1, borderColor: "#d1d5db", backgroundColor: "#fff", overflow: "hidden" },
  padInner: { flex: 1 },
  preview: { flex: 1 },
  footer: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  hint: { fontSize: 12, color: "#9ca3af" },
  clear: { fontSize: 12, fontWeight: "700", color: "#dc2626" },
});

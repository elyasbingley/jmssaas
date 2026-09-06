import { useRef, useState } from "react";
import { Image, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle as SvgCircle, Line as SvgLine, Path, Polygon, Rect as SvgRect, Text as SvgText } from "react-native-svg";
import ViewShot from "react-native-view-shot";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { useAuth } from "../lib/auth-context";
import { addJobPhoto } from "../lib/powersync";
import { getErrorMessage } from "../lib/errors";
import { CenteredModal } from "./CenteredModal";
import { FormField } from "./FormField";

// Photo Markup & Annotation Tool (mobile) - same shape set as desktop's
// canvas-based PhotoMarkup.tsx (pen/line/arrow/rect/circle/text), but
// there's no <canvas> in React Native: strokes are tracked as
// PanResponder touch points and rendered live as react-native-svg
// elements (same approach SignaturePad.tsx already uses for a single
// freehand path), then the whole Image+Svg overlay is rasterized to a
// PNG via react-native-view-shot once "Save" is pressed - same library,
// same capture-to-PNG step, just with more shape types and a background
// photo. No Redo on mobile (Undo only) - a deliberate scope trim, not an
// oversight, to keep the touch toolbar to one row.
type Tool = "pen" | "line" | "arrow" | "rect" | "circle" | "text";
type Point = { x: number; y: number };

interface PenShape {
  type: "pen";
  d: string;
  color: string;
  strokeWidth: number;
}
interface LineShape {
  type: "line" | "arrow";
  from: Point;
  to: Point;
  color: string;
  strokeWidth: number;
}
interface RectShape {
  type: "rect" | "circle";
  from: Point;
  to: Point;
  color: string;
  strokeWidth: number;
}
interface TextShape {
  type: "text";
  position: Point;
  text: string;
  color: string;
}
type Shape = PenShape | LineShape | RectShape | TextShape;

const COLORS = ["#dc2626", "#eab308", "#16a34a", "#2563eb", "#ffffff"];
const STROKE_WIDTHS = [3, 6, 10];
const TOOLS: { key: Tool; label: string }[] = [
  { key: "pen", label: "Pen" },
  { key: "line", label: "Line" },
  { key: "arrow", label: "Arrow" },
  { key: "rect", label: "Rect" },
  { key: "circle", label: "Circle" },
  { key: "text", label: "Text" },
];

function arrowheadPoints(from: Point, to: Point): string {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 14;
  const p1 = { x: to.x - size * Math.cos(angle - Math.PI / 6), y: to.y - size * Math.sin(angle - Math.PI / 6) };
  const p2 = { x: to.x - size * Math.cos(angle + Math.PI / 6), y: to.y - size * Math.sin(angle + Math.PI / 6) };
  return `${to.x},${to.y} ${p1.x},${p1.y} ${p2.x},${p2.y}`;
}

function renderShape(shape: Shape, key: number) {
  switch (shape.type) {
    case "pen":
      return <Path key={key} d={shape.d} stroke={shape.color} strokeWidth={shape.strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
    case "line":
    case "arrow":
      return (
        <View key={key}>
          <SvgLine x1={shape.from.x} y1={shape.from.y} x2={shape.to.x} y2={shape.to.y} stroke={shape.color} strokeWidth={shape.strokeWidth} strokeLinecap="round" />
          {shape.type === "arrow" ? <Polygon points={arrowheadPoints(shape.from, shape.to)} fill={shape.color} /> : null}
        </View>
      );
    case "rect": {
      const x = Math.min(shape.from.x, shape.to.x);
      const y = Math.min(shape.from.y, shape.to.y);
      return <SvgRect key={key} x={x} y={y} width={Math.abs(shape.to.x - shape.from.x)} height={Math.abs(shape.to.y - shape.from.y)} stroke={shape.color} strokeWidth={shape.strokeWidth} fill="none" />;
    }
    case "circle": {
      const cx = (shape.from.x + shape.to.x) / 2;
      const cy = (shape.from.y + shape.to.y) / 2;
      const rx = Math.abs(shape.to.x - shape.from.x) / 2;
      const ry = Math.abs(shape.to.y - shape.from.y) / 2;
      return <SvgCircle key={key} cx={cx} cy={cy} r={Math.max(rx, ry)} stroke={shape.color} strokeWidth={shape.strokeWidth} fill="none" />;
    }
    case "text":
      return (
        <SvgText key={key} x={shape.position.x} y={shape.position.y} fill={shape.color} fontSize={22} fontWeight="bold">
          {shape.text}
        </SvgText>
      );
  }
}

export function PhotoMarkupEditor({
  jobCardId,
  photoUri,
  photoFileName,
  onSaved,
  onCancel,
}: {
  jobCardId: string;
  photoUri: string;
  photoFileName: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { profile } = useAuth();
  const shotRef = useRef<ViewShot>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]!);
  const [strokeWidth, setStrokeWidth] = useState(STROKE_WIDTHS[0]!);
  const [currentPath, setCurrentPath] = useState("");
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragEnd, setDragEnd] = useState<Point | null>(null);
  const [textModalVisible, setTextModalVisible] = useState(false);
  const [textInput, setTextInput] = useState("");
  const pendingTextPointRef = useRef<Point | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const { locationX, locationY } = e.nativeEvent;
        if (tool === "text") {
          pendingTextPointRef.current = { x: locationX, y: locationY };
          setTextInput("");
          setTextModalVisible(true);
          return;
        }
        if (tool === "pen") {
          setCurrentPath(`M${locationX.toFixed(1)},${locationY.toFixed(1)}`);
        } else {
          setDragStart({ x: locationX, y: locationY });
          setDragEnd({ x: locationX, y: locationY });
        }
      },
      onPanResponderMove: (e) => {
        const { locationX, locationY } = e.nativeEvent;
        if (tool === "pen") {
          setCurrentPath((prev) => (prev ? `${prev} L${locationX.toFixed(1)},${locationY.toFixed(1)}` : prev));
        } else if (tool !== "text") {
          setDragEnd({ x: locationX, y: locationY });
        }
      },
      onPanResponderRelease: () => {
        if (tool === "pen" && currentPath) {
          setShapes((prev) => [...prev, { type: "pen", d: currentPath, color, strokeWidth }]);
          setCurrentPath("");
        } else if (tool !== "text" && dragStart && dragEnd) {
          setShapes((prev) => [...prev, { type: tool, from: dragStart, to: dragEnd, color, strokeWidth } as Shape]);
          setDragStart(null);
          setDragEnd(null);
        }
      },
    })
  ).current;

  const handleConfirmText = () => {
    const point = pendingTextPointRef.current;
    if (point && textInput.trim()) {
      setShapes((prev) => [...prev, { type: "text", position: point, text: textInput.trim(), color }]);
    }
    setTextModalVisible(false);
  };

  const handleUndo = () => setShapes((prev) => prev.slice(0, -1));
  const handleClear = () => setShapes([]);

  const handleSave = async () => {
    if (!shotRef.current?.capture || !profile) return;
    setSaving(true);
    setSaveError(null);
    try {
      const base64 = await shotRef.current.capture();
      const baseName = photoFileName.replace(/\.[^.]+$/, "");
      await addJobPhoto({
        tenantId: profile.tenant_id,
        jobCardId,
        uploadedBy: profile.id,
        imageArrayBuffer: decodeBase64(base64),
        mediaType: "image/png",
        fileExtension: "png",
      });
      onSaved();
    } catch (e) {
      setSaveError(getErrorMessage(e, "Failed to save annotated photo"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.toolRow}>
        {TOOLS.map((t) => (
          <Pressable key={t.key} style={[styles.toolChip, tool === t.key && styles.toolChipActive]} onPress={() => setTool(t.key)}>
            <Text style={[styles.toolChipText, tool === t.key && styles.toolChipTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.controlRow}>
        <View style={styles.colorRow}>
          {COLORS.map((c) => (
            <Pressable key={c} onPress={() => setColor(c)} style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchActive]} />
          ))}
        </View>
        <View style={styles.widthRow}>
          {STROKE_WIDTHS.map((w) => (
            <Pressable key={w} onPress={() => setStrokeWidth(w)} style={[styles.widthDot, strokeWidth === w && styles.widthDotActive]}>
              <View style={{ width: w, height: w, borderRadius: w / 2, backgroundColor: "#374151" }} />
            </Pressable>
          ))}
        </View>
      </View>

      <ViewShot ref={shotRef} options={{ format: "png", result: "base64" }} style={styles.canvasWrap}>
        <View style={styles.canvas} {...panResponder.panHandlers}>
          <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <Svg style={StyleSheet.absoluteFill}>
            {shapes.map((s, i) => renderShape(s, i))}
            {currentPath ? <Path d={currentPath} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" /> : null}
            {tool !== "pen" && tool !== "text" && dragStart && dragEnd ? renderShape({ type: tool, from: dragStart, to: dragEnd, color, strokeWidth } as Shape, -1) : null}
          </Svg>
        </View>
      </ViewShot>

      <View style={styles.actionRow}>
        <Pressable onPress={handleUndo} disabled={shapes.length === 0}>
          <Text style={[styles.actionLink, shapes.length === 0 && styles.actionLinkDisabled]}>Undo</Text>
        </Pressable>
        <Pressable onPress={handleClear}>
          <Text style={styles.actionLink}>Clear</Text>
        </Pressable>
        <Pressable onPress={onCancel}>
          <Text style={styles.actionLink}>Cancel</Text>
        </Pressable>
      </View>

      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
      <Pressable style={[styles.saveButton, saving && styles.saveButtonDisabled]} onPress={handleSave} disabled={saving}>
        <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save Annotated Photo"}</Text>
      </Pressable>

      <CenteredModal visible={textModalVisible} onClose={() => setTextModalVisible(false)}>
        <Text style={styles.modalTitle}>Add text</Text>
        <FormField label="Text" placeholder="e.g. Damaged tile" value={textInput} onChangeText={setTextInput} autoFocus />
        <View style={styles.modalActions}>
          <Pressable onPress={() => setTextModalVisible(false)}>
            <Text style={styles.actionLink}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.confirmButton} onPress={handleConfirmText}>
            <Text style={styles.saveButtonText}>Add</Text>
          </Pressable>
        </View>
      </CenteredModal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  toolRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  toolChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: "#f3f4f6" },
  toolChipActive: { backgroundColor: "#1d4ed8" },
  toolChipText: { fontSize: 12, fontWeight: "600", color: "#374151" },
  toolChipTextActive: { color: "#fff" },
  controlRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  colorRow: { flexDirection: "row", gap: 8 },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: "transparent" },
  swatchActive: { borderColor: "#1d4ed8" },
  widthRow: { flexDirection: "row", gap: 10 },
  widthDot: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#f3f4f6" },
  widthDotActive: { backgroundColor: "#dbeafe" },
  canvasWrap: { width: "100%", aspectRatio: 1, borderRadius: 8, overflow: "hidden", backgroundColor: "#000" },
  canvas: { flex: 1 },
  actionRow: { flexDirection: "row", gap: 20, marginTop: 10 },
  actionLink: { color: "#1d4ed8", fontWeight: "700" },
  actionLinkDisabled: { color: "#d1d5db" },
  error: { color: "#dc2626", marginTop: 8 },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingVertical: 14, alignItems: "center", marginTop: 12 },
  saveButtonDisabled: { opacity: 0.6 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  confirmButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
});

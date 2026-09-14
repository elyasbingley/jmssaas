import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobFile } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { uploadJobPhoto } from "../../lib/uploads";

// Photo Markup & Annotation Tool - a plain HTML5 canvas editor, no
// external drawing library (none installed, and the shape set here -
// line/arrow/rectangle/circle/freehand/text - is small enough that
// hand-rolled hit-testing/redraw is simpler than pulling one in). Every
// shape is recorded as data (not baked into the canvas immediately),
// so Undo/Redo/Clear just replay a shorter/longer shape list against a
// freshly redrawn base image rather than needing pixel-level undo.

type Tool = "select" | "text" | "line" | "arrow" | "rect" | "circle" | "pen";
type Point = { x: number; y: number };

interface BaseShape {
  color: string;
  strokeWidth: number;
}
interface LineShape extends BaseShape {
  type: "line" | "arrow";
  from: Point;
  to: Point;
}
interface RectShape extends BaseShape {
  type: "rect" | "circle";
  from: Point;
  to: Point;
}
interface PenShape extends BaseShape {
  type: "pen";
  points: Point[];
}
interface TextShape extends BaseShape {
  type: "text";
  position: Point;
  text: string;
}
type Shape = LineShape | RectShape | PenShape | TextShape;

const COLORS = ["#dc2626", "#eab308", "#16a34a", "#2563eb", "#ffffff"];
const TOOLS: { key: Tool; label: string }[] = [
  { key: "pen", label: "Pen" },
  { key: "line", label: "Line" },
  { key: "arrow", label: "Arrow" },
  { key: "rect", label: "Rectangle" },
  { key: "circle", label: "Circle" },
  { key: "text", label: "Text" },
];

function drawArrowhead(ctx: CanvasRenderingContext2D, from: Point, to: Point, color: string) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 14;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle - Math.PI / 6), to.y - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(to.x - size * Math.cos(angle + Math.PI / 6), to.y - size * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape) {
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = shape.strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (shape.type === "pen") {
    if (shape.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(shape.points[0]!.x, shape.points[0]!.y);
    for (const p of shape.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (shape.type === "line" || shape.type === "arrow") {
    ctx.beginPath();
    ctx.moveTo(shape.from.x, shape.from.y);
    ctx.lineTo(shape.to.x, shape.to.y);
    ctx.stroke();
    if (shape.type === "arrow") drawArrowhead(ctx, shape.from, shape.to, shape.color);
  } else if (shape.type === "rect") {
    ctx.strokeRect(shape.from.x, shape.from.y, shape.to.x - shape.from.x, shape.to.y - shape.from.y);
  } else if (shape.type === "circle") {
    const rx = Math.abs(shape.to.x - shape.from.x) / 2;
    const ry = Math.abs(shape.to.y - shape.from.y) / 2;
    const cx = (shape.from.x + shape.to.x) / 2;
    const cy = (shape.from.y + shape.to.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (shape.type === "text") {
    ctx.font = `bold ${Math.max(shape.strokeWidth * 8, 18)}px sans-serif`;
    ctx.fillText(shape.text, shape.position.x, shape.position.y);
  }
}

async function fetchPhotos(jobCardId: string): Promise<JobFile[]> {
  const { data, error } = await supabase.from("job_files").select("*").eq("job_card_id", jobCardId).order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobFile[];
}
async function fetchPhotoUrls(files: JobFile[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    files.map(async (f) => {
      const { data } = await supabase.storage.from("job-files").createSignedUrl(f.storage_path, 3600);
      return [f.id, data?.signedUrl ?? ""] as const;
    })
  );
  return Object.fromEntries(entries);
}

export function PhotoMarkup({ jobCardId }: { jobCardId: string }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data: files } = useQuery({ queryKey: ["job-files", jobCardId], queryFn: () => fetchPhotos(jobCardId) });
  const { data: fileUrls } = useQuery({
    queryKey: ["job-file-urls", jobCardId, files?.map((f) => f.id).join(",")],
    queryFn: () => fetchPhotoUrls(files!),
    enabled: !!files && files.length > 0,
  });

  const [editingFile, setEditingFile] = useState<JobFile | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [redoStack, setRedoStack] = useState<Shape[]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]!);
  const [strokeWidth, setStrokeWidth] = useState(4);
  const drawingRef = useRef<{ start: Point; live: Point[] } | null>(null);

  const redraw = () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const shape of shapes) drawShape(ctx, shape);
  };

  useEffect(() => {
    if (!editingFile) return;
    const url = fileUrls?.[editingFile.id];
    if (!url) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        const maxWidth = 900;
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        canvas.width = img.naturalWidth * scale;
        canvas.height = img.naturalHeight * scale;
        redraw();
      }
    };
    img.src = url;
    setShapes([]);
    setRedoStack([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingFile, fileUrls]);

  useEffect(() => {
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes]);

  const getPoint = (e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const point = getPoint(e);
    if (tool === "text") {
      const text = window.prompt("Text to add:");
      if (text && text.trim()) {
        setShapes((prev) => [...prev, { type: "text", position: point, text: text.trim(), color, strokeWidth }]);
        setRedoStack([]);
      }
      return;
    }
    if (tool === "pen") {
      drawingRef.current = { start: point, live: [point] };
    } else {
      drawingRef.current = { start: point, live: [point] };
    }
  };
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const point = getPoint(e);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (tool === "pen") {
      drawingRef.current.live.push(point);
      redraw();
      drawShape(ctx, { type: "pen", points: drawingRef.current.live, color, strokeWidth });
    } else if (tool === "line" || tool === "arrow" || tool === "rect" || tool === "circle") {
      redraw();
      drawShape(ctx, { type: tool, from: drawingRef.current.start, to: point, color, strokeWidth } as Shape);
    }
  };
  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const point = getPoint(e);
    if (tool === "pen") {
      if (drawingRef.current.live.length >= 2) {
        setShapes((prev) => [...prev, { type: "pen", points: drawingRef.current!.live, color, strokeWidth }]);
        setRedoStack([]);
      }
    } else if (tool === "line" || tool === "arrow" || tool === "rect" || tool === "circle") {
      setShapes((prev) => [...prev, { type: tool, from: drawingRef.current!.start, to: point, color, strokeWidth } as Shape]);
      setRedoStack([]);
    }
    drawingRef.current = null;
  };

  const handleUndo = () => {
    setShapes((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1]!;
      setRedoStack((r) => [...r, last]);
      return prev.slice(0, -1);
    });
  };
  const handleRedo = () => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1]!;
      setShapes((s) => [...s, last]);
      return prev.slice(0, -1);
    });
  };
  const handleClear = () => {
    setShapes([]);
    setRedoStack([]);
  };

  const [saveError, setSaveError] = useState<string | null>(null);
  const saveAnnotated = useMutation({
    mutationFn: async () => {
      if (!profile || !editingFile) throw new Error("Not signed in");
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("Nothing to save");
      const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to export image"))), "image/png");
      });
      const baseName = editingFile.file_name.replace(/\.[^.]+$/, "");
      const file = new File([blob], `${baseName}_annotated.png`, { type: "image/png" });
      await uploadJobPhoto({ tenantId: profile.tenant_id, jobCardId, uploadedBy: profile.id, file });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-files", jobCardId] });
      setEditingFile(null);
      setSaveError(null);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save annotated photo")),
  });

  if (editingFile) {
    return (
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {TOOLS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTool(t.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${tool === t.key ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"}`}
            >
              {t.label}
            </button>
          ))}
          <div className="flex items-center gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                style={{ backgroundColor: c }}
                className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-blue-700" : "border-gray-300"}`}
              />
            ))}
          </div>
          <label className="flex items-center gap-1 text-xs text-gray-600">
            Thickness
            <input type="range" min={1} max={12} value={strokeWidth} onChange={(e) => setStrokeWidth(Number(e.target.value))} />
          </label>
          <button onClick={handleUndo} disabled={shapes.length === 0} className="rounded-md bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700 disabled:opacity-40">
            Undo
          </button>
          <button onClick={handleRedo} disabled={redoStack.length === 0} className="rounded-md bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700 disabled:opacity-40">
            Redo
          </button>
          <button onClick={handleClear} className="rounded-md bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700">
            Clear
          </button>
        </div>

        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          className="cursor-crosshair rounded-lg border border-gray-300"
        />

        {saveError ? <p className="mt-2 text-sm text-red-600">{saveError}</p> : null}
        <div className="mt-3 flex gap-2">
          <button onClick={() => setEditingFile(null)} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={() => saveAnnotated.mutate()}
            disabled={saveAnnotated.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveAnnotated.isPending ? "Saving..." : "Save Annotated Photo"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 text-sm text-gray-500">Pick a photo to annotate. The annotated copy is saved as a new attachment.</p>
      {!files || files.length === 0 ? (
        <p className="text-sm text-gray-500">No photos on this job yet - add some from the Photos section above.</p>
      ) : (
        <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
          {files.map((f) => (
            <button
              key={f.id}
              onClick={() => setEditingFile(f)}
              className="aspect-square overflow-hidden rounded-md border border-gray-300 bg-gray-100 hover:border-blue-400"
            >
              {fileUrls?.[f.id] ? <img src={fileUrls[f.id]} alt={f.file_name} className="h-full w-full object-cover" /> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

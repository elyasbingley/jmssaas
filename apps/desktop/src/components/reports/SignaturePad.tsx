import { useEffect, useRef, useState } from "react";

// Canvas-based signature capture. Stored as a base64 PNG data URI in
// report_signatures.signature_svg_data / the signature answer's svgData -
// the spec's own column comment allows "Text / Base64", so a raster data
// URI satisfies that without needing real SVG path tracing (a canvas
// <-> SVG stroke-recorder is a lot more code for no functional gain here,
// since the only consumers are <img src> in the UI and jsPDF's addImage,
// both of which take a PNG data URI directly).
export function SignaturePad({ value, onChange }: { value: string; onChange: (dataUrl: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [hasStroke, setHasStroke] = useState(!!value);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1f2937";
    if (value) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.src = value;
    }
  }, [value]);

  const pointerPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    setDrawing(true);
    const { x, y } = pointerPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = pointerPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasStroke(true);
  };

  const end = () => {
    if (!drawing) return;
    setDrawing(false);
    const canvas = canvasRef.current;
    if (canvas) onChange(canvas.toDataURL("image/png"));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasStroke(false);
    onChange("");
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={400}
        height={150}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        className="w-full cursor-crosshair rounded-md border border-gray-300 bg-white touch-none"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className="text-xs text-gray-400">Sign above</span>
        {hasStroke ? (
          <button onClick={clear} type="button" className="text-xs font-semibold text-red-600 hover:underline">
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createJobLinearMeasurementSchema,
  type Coordinate,
  type JobLinearMeasurement,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { loadGoogleMaps } from "../../lib/google-maps";
import { FormField } from "../FormField";

// Linear Distance Measurer - draws named straight-line runs (gutters,
// downpipes, flashing, fencing) over a satellite map and sums their
// lengths via google.maps.geometry.spherical.computeLength(). Modeled
// directly on JobMeasure.tsx's map/click/overlay pattern (polygons there,
// polylines here) - same click-to-add-point interaction, same
// loadGoogleMaps() helper, same "save, then optionally push a summary
// into job_notes" flow as the roof measurement tool.

interface DraftSegment {
  id: string;
  label: string;
  coordinates: Coordinate[];
}

const SEGMENT_COLORS = ["#1d4ed8", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2"];
const DEFAULT_CENTER = { lat: -33.8688, lng: 151.2093 };
const ZOOM = 20;

function segmentLengthMeters(coordinates: Coordinate[]): number {
  if (coordinates.length < 2 || typeof google === "undefined") return 0;
  const path = coordinates.map((c) => new google.maps.LatLng(c.lat, c.lng));
  return google.maps.geometry.spherical.computeLength(path);
}

async function fetchMeasurements(jobCardId: string): Promise<JobLinearMeasurement[]> {
  const { data, error } = await supabase
    .from("job_linear_measurements")
    .select("*")
    .eq("job_card_id", jobCardId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobLinearMeasurement[];
}

export function LinearMeasurer({ jobCardId }: { jobCardId: string }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data: measurements } = useQuery({ queryKey: ["job-linear-measurements", jobCardId], queryFn: () => fetchMeasurements(jobCardId) });

  const [drawing, setDrawing] = useState(false);
  const [title, setTitle] = useState("");
  const [segments, setSegments] = useState<DraftSegment[]>([]);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const activeSegmentIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeSegmentIdRef.current = activeSegmentId;
  }, [activeSegmentId]);

  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const overlaysRef = useRef<Map<string, { polyline?: google.maps.Polyline; markers: google.maps.Marker[] }>>(new Map());
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    if (!drawing || !mapDivRef.current || mapInstanceRef.current) return;
    let cancelled = false;
    let clickListener: google.maps.MapsEventListener | undefined;

    loadGoogleMaps()
      .then((g) => {
        if (cancelled || !mapDivRef.current) return;
        const map = new g.maps.Map(mapDivRef.current, {
          center: DEFAULT_CENTER,
          zoom: ZOOM,
          mapTypeId: "satellite",
          tilt: 0,
          streetViewControl: false,
          fullscreenControl: false,
        });
        mapInstanceRef.current = map;
        clickListener = map.addListener("click", (e: google.maps.MapMouseEvent) => {
          const activeId = activeSegmentIdRef.current;
          if (!activeId || !e.latLng) return;
          const lat = e.latLng.lat();
          const lng = e.latLng.lng();
          setSegments((prev) => prev.map((s) => (s.id === activeId ? { ...s, coordinates: [...s.coordinates, { lat, lng }] } : s)));
        });
      })
      .catch((e) => setMapError(getErrorMessage(e, "Failed to load Google Maps")));

    return () => {
      cancelled = true;
      clickListener?.remove();
    };
  }, [drawing]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    for (const [id, overlay] of overlaysRef.current) {
      if (!segments.find((s) => s.id === id)) {
        overlay.polyline?.setMap(null);
        overlay.markers.forEach((m) => m.setMap(null));
        overlaysRef.current.delete(id);
      }
    }
    segments.forEach((segment, index) => {
      const color = SEGMENT_COLORS[index % SEGMENT_COLORS.length]!;
      let overlay = overlaysRef.current.get(segment.id);
      if (!overlay) {
        overlay = { markers: [] };
        overlaysRef.current.set(segment.id, overlay);
      }
      overlay.markers.forEach((m) => m.setMap(null));
      overlay.markers = segment.coordinates.map(
        (c) =>
          new google.maps.Marker({
            position: c,
            map,
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: color, fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2 },
          })
      );
      overlay.polyline?.setMap(null);
      overlay.polyline = undefined;
      if (segment.coordinates.length >= 2) {
        overlay.polyline = new google.maps.Polyline({ path: segment.coordinates, strokeColor: color, strokeWeight: 3, map });
      }
    });
  }, [segments]);

  const segmentLengths = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of segments) map.set(s.id, segmentLengthMeters(s.coordinates));
    return map;
  }, [segments]);
  const totalLength = segments.reduce((sum, s) => sum + (segmentLengths.get(s.id) ?? 0), 0);

  const resetDraft = () => {
    setDrawing(false);
    setTitle("");
    setSegments([]);
    setActiveSegmentId(null);
    mapInstanceRef.current = null;
    overlaysRef.current.clear();
  };

  const handleNewSegment = () => {
    const id = crypto.randomUUID();
    setSegments((prev) => [...prev, { id, label: `Run ${prev.length + 1}`, coordinates: [] }]);
    setActiveSegmentId(id);
  };
  const handleFinishSegment = () => setActiveSegmentId(null);
  const handleDeleteSegment = (segmentId: string) => {
    setSegments((prev) => prev.filter((s) => s.id !== segmentId));
    if (activeSegmentId === segmentId) setActiveSegmentId(null);
  };
  const handleUndoPoint = () => {
    if (!activeSegmentId) return;
    setSegments((prev) => prev.map((s) => (s.id === activeSegmentId ? { ...s, coordinates: s.coordinates.slice(0, -1) } : s)));
  };

  const savableSegments = segments.filter((s) => s.coordinates.length >= 2);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const finalSegments = savableSegments.map((s) => ({
        id: s.id,
        label: s.label,
        coordinates: s.coordinates,
        length_meters: Math.round((segmentLengths.get(s.id) ?? 0) * 100) / 100,
      }));
      const result = createJobLinearMeasurementSchema.safeParse({
        job_card_id: jobCardId,
        title: title.trim() || "Linear Measurement",
        segments: finalSegments,
        total_length_meters: Math.round(totalLength * 100) / 100,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid measurement");

      const { error } = await supabase.from("job_linear_measurements").insert({
        tenant_id: profile.tenant_id,
        job_card_id: jobCardId,
        title: result.data.title,
        segments: result.data.segments,
        total_length_meters: result.data.total_length_meters,
        created_by: profile.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-linear-measurements", jobCardId] });
      resetDraft();
      setSaveError(null);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save measurement")),
  });

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyToNotes = useMutation({
    mutationFn: async (measurement: JobLinearMeasurement) => {
      if (!profile) throw new Error("Not signed in");
      const lines = [
        `Linear Measurement - ${measurement.title}`,
        `Total: ${measurement.total_length_meters.toFixed(1)} m`,
        "",
        ...measurement.segments.map((s) => `${s.label}: ${s.length_meters.toFixed(1)} m`),
      ];
      const { error } = await supabase.from("job_notes").insert({
        tenant_id: profile.tenant_id,
        job_card_id: jobCardId,
        author_id: profile.id,
        body: lines.join("\n"),
      });
      if (error) throw error;
    },
    onSuccess: (_data, measurement) => {
      setCopiedId(measurement.id);
      setTimeout(() => setCopiedId(null), 3000);
    },
  });

  if (!drawing) {
    return (
      <div>
        <button onClick={() => setDrawing(true)} className="mb-4 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800">
          + New Measurement Set
        </button>
        {!measurements || measurements.length === 0 ? (
          <p className="text-sm text-gray-500">No linear measurements saved yet.</p>
        ) : (
          <div className="space-y-3">
            {measurements.map((m) => (
              <div key={m.id} className="rounded-lg border border-gray-200 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-900">{m.title}</p>
                  <p className="text-sm font-bold text-blue-700">{m.total_length_meters.toFixed(1)} m</p>
                </div>
                <p className="mb-2 text-xs text-gray-500">
                  {m.segments.map((s) => `${s.label}: ${s.length_meters.toFixed(1)}m`).join(" · ")}
                </p>
                <button
                  onClick={() => copyToNotes.mutate(m)}
                  disabled={copyToNotes.isPending}
                  className="text-xs font-semibold text-blue-700 hover:underline disabled:opacity-60"
                >
                  {copiedId === m.id ? "Copied to Job Notes" : "Copy Summary to Job Notes"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <FormField label="Measurement set name" placeholder='e.g. "Gutter Lengths"' value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="ml-4 flex-shrink-0 text-right">
          <p className="text-xs text-gray-500">Total length</p>
          <p className="text-lg font-bold text-blue-700">{totalLength.toFixed(1)} m</p>
        </div>
      </div>

      <div className="flex gap-4">
        <div className="h-[420px] flex-1 overflow-hidden rounded-lg border border-gray-300 bg-gray-100">
          {mapError ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-red-600">{mapError}</div>
          ) : (
            <div ref={mapDivRef} className="h-full w-full" />
          )}
        </div>

        <div className="flex h-[420px] w-80 flex-shrink-0 flex-col overflow-hidden rounded-lg border border-gray-300 bg-white">
          <div className="flex-1 overflow-y-auto p-3">
            {!activeSegmentId && segments.length === 0 ? (
              <p className="mb-3 text-xs text-gray-500">Click "+ New Run" below, then click the map to trace a straight run.</p>
            ) : activeSegmentId ? (
              <p className="mb-3 text-xs text-gray-500">Click the map to add points along this run, then "Finish run".</p>
            ) : null}
            <div className="space-y-2">
              {segments.map((segment, index) => {
                const isActive = segment.id === activeSegmentId;
                return (
                  <div key={segment.id} className={`rounded-lg p-2 ${isActive ? "bg-blue-50" : "bg-gray-50"}`}>
                    <div className="mb-1 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: SEGMENT_COLORS[index % SEGMENT_COLORS.length] }} />
                        <input
                          value={segment.label}
                          onChange={(e) => setSegments((prev) => prev.map((s) => (s.id === segment.id ? { ...s, label: e.target.value } : s)))}
                          className="w-32 rounded border border-transparent bg-transparent text-sm font-semibold text-gray-900 hover:border-gray-300 focus:border-blue-400 focus:outline-none"
                        />
                      </div>
                      <button onClick={() => handleDeleteSegment(segment.id)} className="text-xs font-semibold text-red-600">
                        Delete
                      </button>
                    </div>
                    <p className="text-xs text-gray-700">{(segmentLengths.get(segment.id) ?? 0).toFixed(1)} m</p>
                    {isActive ? (
                      <div className="mt-1 flex justify-between text-xs">
                        <button onClick={handleUndoPoint} disabled={segment.coordinates.length === 0} className="font-semibold text-blue-700 disabled:text-gray-400">
                          Undo last point
                        </button>
                        <button onClick={handleFinishSegment} disabled={segment.coordinates.length < 2} className="font-semibold text-blue-700 disabled:text-gray-400">
                          Finish run
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {!activeSegmentId ? (
              <button onClick={handleNewSegment} className="mt-3 w-full rounded-md bg-blue-700 py-2 text-sm font-semibold text-white hover:bg-blue-800">
                + New Run
              </button>
            ) : null}
          </div>
          <div className="border-t border-gray-300 p-3">
            {saveError ? <p className="mb-2 text-xs text-red-600">{saveError}</p> : null}
            <div className="flex gap-2">
              <button onClick={resetDraft} className="flex-1 rounded-md border border-gray-300 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending || savableSegments.length === 0}
                className="flex-1 rounded-md bg-blue-700 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
              >
                {save.isPending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

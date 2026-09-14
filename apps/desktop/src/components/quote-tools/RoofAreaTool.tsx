import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createJobMeasurementSchema,
  polygonFlatAreaSqm,
  trueAreaSqm,
  type Client,
  type ClientSite,
  type Coordinate,
  type Facet,
  type JobCard,
  type JobMeasurement,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { formatClientAddress } from "../../lib/format";
import { loadGoogleMaps } from "../../lib/google-maps";
import { uploadJobPhoto } from "../../lib/uploads";
import { Modal } from "../Modal";
import { FormField } from "../FormField";

// Roof Area Tool - folded into the Quote Tools hub (previously its own
// full-page route, /jobs/:id/measure/JobMeasure.tsx) so it sits alongside
// the other 5 site-estimating tools instead of being a separate
// navigation away from the job card. Drawing logic is otherwise
// unchanged from JobMeasure.tsx - same map/click/overlay pattern, same
// loadGoogleMaps() helper, same "save, then push a summary into
// job_notes" flow - just sized to run inside the Quote Tools panel
// rather than a full page.

interface DraftFacet {
  id: string;
  name: string;
  pitch_degrees: number;
  coordinates: Coordinate[];
  finished: boolean;
}

const FACET_COLORS = ["#1d4ed8", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2"];
const DEFAULT_CENTER = { lat: -33.8688, lng: 151.2093 };
const FACET_ZOOM = 20;

async function fetchJob(id: string): Promise<JobCard> {
  const { data, error } = await supabase.from("job_cards").select("*").eq("id", id).single();
  if (error) throw error;
  return data as JobCard;
}
async function fetchClient(id: string): Promise<Client> {
  const { data, error } = await supabase.from("clients").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Client;
}
async function fetchSite(id: string): Promise<ClientSite> {
  const { data, error } = await supabase.from("client_sites").select("*").eq("id", id).single();
  if (error) throw error;
  return data as ClientSite;
}
async function fetchMeasurements(jobCardId: string): Promise<JobMeasurement[]> {
  const { data, error } = await supabase.from("job_measurements").select("*").eq("job_card_id", jobCardId).order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobMeasurement[];
}

function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation not available"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 });
  });
}

export function RoofAreaTool({ jobCardId }: { jobCardId: string }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: job } = useQuery({ queryKey: ["job", jobCardId], queryFn: () => fetchJob(jobCardId) });
  const { data: client } = useQuery({ queryKey: ["client", job?.client_id], queryFn: () => fetchClient(job!.client_id), enabled: !!job });
  const { data: site } = useQuery({ queryKey: ["client-site", job?.site_id], queryFn: () => fetchSite(job!.site_id!), enabled: !!job?.site_id });
  const { data: measurements } = useQuery({ queryKey: ["job-measurements", jobCardId], queryFn: () => fetchMeasurements(jobCardId) });

  const address =
    (job?.site_id ? formatClientAddress(site ?? { address_line1: null, address_line2: null, suburb: null, state: null, postcode: null }) : null) ??
    (client ? formatClientAddress(client) : null);

  const [drawing, setDrawing] = useState(false);
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const overlaysRef = useRef<Map<string, { polygon?: google.maps.Polygon; polyline?: google.maps.Polyline; markers: google.maps.Marker[] }>>(new Map());
  const activeFacetIdRef = useRef<string | null>(null);

  const [region, setRegion] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(true);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    if (!drawing || !job) return;
    let cancelled = false;

    async function resolveRegion() {
      if (address) {
        try {
          const google = await loadGoogleMaps();
          const geocoder = new google.maps.Geocoder();
          const { results } = await geocoder.geocode({ address: address! });
          const first = results[0];
          if (first && !cancelled) {
            setRegion({ lat: first.geometry.location.lat(), lng: first.geometry.location.lng() });
            setLocating(false);
            return;
          }
        } catch (e) {
          console.error("[RoofAreaTool] Geocoding failed, falling back", e);
        }
      }
      try {
        const position = await getCurrentPosition();
        if (!cancelled) {
          setRegion({ lat: position.coords.latitude, lng: position.coords.longitude });
          setLocating(false);
          return;
        }
      } catch (e) {
        console.error("[RoofAreaTool] Browser geolocation failed, falling back to default region", e);
      }
      if (!cancelled) {
        setRegion(DEFAULT_CENTER);
        setLocating(false);
      }
    }

    resolveRegion();
    return () => {
      cancelled = true;
    };
  }, [drawing, job, address]);

  const [facets, setFacets] = useState<DraftFacet[]>([]);
  const [activeFacetId, setActiveFacetId] = useState<string | null>(null);
  useEffect(() => {
    activeFacetIdRef.current = activeFacetId;
  }, [activeFacetId]);

  const facetAreas = useMemo(() => {
    const map = new Map<string, { flat: number; true: number }>();
    for (const facet of facets) {
      const flat = polygonFlatAreaSqm(facet.coordinates);
      map.set(facet.id, { flat, true: trueAreaSqm(flat, facet.pitch_degrees) });
    }
    return map;
  }, [facets]);

  const totalFlat = facets.reduce((sum, f) => sum + (facetAreas.get(f.id)?.flat ?? 0), 0);
  const totalTrue = facets.reduce((sum, f) => sum + (facetAreas.get(f.id)?.true ?? 0), 0);

  useEffect(() => {
    if (!region || !mapDivRef.current || mapInstanceRef.current) return;
    let cancelled = false;
    let clickListener: google.maps.MapsEventListener | undefined;

    loadGoogleMaps()
      .then((google) => {
        if (cancelled || !mapDivRef.current) return;
        const map = new google.maps.Map(mapDivRef.current, {
          center: region,
          zoom: FACET_ZOOM,
          mapTypeId: "satellite",
          tilt: 0,
          streetViewControl: false,
          fullscreenControl: false,
        });
        mapInstanceRef.current = map;
        clickListener = map.addListener("click", (e: google.maps.MapMouseEvent) => {
          const activeId = activeFacetIdRef.current;
          if (!activeId || !e.latLng) return;
          const lat = e.latLng.lat();
          const lng = e.latLng.lng();
          setFacets((prev) => prev.map((f) => (f.id === activeId ? { ...f, coordinates: [...f.coordinates, { lat, lng }] } : f)));
        });
      })
      .catch((e) => setMapError(getErrorMessage(e, "Failed to load Google Maps")));

    return () => {
      cancelled = true;
      clickListener?.remove();
    };
  }, [region]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    for (const [id, overlay] of overlaysRef.current) {
      if (!facets.find((f) => f.id === id)) {
        overlay.polygon?.setMap(null);
        overlay.polyline?.setMap(null);
        overlay.markers.forEach((m) => m.setMap(null));
        overlaysRef.current.delete(id);
      }
    }

    facets.forEach((facet, index) => {
      const color = FACET_COLORS[index % FACET_COLORS.length]!;
      let overlay = overlaysRef.current.get(facet.id);
      if (!overlay) {
        overlay = { markers: [] };
        overlaysRef.current.set(facet.id, overlay);
      }

      overlay.markers.forEach((m) => m.setMap(null));
      overlay.markers = facet.coordinates.map(
        (c) =>
          new google.maps.Marker({
            position: c,
            map,
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: color, fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2 },
          })
      );

      overlay.polygon?.setMap(null);
      overlay.polygon = undefined;
      overlay.polyline?.setMap(null);
      overlay.polyline = undefined;

      if (facet.coordinates.length >= 3) {
        overlay.polygon = new google.maps.Polygon({ paths: facet.coordinates, strokeColor: color, strokeWeight: 2, fillColor: color, fillOpacity: 0.35, map });
      } else if (facet.coordinates.length === 2) {
        overlay.polyline = new google.maps.Polyline({ path: facet.coordinates, strokeColor: color, strokeWeight: 2, map });
      }
    });
  }, [facets]);

  const resetDraft = () => {
    setDrawing(false);
    setFacets([]);
    setActiveFacetId(null);
    mapInstanceRef.current = null;
    overlaysRef.current.clear();
  };

  const handleNewFacet = () => {
    const id = crypto.randomUUID();
    setFacets((prev) => [...prev, { id, name: `Facet ${prev.length + 1}`, pitch_degrees: 22.5, coordinates: [], finished: false }]);
    setActiveFacetId(id);
  };
  const handleUndoPoint = () => {
    if (!activeFacetId) return;
    setFacets((prev) => prev.map((f) => (f.id === activeFacetId ? { ...f, coordinates: f.coordinates.slice(0, -1) } : f)));
  };
  const handleFinishFacet = () => {
    setFacets((prev) => prev.map((f) => (f.id === activeFacetId ? { ...f, finished: true } : f)));
    setActiveFacetId(null);
  };
  const handleDeleteFacet = (facetId: string) => {
    setFacets((prev) => prev.filter((f) => f.id !== facetId));
    if (activeFacetId === facetId) setActiveFacetId(null);
  };
  const handlePitchChange = (facetId: string, delta: number) => {
    setFacets((prev) => prev.map((f) => (f.id === facetId ? { ...f, pitch_degrees: Math.max(0, Math.min(60, f.pitch_degrees + delta)) } : f)));
  };

  const [renamingFacetId, setRenamingFacetId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const openRenameFacet = (facet: DraftFacet) => {
    setRenamingFacetId(facet.id);
    setRenameValue(facet.name);
  };
  const handleSaveRename = () => {
    setFacets((prev) => prev.map((f) => (f.id === renamingFacetId ? { ...f, name: renameValue.trim() || f.name } : f)));
    setRenamingFacetId(null);
  };

  const savableFacets = facets.filter((f) => f.coordinates.length >= 3);

  function buildSnapshotUrl(): string {
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    const url = new URL("https://maps.googleapis.com/maps/api/staticmap");
    url.searchParams.set("size", "640x400");
    url.searchParams.set("maptype", "satellite");
    url.searchParams.set("key", apiKey ?? "");
    savableFacets.forEach((facet, index) => {
      const color = FACET_COLORS[index % FACET_COLORS.length]!.replace("#", "0x");
      const closed = [...facet.coordinates, facet.coordinates[0]!];
      const points = closed.map((c) => `${c.lat},${c.lng}`).join("|");
      url.searchParams.append("path", `color:${color}ff|weight:2|fillcolor:${color}55|${points}`);
    });
    return url.toString();
  }

  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (!job || !profile || savableFacets.length === 0) throw new Error("Draw at least one facet first");

      const finalFacets: Facet[] = savableFacets.map((f) => {
        const areas = facetAreas.get(f.id) ?? { flat: 0, true: 0 };
        return {
          id: f.id,
          name: f.name,
          pitch_degrees: f.pitch_degrees,
          flat_area_sqm: Math.round(areas.flat * 100) / 100,
          true_area_sqm: Math.round(areas.true * 100) / 100,
          coordinates: f.coordinates,
        };
      });

      const result = createJobMeasurementSchema.safeParse({
        job_card_id: job.id,
        title: "Roof Measurement",
        facets: finalFacets,
        total_flat_area_sqm: Math.round(totalFlat * 100) / 100,
        total_true_area_sqm: Math.round(totalTrue * 100) / 100,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid measurement");

      let snapshotPath: string | null = null;
      try {
        const response = await fetch(buildSnapshotUrl());
        if (response.ok) {
          const blob = await response.blob();
          const file = new File([blob], "roof-measurement.jpg", { type: blob.type || "image/jpeg" });
          snapshotPath = await uploadJobPhoto({ tenantId: profile.tenant_id, jobCardId: job.id, uploadedBy: profile.id, file });
        }
      } catch (e) {
        console.error("[RoofAreaTool] Snapshot capture failed, saving measurement without one", e);
      }

      const { error: insertError } = await supabase.from("job_measurements").insert({
        tenant_id: profile.tenant_id,
        job_card_id: job.id,
        title: result.data.title,
        facets: result.data.facets,
        total_flat_area_sqm: result.data.total_flat_area_sqm,
        total_true_area_sqm: result.data.total_true_area_sqm,
        snapshot_path: snapshotPath,
        created_by: profile.id,
      });
      if (insertError) throw insertError;

      const summaryLines = [
        `Roof Measurement - ${new Date().toLocaleDateString("en-AU")}`,
        `Total: ${result.data.total_true_area_sqm.toFixed(1)} m² (true surface area)`,
        "",
        ...result.data.facets.map((f) => `${f.name}: ${f.pitch_degrees}° pitch, ${f.flat_area_sqm.toFixed(1)} m² flat -> ${f.true_area_sqm.toFixed(1)} m² true`),
      ];
      const { error: noteError } = await supabase.from("job_notes").insert({
        tenant_id: profile.tenant_id,
        job_card_id: job.id,
        author_id: profile.id,
        body: summaryLines.join("\n"),
      });
      if (noteError) throw noteError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-measurements", jobCardId] });
      queryClient.invalidateQueries({ queryKey: ["job-notes", jobCardId] });
      resetDraft();
      setSaveError(null);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save measurement")),
  });

  if (!drawing) {
    return (
      <div>
        <button onClick={() => setDrawing(true)} className="mb-4 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800">
          📐 Measure Roof
        </button>
        {!measurements || measurements.length === 0 ? (
          <p className="text-sm text-gray-500">Draw roof sections on a satellite map and save the total area to this job.</p>
        ) : (
          <div className="space-y-2">
            {measurements.map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded-lg border border-gray-200 p-3 text-sm">
                <div>
                  <p className="font-medium text-gray-900">{m.title}</p>
                  <p className="text-xs text-gray-500">{new Date(m.created_at).toLocaleDateString("en-AU")}</p>
                </div>
                <p className="text-right text-gray-700">
                  {m.total_true_area_sqm.toFixed(1)} m² true
                  <span className="block text-xs text-gray-400">{m.total_flat_area_sqm.toFixed(1)} m² flat</span>
                </p>
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
        <p className="text-sm text-gray-500">Draw one or more roof facets, set each one's pitch.</p>
        <div className="flex gap-6 text-right">
          <div>
            <p className="text-xs text-gray-500">Total flat area</p>
            <p className="text-lg font-bold text-gray-900">{totalFlat.toFixed(1)} m²</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Total true surface area</p>
            <p className="text-lg font-bold text-blue-700">{totalTrue.toFixed(1)} m²</p>
          </div>
        </div>
      </div>

      <div className="flex gap-4">
        <div className="h-[420px] flex-1 overflow-hidden rounded-lg border border-gray-300 bg-gray-100">
          {mapError ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-red-600">{mapError}</div>
          ) : locating || !region ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-500">Locating job address...</div>
          ) : (
            <div ref={mapDivRef} className="h-full w-full" />
          )}
        </div>

        <div className="flex h-[420px] w-80 flex-shrink-0 flex-col overflow-hidden rounded-lg border border-gray-300 bg-white">
          <div className="flex-1 overflow-y-auto p-3">
            {!activeFacetId && facets.length === 0 ? (
              <p className="mb-3 text-xs text-gray-500">Click "+ New Facet" below, then click the map to trace a roof section.</p>
            ) : activeFacetId ? (
              <p className="mb-3 text-xs text-gray-500">Click the map to add points. Add at least 3, then click "Finish facet".</p>
            ) : null}

            <div className="space-y-2">
              {facets.map((facet, index) => {
                const areas = facetAreas.get(facet.id) ?? { flat: 0, true: 0 };
                const isActive = facet.id === activeFacetId;
                return (
                  <div key={facet.id} className={`rounded-lg p-2 ${isActive ? "bg-blue-50" : "bg-gray-50"}`}>
                    <div className="mb-1 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: FACET_COLORS[index % FACET_COLORS.length] }} />
                        <button onClick={() => openRenameFacet(facet)} className="text-sm font-semibold text-gray-900 hover:underline">
                          {facet.name}
                        </button>
                        {isActive ? <span className="text-xs font-bold text-blue-700">Drawing...</span> : null}
                      </div>
                      <button onClick={() => handleDeleteFacet(facet.id)} className="text-xs font-semibold text-red-600">
                        Delete
                      </button>
                    </div>

                    <div className="mb-1 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Pitch</span>
                        <button onClick={() => handlePitchChange(facet.id, -5)} className="h-6 w-6 rounded-full bg-blue-700 text-sm font-bold text-white">
                          -
                        </button>
                        <span className="w-10 text-center text-sm font-bold">{facet.pitch_degrees}°</span>
                        <button onClick={() => handlePitchChange(facet.id, 5)} className="h-6 w-6 rounded-full bg-blue-700 text-sm font-bold text-white">
                          +
                        </button>
                      </div>
                      <span className="text-xs text-gray-700">
                        {areas.flat.toFixed(1)} m² &rarr; {areas.true.toFixed(1)} m²
                      </span>
                    </div>

                    {isActive ? (
                      <div className="flex justify-between text-xs">
                        <button onClick={handleUndoPoint} disabled={facet.coordinates.length === 0} className="font-semibold text-blue-700 disabled:text-gray-400">
                          Undo last point
                        </button>
                        <button onClick={handleFinishFacet} disabled={facet.coordinates.length < 3} className="font-semibold text-blue-700 disabled:text-gray-400">
                          Finish facet
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {!activeFacetId ? (
              <button onClick={handleNewFacet} className="mt-3 w-full rounded-md bg-blue-700 py-2 text-sm font-semibold text-white hover:bg-blue-800">
                + New Facet
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
                disabled={save.isPending || savableFacets.length === 0}
                className="flex-1 rounded-md bg-blue-700 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
              >
                {save.isPending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <Modal open={renamingFacetId !== null} onClose={() => setRenamingFacetId(null)} title="Rename facet">
        <FormField label="Name" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
        <div className="flex justify-end gap-3">
          <button onClick={() => setRenamingFacetId(null)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button onClick={handleSaveRename} className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800">
            Save
          </button>
        </div>
      </Modal>
    </div>
  );
}

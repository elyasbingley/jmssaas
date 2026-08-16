import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import * as Location from "expo-location";
import MapView, { Marker, Polygon, Polyline, type Region } from "react-native-maps";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { v4 as uuidv4 } from "uuid";
import {
  createJobMeasurementSchema,
  polygonFlatAreaSqm,
  trueAreaSqm,
  type Client,
  type ClientSite,
  type Coordinate,
  type Facet,
  type JobCard,
} from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { formatClientAddress } from "../../../../lib/format";
import { addJobPhoto } from "../../../../lib/powersync";
import { getErrorMessage } from "../../../../lib/errors";
import { CenteredModal } from "../../../../components/CenteredModal";
import { FormField } from "../../../../components/FormField";

// A locally-drawn facet, before it's been saved - flat_area_sqm/
// true_area_sqm aren't tracked here, they're derived live from
// coordinates/pitch_degrees on every render (see facetAreas below) so
// there's no risk of stale numbers; the persisted Facet shape (which does
// store the computed areas - see types.ts) only gets built once, at save
// time.
interface DraftFacet {
  id: string;
  name: string;
  pitch_degrees: number;
  coordinates: Coordinate[];
  finished: boolean;
}

// Cycled by facet index so overlapping/adjacent facets on the map are
// visually distinguishable - not persisted anywhere, purely a drawing aid.
const FACET_COLORS = ["#1d4ed8", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2"];

// Roof-scale zoom - a few dozen metres across, close enough to place
// individual vertices accurately. Sydney is just a reasonable Australian
// default for the last-resort fallback below, not anything address-
// specific - the person is expected to pan/zoom manually in that case.
const DEFAULT_REGION: Region = { latitude: -33.8688, longitude: 151.2093, latitudeDelta: 0.01, longitudeDelta: 0.01 };
const FACET_REGION_DELTA = 0.0025;

function toLatLng(coordinate: Coordinate) {
  return { latitude: coordinate.lat, longitude: coordinate.lng };
}

export default function MeasureRoofScreen() {
  const { jobCardId } = useLocalSearchParams<{ jobCardId: string }>();
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const mapRef = useRef<MapView>(null);

  const { data: jobRows } = useQuery<JobCard>("SELECT * FROM job_cards WHERE id = ?", [jobCardId ?? ""]);
  const job = jobRows[0];
  const { data: clientRows } = useQuery<Client>("SELECT * FROM clients WHERE id = ?", [job?.client_id ?? ""]);
  const client = clientRows[0];
  const { data: siteRows } = useQuery<ClientSite>("SELECT * FROM client_sites WHERE id = ?", [job?.site_id ?? ""]);
  const site = siteRows[0];

  // The job's own site (if one was picked) is the more specific address -
  // falls back to the client's address, then gives up and centers on the
  // device's current location, then a fixed default - see resolveRegion.
  const address = (job?.site_id ? formatClientAddress(site ?? { address_line1: null, address_line2: null, suburb: null, state: null, postcode: null }) : null) ?? (client ? formatClientAddress(client) : null);

  const [region, setRegion] = useState<Region | null>(null);
  const [locating, setLocating] = useState(true);

  useEffect(() => {
    // Waits for the job/client/site rows to actually load before resolving
    // an address to geocode - `address` is null both "not loaded yet" and
    // "genuinely has no address", so this only proceeds once `job` exists.
    if (!job) return;
    let cancelled = false;

    async function resolveRegion() {
      // Unlike iOS's CLGeocoder (a pure lookup, no permission needed),
      // Android's native Geocoder - what Location.geocodeAsync uses under
      // the hood - requires location permission on some OS versions/OEMs
      // even for forward geocoding, confirmed live ("Not authorized to use
      // location services" thrown from geocodeAsync itself on a real
      // device). Request permission up front, before attempting geocoding
      // at all, so both the geocoding attempt and the current-position
      // fallback below have it - a denied/unavailable permission just means
      // geocodeAsync fails the same way it would offline, falling through
      // to the same fallback chain either way.
      let permissionGranted = false;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        permissionGranted = status === "granted";
      } catch (e) {
        console.error("[MeasureRoof] Failed to request location permission", e);
      }

      if (address) {
        try {
          const results = await Location.geocodeAsync(address);
          const first = results[0];
          if (first && !cancelled) {
            setRegion({
              latitude: first.latitude,
              longitude: first.longitude,
              latitudeDelta: FACET_REGION_DELTA,
              longitudeDelta: FACET_REGION_DELTA,
            });
            setLocating(false);
            return;
          }
        } catch (e) {
          console.error("[MeasureRoof] Geocoding failed, falling back to current location", e);
        }
      }

      try {
        if (permissionGranted) {
          const position = await Location.getCurrentPositionAsync({});
          if (!cancelled) {
            setRegion({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              latitudeDelta: FACET_REGION_DELTA,
              longitudeDelta: FACET_REGION_DELTA,
            });
            setLocating(false);
            return;
          }
        }
      } catch (e) {
        console.error("[MeasureRoof] Current location failed, falling back to default region", e);
      }

      if (!cancelled) {
        setRegion(DEFAULT_REGION);
        setLocating(false);
      }
    }

    resolveRegion();
    return () => {
      cancelled = true;
    };
  }, [job, address]);

  const [facets, setFacets] = useState<DraftFacet[]>([]);
  const [activeFacetId, setActiveFacetId] = useState<string | null>(null);

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

  const handleMapPress = (event: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
    if (!activeFacetId) return;
    const { latitude, longitude } = event.nativeEvent.coordinate;
    setFacets((prev) =>
      prev.map((f) => (f.id === activeFacetId ? { ...f, coordinates: [...f.coordinates, { lat: latitude, lng: longitude }] } : f))
    );
  };

  const handleNewFacet = () => {
    const id = uuidv4();
    setFacets((prev) => [...prev, { id, name: `Facet ${prev.length + 1}`, pitch_degrees: 22.5, coordinates: [], finished: false }]);
    setActiveFacetId(id);
  };

  const handleUndoPoint = () => {
    if (!activeFacetId) return;
    setFacets((prev) =>
      prev.map((f) => (f.id === activeFacetId ? { ...f, coordinates: f.coordinates.slice(0, -1) } : f))
    );
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
    setFacets((prev) =>
      prev.map((f) => (f.id === facetId ? { ...f, pitch_degrees: Math.max(0, Math.min(60, f.pitch_degrees + delta)) } : f))
    );
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

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const savableFacets = facets.filter((f) => f.coordinates.length >= 3);

  const handleSave = async () => {
    if (!job || !profile || savableFacets.length === 0) return;

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
    if (!result.success) {
      setSaveError(result.error.issues[0]?.message ?? "Invalid measurement");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const now = new Date().toISOString();
      const measurementId = uuidv4();
      let snapshotPath: string | null = null;

      try {
        const snapshotBase64 = await mapRef.current?.takeSnapshot({ format: "jpg", quality: 0.8, result: "base64" });
        if (snapshotBase64) {
          await addJobPhoto({
            tenantId: profile.tenant_id,
            jobCardId: job.id,
            uploadedBy: profile.id,
            imageArrayBuffer: decodeBase64(snapshotBase64),
            mediaType: "image/jpeg",
            fileExtension: "jpg",
          });
          snapshotPath = `${profile.tenant_id}/${job.id}`;
        }
      } catch (e) {
        // A failed snapshot shouldn't block saving the measurement itself -
        // the numbers are what actually matter; the map image is a bonus.
        console.error("[MeasureRoof] Snapshot capture failed, saving measurement without one", e);
      }

      await powersync.execute(
        `INSERT INTO job_measurements
           (id, tenant_id, job_card_id, title, facets, total_flat_area_sqm, total_true_area_sqm, snapshot_path, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          measurementId,
          profile.tenant_id,
          job.id,
          result.data.title,
          JSON.stringify(result.data.facets),
          result.data.total_flat_area_sqm,
          result.data.total_true_area_sqm,
          snapshotPath,
          profile.id,
          now,
          now,
        ]
      );

      const summaryLines = [
        `Roof Measurement - ${new Date().toLocaleDateString("en-AU")}`,
        `Total: ${result.data.total_true_area_sqm.toFixed(1)} m² (true surface area)`,
        "",
        ...result.data.facets.map(
          (f) =>
            `${f.name}: ${f.pitch_degrees}° pitch, ${f.flat_area_sqm.toFixed(1)} m² flat -> ${f.true_area_sqm.toFixed(1)} m² true`
        ),
      ];
      await powersync.execute(
        "INSERT INTO job_notes (id, tenant_id, job_card_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [uuidv4(), profile.tenant_id, job.id, profile.id, summaryLines.join("\n"), now]
      );

      router.back();
    } catch (e) {
      console.error("[MeasureRoof] Failed to save measurement", e);
      setSaveError(getErrorMessage(e, "Failed to save measurement (see console for details)"));
    } finally {
      setSaving(false);
    }
  };

  if (!job) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.totalsHeader}>
        <View>
          <Text style={styles.totalsLabel}>Total flat area</Text>
          <Text style={styles.totalsValue}>{totalFlat.toFixed(1)} m²</Text>
        </View>
        <View>
          <Text style={styles.totalsLabel}>Total true surface area</Text>
          <Text style={[styles.totalsValue, styles.totalsValueBold]}>{totalTrue.toFixed(1)} m²</Text>
        </View>
      </View>

      {locating || !region ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.empty}>Locating job address...</Text>
        </View>
      ) : (
        <MapView ref={mapRef} style={styles.map} mapType="satellite" initialRegion={region} onPress={handleMapPress}>
          {facets.map((facet, index) => {
            const color = FACET_COLORS[index % FACET_COLORS.length]!;
            const points = facet.coordinates.map(toLatLng);
            return (
              <View key={facet.id}>
                {points.length >= 3 ? (
                  <Polygon coordinates={points} strokeColor={color} fillColor={`${color}55`} strokeWidth={2} />
                ) : points.length === 2 ? (
                  <Polyline coordinates={points} strokeColor={color} strokeWidth={2} />
                ) : null}
                {points.map((point, pointIndex) => (
                  <Marker key={pointIndex} coordinate={point} pinColor={color} />
                ))}
              </View>
            );
          })}
        </MapView>
      )}

      {!activeFacetId && facets.length === 0 ? (
        <Text style={styles.hint}>Tap "+ New Facet" below, then tap the map to trace a roof section.</Text>
      ) : activeFacetId ? (
        <Text style={styles.hint}>Tap the map to add points. Add at least 3, then tap "Finish Facet".</Text>
      ) : null}

      <ScrollView style={styles.drawer} contentContainerStyle={styles.drawerContent}>
        {facets.map((facet, index) => {
          const areas = facetAreas.get(facet.id) ?? { flat: 0, true: 0 };
          const isActive = facet.id === activeFacetId;
          return (
            <View key={facet.id} style={[styles.facetRow, isActive && styles.facetRowActive]}>
              <View style={styles.facetRowTop}>
                <View style={styles.facetNameRow}>
                  <View style={[styles.swatch, { backgroundColor: FACET_COLORS[index % FACET_COLORS.length] }]} />
                  <Pressable onPress={() => openRenameFacet(facet)}>
                    <Text style={styles.facetName}>{facet.name}</Text>
                  </Pressable>
                  {isActive ? <Text style={styles.drawingBadge}>Drawing...</Text> : null}
                </View>
                <Pressable onPress={() => handleDeleteFacet(facet.id)}>
                  <Text style={styles.deleteLink}>Delete</Text>
                </Pressable>
              </View>

              <View style={styles.facetRowBottom}>
                <View style={styles.pitchControl}>
                  <Text style={styles.pitchLabel}>Pitch</Text>
                  <Pressable style={styles.stepperButton} onPress={() => handlePitchChange(facet.id, -5)}>
                    <Text style={styles.stepperButtonText}>-</Text>
                  </Pressable>
                  <Text style={styles.pitchValue}>{facet.pitch_degrees}°</Text>
                  <Pressable style={styles.stepperButton} onPress={() => handlePitchChange(facet.id, 5)}>
                    <Text style={styles.stepperButtonText}>+</Text>
                  </Pressable>
                </View>
                <Text style={styles.facetAreas}>
                  {areas.flat.toFixed(1)} m² flat -&gt; {areas.true.toFixed(1)} m² true
                </Text>
              </View>

              {isActive ? (
                <View style={styles.activeFacetActions}>
                  <Pressable onPress={handleUndoPoint} disabled={facet.coordinates.length === 0}>
                    <Text style={styles.link}>Undo last point</Text>
                  </Pressable>
                  <Pressable onPress={handleFinishFacet} disabled={facet.coordinates.length < 3}>
                    <Text style={[styles.link, facet.coordinates.length < 3 && styles.linkDisabled]}>Finish facet</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          );
        })}

        {!activeFacetId ? (
          <Pressable style={styles.newFacetButton} onPress={handleNewFacet}>
            <Text style={styles.newFacetButtonText}>+ New Facet</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
      <Pressable
        style={[styles.saveButton, savableFacets.length === 0 && styles.saveButtonDisabled]}
        onPress={handleSave}
        disabled={saving || savableFacets.length === 0}
      >
        <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save & Append to Job Card"}</Text>
      </Pressable>

      <CenteredModal visible={renamingFacetId !== null} onClose={() => setRenamingFacetId(null)}>
        <Text style={styles.modalTitle}>Rename facet</Text>
        <FormField label="Name" placeholder="e.g. Main House Roof" value={renameValue} onChangeText={setRenameValue} />
        <View style={styles.modalActions}>
          <Pressable onPress={() => setRenamingFacetId(null)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleSaveRename}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  empty: { color: "#6b7280" },
  totalsHeader: {
    flexDirection: "row",
    justifyContent: "space-around",
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
  },
  totalsLabel: { fontSize: 12, color: "#6b7280", textAlign: "center" },
  totalsValue: { fontSize: 18, fontWeight: "700", color: "#111827", textAlign: "center" },
  totalsValueBold: { color: "#1d4ed8" },
  map: { flex: 1 },
  hint: { textAlign: "center", color: "#6b7280", fontSize: 12, paddingVertical: 6, paddingHorizontal: 12 },
  drawer: { maxHeight: 240, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#d1d5db" },
  drawerContent: { padding: 12, gap: 8 },
  facetRow: { backgroundColor: "#f9fafb", borderRadius: 10, padding: 10, gap: 6 },
  facetRowActive: { backgroundColor: "#eef2ff" },
  facetRowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  facetNameRow: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  swatch: { width: 12, height: 12, borderRadius: 6 },
  facetName: { fontSize: 15, fontWeight: "600", color: "#111827" },
  drawingBadge: { fontSize: 11, fontWeight: "700", color: "#1d4ed8" },
  deleteLink: { color: "#dc2626", fontWeight: "600" },
  facetRowBottom: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  pitchControl: { flexDirection: "row", alignItems: "center", gap: 8 },
  pitchLabel: { fontSize: 12, color: "#6b7280" },
  stepperButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#1d4ed8",
    alignItems: "center",
    justifyContent: "center",
  },
  stepperButtonText: { color: "#fff", fontWeight: "800", fontSize: 15, lineHeight: 17 },
  pitchValue: { fontSize: 14, fontWeight: "700", color: "#111827", minWidth: 32, textAlign: "center" },
  facetAreas: { fontSize: 12, color: "#374151" },
  activeFacetActions: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  newFacetButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 12, alignItems: "center" },
  newFacetButtonText: { color: "#fff", fontWeight: "700" },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, padding: 14, alignItems: "center", margin: 12 },
  saveButtonDisabled: { backgroundColor: "#93c5fd" },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  error: { color: "#dc2626", textAlign: "center", marginTop: 6 },
  link: { color: "#1d4ed8", fontWeight: "600" },
  linkDisabled: { color: "#9ca3af" },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 16 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
});

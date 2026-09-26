import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { usePowerSync, useQuery } from "@powersync/react";
import * as Location from "expo-location";
import MapView, { Marker, Polyline, type Region } from "react-native-maps";
import { v4 as uuidv4 } from "uuid";
import {
  createJobLinearMeasurementSchema,
  polylineLengthMeters,
  type Client,
  type ClientSite,
  type Coordinate,
  type JobCard,
  type JobLinearMeasurement,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { formatClientAddress } from "../lib/format";
import { getErrorMessage } from "../lib/errors";
import { useTheme } from "../lib/theme-context";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { ThemedFormField } from "./theme/ThemedFormField";

// Linear Distance Measurer (mobile) - same drawing/save logic as
// desktop's LinearMeasurer.tsx (named straight-line runs - gutters,
// downpipes, flashing, fencing - summed via the shared
// polylineLengthMeters(), same equirectangular-projection approach used
// on desktop so totals match exactly for identical coordinates).
// job_linear_measurements is a plain-Supabase table (not PowerSync-
// synced), same "occasional site tool, requires connectivity" treatment
// as MaterialTallyCounter. The map's initial region is resolved the same
// way MeasureRoofTool's is (geocode the job/site address, then device
// GPS, then a hardcoded fallback) - see that component for the reference
// implementation this one mirrors.

interface DraftSegment {
  id: string;
  label: string;
  coordinates: Coordinate[];
}

// These are the colours drawn ON the satellite map to distinguish each
// measured run - overlay "ink", not app chrome - so they're deliberately
// left as fixed, saturated colours rather than theme tokens (see
// PhotoMarkupEditor's COLORS for the same reasoning).
const SEGMENT_COLORS = ["#1d4ed8", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2"];
const DEFAULT_REGION: Region = { latitude: -33.8688, longitude: 151.2093, latitudeDelta: 0.003, longitudeDelta: 0.003 };
const RESOLVED_REGION_DELTA = 0.003;

function toLatLng(coordinate: Coordinate) {
  return { latitude: coordinate.lat, longitude: coordinate.lng };
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

export function LinearMeasurerTool({ jobCardId }: { jobCardId: string }) {
  const styles = useThemedStyles(createStyles);
  const { tokens } = useTheme();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const [measurements, setMeasurements] = useState<JobLinearMeasurement[]>([]);

  useMemo(() => {
    fetchMeasurements(jobCardId)
      .then(setMeasurements)
      .catch((e) => console.error("[LinearMeasurer] Failed to load measurements", e));
  }, [jobCardId]);

  const { data: jobRows } = useQuery<JobCard>("SELECT * FROM job_cards WHERE id = ?", [jobCardId]);
  const job = jobRows[0];
  const { data: clientRows } = useQuery<Client>("SELECT * FROM clients WHERE id = ?", [job?.client_id ?? ""]);
  const client = clientRows[0];
  const { data: siteRows } = useQuery<ClientSite>("SELECT * FROM client_sites WHERE id = ?", [job?.site_id ?? ""]);
  const site = siteRows[0];
  const address =
    (job?.site_id ? formatClientAddress(site ?? { address_line1: null, address_line2: null, suburb: null, state: null, postcode: null }) : null) ??
    (client ? formatClientAddress(client) : null);

  const [drawing, setDrawing] = useState(false);
  const [region, setRegion] = useState<Region | null>(null);
  const [locating, setLocating] = useState(true);
  const [title, setTitle] = useState("");
  const [segments, setSegments] = useState<DraftSegment[]>([]);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);

  useEffect(() => {
    if (!drawing || !job) return;
    let cancelled = false;

    async function resolveRegion() {
      let permissionGranted = false;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        permissionGranted = status === "granted";
      } catch (e) {
        console.error("[LinearMeasurer] Failed to request location permission", e);
      }

      if (address) {
        try {
          const results = await Location.geocodeAsync(address);
          const first = results[0];
          if (first && !cancelled) {
            setRegion({
              latitude: first.latitude,
              longitude: first.longitude,
              latitudeDelta: RESOLVED_REGION_DELTA,
              longitudeDelta: RESOLVED_REGION_DELTA,
            });
            setLocating(false);
            return;
          }
        } catch (e) {
          console.error("[LinearMeasurer] Geocoding failed, falling back to current location", e);
        }
      }

      try {
        if (permissionGranted) {
          const position = await Location.getCurrentPositionAsync({});
          if (!cancelled) {
            setRegion({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              latitudeDelta: RESOLVED_REGION_DELTA,
              longitudeDelta: RESOLVED_REGION_DELTA,
            });
            setLocating(false);
            return;
          }
        }
      } catch (e) {
        console.error("[LinearMeasurer] Current location failed, falling back to default region", e);
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
  }, [drawing, job, address]);

  const handleMapPress = (event: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
    if (!activeSegmentId) return;
    const { latitude, longitude } = event.nativeEvent.coordinate;
    setSegments((prev) =>
      prev.map((s) => (s.id === activeSegmentId ? { ...s, coordinates: [...s.coordinates, { lat: latitude, lng: longitude }] } : s))
    );
  };

  const segmentLengths = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of segments) map.set(s.id, polylineLengthMeters(s.coordinates));
    return map;
  }, [segments]);
  const totalLength = segments.reduce((sum, s) => sum + (segmentLengths.get(s.id) ?? 0), 0);

  const resetDraft = () => {
    setDrawing(false);
    setRegion(null);
    setLocating(true);
    setTitle("");
    setSegments([]);
    setActiveSegmentId(null);
  };

  const handleNewSegment = () => {
    const id = uuidv4();
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
  const handleRenameSegment = (segmentId: string, label: string) => {
    setSegments((prev) => prev.map((s) => (s.id === segmentId ? { ...s, label } : s)));
  };

  const savableSegments = segments.filter((s) => s.coordinates.length >= 2);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!profile || savableSegments.length === 0) return;

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
    if (!result.success) {
      setSaveError(result.error.issues[0]?.message ?? "Invalid measurement");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const { error } = await supabase.from("job_linear_measurements").insert({
        tenant_id: profile.tenant_id,
        job_card_id: jobCardId,
        title: result.data.title,
        segments: result.data.segments,
        total_length_meters: result.data.total_length_meters,
        created_by: profile.id,
      });
      if (error) throw error;
      const updated = await fetchMeasurements(jobCardId);
      setMeasurements(updated);
      resetDraft();
    } catch (e) {
      setSaveError(getErrorMessage(e, "Failed to save measurement"));
    } finally {
      setSaving(false);
    }
  };

  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyToNotes = async (measurement: JobLinearMeasurement) => {
    if (!profile) return;
    setCopyingId(measurement.id);
    try {
      const lines = [
        `Linear Measurement - ${measurement.title}`,
        `Total: ${measurement.total_length_meters.toFixed(1)} m`,
        "",
        ...measurement.segments.map((s) => `${s.label}: ${s.length_meters.toFixed(1)} m`),
      ];
      await powersync.execute(
        "INSERT INTO job_notes (id, tenant_id, job_card_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [uuidv4(), profile.tenant_id, jobCardId, profile.id, lines.join("\n"), new Date().toISOString()]
      );
      setCopiedId(measurement.id);
      setTimeout(() => setCopiedId(null), 3000);
    } catch (e) {
      console.error("[LinearMeasurer] Failed to copy summary to notes", e);
    } finally {
      setCopyingId(null);
    }
  };

  if (!drawing) {
    return (
      <View>
        <Pressable style={styles.newSetButton} onPress={() => setDrawing(true)}>
          <Text style={styles.newSetButtonText}>+ New Measurement Set</Text>
        </Pressable>
        {measurements.length === 0 ? (
          <Text style={styles.subtitle}>No linear measurements saved yet.</Text>
        ) : (
          <View style={{ gap: 8 }}>
            {measurements.map((m) => (
              <View key={m.id} style={styles.measurementCard}>
                <View style={styles.measurementCardTop}>
                  <Text style={styles.measurementTitle}>{m.title}</Text>
                  <Text style={styles.measurementTotal}>{m.total_length_meters.toFixed(1)} m</Text>
                </View>
                <Text style={styles.measurementSegments}>
                  {m.segments.map((s) => `${s.label}: ${s.length_meters.toFixed(1)}m`).join(" · ")}
                </Text>
                <Pressable onPress={() => copyToNotes(m)} disabled={copyingId === m.id}>
                  <Text style={styles.link}>{copiedId === m.id ? "Copied to Job Notes" : "Copy Summary to Job Notes"}</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </View>
    );
  }

  return (
    <View>
      <View style={styles.titleRow}>
        <View style={{ flex: 1 }}>
          <ThemedFormField label="Measurement set name" placeholder='e.g. "Gutter Lengths"' value={title} onChangeText={setTitle} />
        </View>
        <View style={styles.totalBox}>
          <Text style={styles.totalsLabel}>Total length</Text>
          <Text style={styles.totalsValue}>{totalLength.toFixed(1)} m</Text>
        </View>
      </View>

      {locating || !region ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.accent} />
          <Text style={styles.empty}>Locating job address...</Text>
        </View>
      ) : (
        <MapView style={styles.map} mapType="satellite" initialRegion={region} onPress={handleMapPress}>
          {segments.map((segment, index) => {
            const color = SEGMENT_COLORS[index % SEGMENT_COLORS.length]!;
            const points = segment.coordinates.map(toLatLng);
            return (
              <View key={segment.id}>
                {points.length >= 2 ? <Polyline coordinates={points} strokeColor={color} strokeWidth={3} /> : null}
                {points.map((point, pointIndex) => (
                  <Marker key={pointIndex} coordinate={point} pinColor={color} />
                ))}
              </View>
            );
          })}
        </MapView>
      )}

      {!activeSegmentId && segments.length === 0 ? (
        <Text style={styles.hint}>Tap "+ New Run" below, then tap the map to trace a straight run.</Text>
      ) : activeSegmentId ? (
        <Text style={styles.hint}>Tap the map to add points along this run, then "Finish run".</Text>
      ) : null}

      <ScrollView style={styles.drawer} contentContainerStyle={styles.drawerContent}>
        {segments.map((segment, index) => {
          const isActive = segment.id === activeSegmentId;
          return (
            <View key={segment.id} style={[styles.segmentRow, isActive && styles.segmentRowActive]}>
              <View style={styles.segmentRowTop}>
                <View style={styles.segmentNameRow}>
                  <View style={[styles.swatch, { backgroundColor: SEGMENT_COLORS[index % SEGMENT_COLORS.length] }]} />
                  <TextInput
                    value={segment.label}
                    onChangeText={(v) => handleRenameSegment(segment.id, v)}
                    style={styles.labelInput}
                    placeholderTextColor={styles.placeholder.color}
                  />
                  {isActive ? <Text style={styles.drawingBadge}>Drawing...</Text> : null}
                </View>
                <Pressable onPress={() => handleDeleteSegment(segment.id)}>
                  <Text style={styles.deleteLink}>Delete</Text>
                </Pressable>
              </View>
              <Text style={styles.segmentLength}>{(segmentLengths.get(segment.id) ?? 0).toFixed(1)} m</Text>
              {isActive ? (
                <View style={styles.activeSegmentActions}>
                  <Pressable onPress={handleUndoPoint} disabled={segment.coordinates.length === 0}>
                    <Text style={styles.link}>Undo last point</Text>
                  </Pressable>
                  <Pressable onPress={handleFinishSegment} disabled={segment.coordinates.length < 2}>
                    <Text style={[styles.link, segment.coordinates.length < 2 && styles.linkDisabled]}>Finish run</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          );
        })}
        {!activeSegmentId ? (
          <Pressable style={styles.newRunButton} onPress={handleNewSegment}>
            <Text style={styles.newRunButtonText}>+ New Run</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
      <View style={styles.actionsRow}>
        <Pressable style={styles.cancelButton} onPress={resetDraft}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.saveButton, savableSegments.length === 0 && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={saving || savableSegments.length === 0}
        >
          <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function createStyles({ tokens, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return StyleSheet.create({
    subtitle: { color: tokens.textMuted, fontSize: 13, marginTop: 4, ...mono },
    newSetButton: { backgroundColor: tokens.accent, borderRadius: 8, paddingVertical: 12, alignItems: "center", marginBottom: 10, boxShadow: `0 0 12px ${tokens.accentGlow}` },
    newSetButtonText: { color: tokens.background, fontWeight: "700", ...mono },
    measurementCard: { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border, borderRadius: 10, padding: 10, gap: 4 },
    measurementCardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    measurementTitle: { fontSize: 14, fontWeight: "600", color: tokens.textPrimary, ...mono },
    measurementTotal: { fontSize: 14, fontWeight: "700", color: tokens.accent, ...mono },
    measurementSegments: { fontSize: 12, color: tokens.textMuted, ...mono },
    titleRow: { flexDirection: "row", alignItems: "flex-end", gap: 12, marginBottom: 8 },
    totalBox: { alignItems: "flex-end", paddingBottom: 8 },
    totalsLabel: { fontSize: 11, color: tokens.textMuted, ...mono },
    totalsValue: { fontSize: 18, fontWeight: "700", color: tokens.accent, ...mono },
    map: { height: 300, borderRadius: 8 },
    center: { alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 24 },
    empty: { color: tokens.textMuted, ...mono },
    hint: { textAlign: "center", color: tokens.textMuted, fontSize: 12, paddingVertical: 6, paddingHorizontal: 12, ...mono },
    drawer: { maxHeight: 220 },
    drawerContent: { paddingVertical: 8, gap: 8 },
    segmentRow: { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border, borderRadius: 10, padding: 10, gap: 6 },
    segmentRowActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    segmentRowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    segmentNameRow: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
    swatch: { width: 12, height: 12, borderRadius: 6 },
    labelInput: { flex: 1, fontSize: 14, fontWeight: "600", color: tokens.textPrimary, paddingVertical: 2, ...mono },
    placeholder: { color: tokens.textMuted },
    drawingBadge: { fontSize: 11, fontWeight: "700", color: tokens.accent, ...mono },
    deleteLink: { color: tokens.danger, fontWeight: "600", ...mono },
    segmentLength: { fontSize: 12, color: tokens.textPrimary, ...mono },
    activeSegmentActions: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
    newRunButton: { backgroundColor: tokens.accent, borderRadius: 8, padding: 12, alignItems: "center" },
    newRunButtonText: { color: tokens.background, fontWeight: "700", ...mono },
    actionsRow: { flexDirection: "row", gap: 10, marginTop: 10 },
    cancelButton: { flex: 1, borderWidth: 1, borderColor: tokens.border, borderRadius: 8, paddingVertical: 12, alignItems: "center" },
    cancelButtonText: { color: tokens.textPrimary, fontWeight: "700", ...mono },
    saveButton: { flex: 1, backgroundColor: tokens.accent, borderRadius: 8, paddingVertical: 12, alignItems: "center" },
    saveButtonDisabled: { backgroundColor: tokens.accentGlow },
    saveButtonText: { color: tokens.background, fontWeight: "700", ...mono },
    error: { color: tokens.danger, textAlign: "center", marginTop: 6, ...mono },
    link: { color: tokens.accent, fontWeight: "600", ...mono },
    linkDisabled: { color: tokens.textMuted },
  });
}

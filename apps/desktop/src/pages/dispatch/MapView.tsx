import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobLifecycleStage, Profile } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { fetchAllRows } from "../../lib/fetch-all-rows";
import { loadGoogleMaps } from "../../lib/google-maps";
import { initials, jobAddress, type DispatchEvent, type DispatchJob, type PropertyRow, type Site } from "./data";
import { clockLabel, dayKeyOf, minutesOfDay } from "./drag";
import { filterJobs } from "./JobsPanel";

// The dispatch map: a pin for each job booked on the chosen day (with the
// tech's initials) and, optionally, every job still waiting to be booked.
// Addresses are looked up with Google once and kept in geocode_cache.

type Places = { sites: Map<string, Site>; properties: Map<string, PropertyRow> } | undefined;
type Coords = { lat: number; lng: number };
const MAX_LOOKUPS_PER_VISIT = 250;
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;

export const addressKey = (a: string) => a.toLowerCase().replace(/[\s,]+/g, " ").trim();

// Coordinates for each address: the saved ones, then Google for the rest
// (one at a time, gently, saving each as it comes back).
function useGeocodes(addresses: string[], google: typeof window.google | null) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const cache = useQuery({
    queryKey: ["dispatch", "geocodes"],
    queryFn: async () => {
      const rows = await fetchAllRows<{ address_key: string; lat: number | null; lng: number | null; status: string }>("geocode_cache", "address_key, lat, lng, status");
      return new Map(rows.map((r) => [r.address_key, r.status === "ok" && r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null]));
    },
    staleTime: Infinity,
  });
  const [found, setFound] = useState<Map<string, Coords | null>>(new Map());
  const [pending, setPending] = useState(0);
  // One worker works through a queue, so the pin list changing (a refresh,
  // a filter) adds to the queue rather than restarting the lookups.
  const queue = useRef<{ key: string; address: string }[]>([]);
  const seen = useRef(new Set<string>()); // queued or done this visit
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const wanted = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of addresses) m.set(addressKey(a), a);
    return m;
  }, [addresses]);

  useEffect(() => {
    if (!google || !cache.data || !profile) return;
    for (const [key, address] of wanted) {
      if (cache.data.has(key) || seen.current.has(key) || seen.current.size >= MAX_LOOKUPS_PER_VISIT) continue;
      seen.current.add(key);
      queue.current.push({ key, address });
    }
    setPending(queue.current.length);
    if (running.current || queue.current.length === 0) return;
    running.current = true;
    const geocoder = new google.maps.Geocoder();
    void (async () => {
      while (queue.current.length && alive.current) {
        const { key, address } = queue.current.shift()!;
        let result: Coords | null = null;
        let save = true;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await geocoder.geocode({ address, region: "au" });
            const loc = res.results[0]?.geometry.location;
            result = loc ? { lat: loc.lat(), lng: loc.lng() } : null;
            break;
          } catch (e) {
            const code = (e as { code?: string }).code ?? String(e);
            if (/ZERO_RESULTS/.test(code)) break;
            if (/OVER_QUERY_LIMIT/.test(code) && attempt === 0) {
              await new Promise((r) => setTimeout(r, 2000));
              continue;
            }
            save = false; // a key or network problem: don't remember it as "not found"
            break;
          }
        }
        if (!alive.current) break;
        setFound((prev) => new Map(prev).set(key, result));
        setPending(queue.current.length);
        if (save) {
          await supabase.from("geocode_cache").upsert(
            { tenant_id: profile.tenant_id, address_key: key, lat: result?.lat ?? null, lng: result?.lng ?? null, formatted_address: address, status: result ? "ok" : "not_found" },
            { onConflict: "tenant_id,address_key", ignoreDuplicates: true }
          );
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      running.current = false;
      if (alive.current) void queryClient.invalidateQueries({ queryKey: ["dispatch", "geocodes"] });
    })();
  }, [google, cache.data, wanted, profile, queryClient]);

  const lookup = (address: string): Coords | null | undefined => {
    const k = addressKey(address);
    if (found.has(k)) return found.get(k);
    return cache.data?.get(k);
  };
  return { lookup, pending, ready: !!cache.data };
}

interface Pin {
  key: string;
  job: DispatchJob;
  event?: DispatchEvent;
  address: string;
  kind: "booked" | "unbooked";
  label: string;
}

export function MapView({
  day,
  jobs,
  events,
  people,
  stagesById,
  places,
  highlight,
}: {
  day: string;
  jobs: DispatchJob[];
  events: DispatchEvent[];
  people: Profile[];
  stagesById: Map<string, JobLifecycleStage>;
  places: Places;
  highlight: string | null;
}) {
  const navigate = useNavigate();
  const mapDiv = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markers = useRef(new Map<string, google.maps.Marker>());
  const info = useRef<google.maps.InfoWindow | null>(null);
  const fittedFor = useRef("");
  const [google, setGoogle] = useState<typeof window.google | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showBooked, setShowBooked] = useState(true);
  const [showUnbooked, setShowUnbooked] = useState(true);
  const [tech, setTech] = useState("all");

  const jobsById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const nameOf = useMemo(() => new Map(people.map((p) => [p.id, p.full_name || p.email || "Someone"])), [people]);

  const pins = useMemo(() => {
    const out: Pin[] = [];
    // Wait for sites and properties: until then a job's address would be
    // its client's, and the wrong place would be looked up.
    if (!places) return out;
    if (showBooked) {
      for (const e of events) {
        if (!e.job_card_id || dayKeyOf(new Date(e.start_at)) !== day) continue;
        const job = jobsById.get(e.job_card_id);
        if (!job) continue;
        if (tech !== "all" && (job.assigned_technician_id ?? "none") !== tech) continue;
        const address = jobAddress(job, places);
        if (address) out.push({ key: `e-${e.id}`, job, event: e, address, kind: "booked", label: job.assigned_technician_id ? initials(nameOf.get(job.assigned_technician_id)) : "?" });
      }
    }
    if (showUnbooked) {
      for (const job of filterJobs("unbooked", jobs, events, stagesById)) {
        if (tech !== "all" && (job.assigned_technician_id ?? "none") !== tech) continue;
        const address = jobAddress(job, places);
        if (address) out.push({ key: `j-${job.id}`, job, address, kind: "unbooked", label: "" });
      }
    }
    return out;
  }, [showBooked, showUnbooked, events, jobs, day, jobsById, places, tech, nameOf, stagesById]);

  const addresses = useMemo(() => pins.map((p) => p.address), [pins]);
  const { lookup, pending, ready } = useGeocodes(addresses, google);

  useEffect(() => {
    let alive = true;
    loadGoogleMaps()
      .then((g) => alive && setGoogle(g))
      .catch((e: Error) => alive && setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!google || !mapDiv.current || mapRef.current) return;
    mapRef.current = new google.maps.Map(mapDiv.current, {
      center: { lat: -33.8688, lng: 151.2093 },
      zoom: 10,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      clickableIcons: false,
    });
    info.current = new google.maps.InfoWindow();
  }, [google]);

  // Draw the pins.
  const located = pins.map((p) => ({ pin: p, at: lookup(p.address) })).filter((x): x is { pin: Pin; at: Coords } => !!x.at);
  const missing = ready ? pins.filter((p) => lookup(p.address) === null).length : 0;
  const locatedKey = located.map((l) => `${l.pin.key}@${l.at.lat},${l.at.lng}:${l.pin.label}`).join("|");
  useEffect(() => {
    const map = mapRef.current;
    if (!google || !map || !mapDiv.current) return;
    const css = getComputedStyle(mapDiv.current);
    const accent = css.getPropertyValue("--jms-accent").trim() || "#2563eb";
    const warning = css.getPropertyValue("--jms-warning").trim() || "#d97706";
    const keep = new Set<string>();
    // Pins at the same address are nudged apart so each can be clicked.
    const seen = new Map<string, number>();
    for (const { pin, at } of located) {
      keep.add(pin.key);
      const n = seen.get(`${at.lat},${at.lng}`) ?? 0;
      seen.set(`${at.lat},${at.lng}`, n + 1);
      const position = n ? { lat: at.lat + 0.00012 * Math.sin(n * 2.1), lng: at.lng + 0.00012 * Math.cos(n * 2.1) } : at;
      const booked = pin.kind === "booked";
      const icon: google.maps.Symbol = {
        path: google.maps.SymbolPath.CIRCLE,
        scale: booked ? 13 : 8,
        fillColor: booked ? accent : warning,
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 2,
      };
      const label = booked ? { text: pin.label || "?", color: "#ffffff", fontSize: "11px", fontWeight: "700" } : undefined;
      let m = markers.current.get(pin.key);
      if (!m) {
        m = new google.maps.Marker({ map, position, icon, label, title: `${pin.job.number ?? ""} ${pin.job.clients?.name ?? ""}` });
        m.addListener("click", () => openInfo(pin.key));
        markers.current.set(pin.key, m);
      } else {
        m.setPosition(position);
        m.setIcon(icon);
        m.setLabel(label ?? null);
      }
      m.setZIndex(booked ? 2 : 1);
    }
    for (const [k, m] of markers.current) {
      if (!keep.has(k)) {
        m.setMap(null);
        markers.current.delete(k);
      }
    }
    // Fit the map to the pins when the set of pins changes (not on every refresh).
    const setKey = located.map((l) => l.pin.key).sort().join(",");
    if (setKey && setKey !== fittedFor.current && !pending) {
      fittedFor.current = setKey;
      const bounds = new google.maps.LatLngBounds();
      for (const { at } of located) bounds.extend(at);
      if (located.length === 1) {
        map.setCenter(located[0]!.at);
        map.setZoom(14);
      } else map.fitBounds(bounds, 48);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [google, locatedKey, pending]);

  // Hovering a job in the Jobs panel lifts its pin.
  useEffect(() => {
    if (!google) return;
    for (const [k, m] of markers.current) {
      const pin = pins.find((p) => p.key === k);
      if (!pin) continue;
      const on = highlight === pin.job.id;
      m.setAnimation(on ? google.maps.Animation.BOUNCE : null);
      m.setZIndex(on ? 10 : pin.kind === "booked" ? 2 : 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight, google, locatedKey]);

  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  function openInfo(key: string) {
    const pin = pinsRef.current.find((p) => p.key === key);
    const m = markers.current.get(key);
    if (!pin || !m || !info.current || !mapRef.current) return;
    const el = document.createElement("div");
    el.style.cssText = "font: 13px/1.35 system-ui, sans-serif; color: #111; max-width: 240px";
    const add = (text: string, style = "") => {
      const p = document.createElement("div");
      p.textContent = text;
      p.style.cssText = style;
      el.appendChild(p);
    };
    add(`${pin.job.number ?? "Job"} · ${pin.job.clients?.name ?? ""}`, "font-weight: 700");
    add(pin.job.title);
    add(pin.address, "color: #555");
    if (pin.event) {
      const start = minutesOfDay(pin.event.start_at);
      add(`${clockLabel(start)} · ${pin.job.assigned_technician_id ? nameOf.get(pin.job.assigned_technician_id) ?? "" : "Unassigned"}`, "margin-top: 4px; font-weight: 600");
    } else add("Not booked yet", "margin-top: 4px; color: #b45309; font-weight: 600");
    const btn = document.createElement("button");
    btn.textContent = "Open job →";
    btn.style.cssText = "margin-top: 6px; color: #2563eb; font-weight: 600; background: none; border: 0; padding: 0; cursor: pointer";
    btn.onclick = () => navigate(`/jobs/${pin.job.id}`);
    el.appendChild(btn);
    info.current.setContent(el);
    info.current.open({ map: mapRef.current, anchor: m });
  }

  useEffect(
    () => () => {
      for (const m of markers.current.values()) m.setMap(null);
      markers.current.clear();
    },
    []
  );

  const bookedCount = pins.filter((p) => p.kind === "booked").length;
  const unbookedCount = pins.filter((p) => p.kind === "unbooked").length;

  return (
    <div className="relative h-full" data-testid="dispatch-map">
      <div ref={mapDiv} className="absolute inset-0" style={{ backgroundColor: "var(--jms-bg)" }} />
      {loadError ? (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <p className="max-w-md text-center" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            The map needs a Google Maps key. {loadError}
          </p>
        </div>
      ) : null}
      <div
        className="absolute left-3 top-3 z-10 space-y-1.5 rounded-md p-3"
        style={{ backgroundColor: "var(--jms-surface)", border: "1px solid var(--jms-border)", boxShadow: "0 4px 14px rgba(0,0,0,0.2)" }}
      >
        <label className="flex items-center gap-2" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}>
          <input type="checkbox" checked={showBooked} onChange={(e) => setShowBooked(e.target.checked)} />
          <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: "var(--jms-accent)" }} />
          Booked this day <strong>{bookedCount}</strong>
        </label>
        <label className="flex items-center gap-2" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}>
          <input type="checkbox" checked={showUnbooked} onChange={(e) => setShowUnbooked(e.target.checked)} />
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "var(--jms-warning)" }} />
          To schedule <strong>{unbookedCount}</strong>
        </label>
        <select
          value={tech}
          onChange={(e) => setTech(e.target.value)}
          className="w-full rounded border px-1.5 py-1"
          style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
          aria-label="Whose jobs"
        >
          <option value="all">Everyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name || p.email}
            </option>
          ))}
          <option value="none">Unassigned</option>
        </select>
        {pending ? <p style={muted}>Finding {pending} address{pending === 1 ? "" : "es"}…</p> : null}
        {missing ? <p style={muted}>{missing} job{missing === 1 ? "" : "s"} not shown: address not found</p> : null}
      </div>
    </div>
  );
}

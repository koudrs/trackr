import { useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from "react";
import { LngLatBounds } from "maplibre-gl";
import { Map, MapMarker, MarkerContent, MarkerTooltip, MapRoute, useMap } from "./ui/map";
import type { MapRef } from "./ui/map";
import { Radio, Plane, RefreshCw, Crosshair, Gauge, ArrowUp, X, Search, Sparkles, Trash2, Clock, Navigation, Globe2, Plus, Minus, Compass, Map as Map2, Clapperboard, Sun, Moon, PanelLeftOpen, PanelLeftClose, Maximize, Minimize } from "lucide-react";
import { RadarInfoBar } from "./RadarInfoBar";
import type { TrackedAWB } from "../hooks/useTrackedAWBs";
import { useLiveFlights, pairFromShipment, flightKey, type LiveFlight, type FlightPair } from "../hooks/useLiveFlights";
import { trackAWB, getAirports, getFlightTrack, type TrackingResult } from "../lib/api";
import { analyzeJourney, type JourneyState } from "../lib/journey";

// Panama (Tocumen) is the hub: the platform's center of gravity. The map opens
// on Panama and "fit" always keeps it anchored so cargo is seen converging here.
const PANAMA: [number, number] = [-79.383, 9.071]; // [lng, lat]

/**
 * Build a bounding box that handles flights straddling the antimeridian
 * (e.g. China->Panama crosses 180deg). A naive min/max over longitudes would
 * span ~the whole globe; instead we unwrap each longitude relative to a running
 * reference so adjacent points never differ by more than 180deg.
 */
function boundsForFlights(flights: LiveFlight[], anchorPanama = true): LngLatBounds | null {
  if (flights.length === 0) return null;
  const bounds = new LngLatBounds();
  // Anchor on Panama so the hub is always in frame and cargo reads as converging.
  let refLng = anchorPanama ? PANAMA[0] : flights[0].displayLng;
  if (anchorPanama) bounds.extend(PANAMA);
  for (const f of flights) {
    let lng = f.displayLng;
    while (lng - refLng > 180) lng -= 360;
    while (lng - refLng < -180) lng += 360;
    bounds.extend([lng, f.displayLat]);
    refLng = (bounds.getWest() + bounds.getEast()) / 2;
  }
  return bounds;
}

interface LiveRadarViewProps {
  trackedAWBs: TrackedAWB[];
  selectedAWB: string | null;
  onSelect: (awb: string) => void;
  onClose: () => void; // back to Shipments (full-screen radar)
  darkMode: boolean;
  onToggleTheme: () => void;
}

/**
 * Make a polyline's longitudes continuous so it never jumps ~360deg across the
 * antimeridian (which makes MapLibre draw the line the long way around the globe).
 * Each point is shifted by whole turns of 360deg to stay within 180deg of the
 * previous one. renderWorldCopies then shows it correctly across the dateline.
 */
function unwrapLng(pts: [number, number][]): [number, number][] {
  if (pts.length === 0) return pts;
  const out: [number, number][] = [pts[0]];
  let prev = pts[0][0];
  for (let i = 1; i < pts.length; i++) {
    let lng = pts[i][0];
    while (lng - prev > 180) lng -= 360;
    while (lng - prev < -180) lng += 360;
    out.push([lng, pts[i][1]]);
    prev = lng;
  }
  return out;
}

/** Great-circle polyline between two [lng,lat] points (for planned route lines). */
function greatCircle(a: [number, number], b: [number, number], n = 48): [number, number][] {
  const toRad = Math.PI / 180, toDeg = 180 / Math.PI;
  const [lng1, lat1] = [a[0] * toRad, a[1] * toRad];
  const [lng2, lat2] = [b[0] * toRad, b[1] * toRad];
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2
  ));
  if (d === 0) return [a, b];
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lng1) + B * Math.cos(lat2) * Math.cos(lng2);
    const y = A * Math.cos(lat1) * Math.sin(lng1) + B * Math.cos(lat2) * Math.sin(lng2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    pts.push([Math.atan2(y, x) * toDeg, Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg]);
  }
  // Keep longitudes continuous so antimeridian crossings draw the short way.
  return unwrapLng(pts);
}

// AWB format XXX-XXXXXXXX (hyphen optional on input).
const AWB_RE = /^(\d{3})-?(\d{8})$/;

/** "6h 41m" from minutes. */
function fmtMin(min: number | null | undefined): string {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** A vertical-rate label from baro_rate ft/min. */
function vrLabel(vr: number | null | undefined): string {
  if (vr == null) return "";
  if (vr > 150) return "climbing";
  if (vr < -150) return "descending";
  return "cruise";
}

/** A single big stat tile for the HUD. */
function Stat({ icon, label, value, sub }: {
  icon: ReactNode; label: string; value: string; sub?: string;
}) {
  return (
    <div className="rounded-lg bg-[var(--muted)]/40 px-2.5 py-2">
      <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-[var(--muted-foreground)]">
        {icon}{label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span key={value} className="radar-tick text-base font-bold tabular-nums text-[var(--foreground)] leading-none">
          {value}
        </span>
        {sub && <span className="text-[9px] text-[var(--muted-foreground)]">{sub}</span>}
      </div>
    </div>
  );
}

/** Cinematic detail panel for the focused aircraft: cargo + live flight data. */
function FlightDetail({ f }: { f: LiveFlight }) {
  const pct = f.distance_flown_pct ?? 0;
  return (
    <div className="radar-panel-in px-4 py-3 border-b border-[var(--border)] bg-gradient-to-b from-[var(--muted)]/30 to-transparent">
      {/* flight + route headline */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xl font-extrabold tracking-tight text-[var(--foreground)] leading-none">
            {f.flight || f.callsign}
          </div>
          {f.aircraft_desc && (
            <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">
              {f.aircraft_desc}{f.registration ? ` · ${f.registration}` : ""}
            </div>
          )}
        </div>
        {f.origin && f.destination && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-lg font-bold text-[var(--foreground)]">{f.origin}</span>
            <Plane className="w-3.5 h-3.5 text-sky-400 -rotate-45" />
            <span className="text-lg font-bold text-[var(--foreground)]">{f.destination}</span>
          </div>
        )}
      </div>

      {/* route progress */}
      {f.distance_flown_pct != null && (
        <div className="mt-3">
          <div className="relative h-2 rounded-full bg-[var(--border)] overflow-hidden">
            <div
              className="radar-progress-fill h-full rounded-full"
              style={{ width: `${pct}%`, ["--radar-accent" as string]: "#38bdf8" }}
            />
            {/* plane glyph riding the progress bar */}
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 transition-all duration-700"
              style={{ left: `${Math.max(3, Math.min(97, pct))}%` }}
            >
              <Plane className="w-3 h-3 text-sky-100 rotate-90 drop-shadow" />
            </div>
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] font-medium text-[var(--muted-foreground)]">
            <span className="text-sky-400">{Math.round(pct)}% flown</span>
            {f.distance_remaining_nm != null && (
              <span>{Math.round(f.distance_remaining_nm).toLocaleString()} nm to go</span>
            )}
          </div>
        </div>
      )}

      {/* big live stat tiles */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Stat icon={<ArrowUp className="w-3 h-3" />} label="Altitude"
          value={f.altitude != null ? Math.round(f.altitude).toLocaleString() : "—"}
          sub={f.altitude != null ? `ft · ${vrLabel(f.vertical_rate)}` : undefined} />
        <Stat icon={<Gauge className="w-3 h-3" />} label="Speed"
          value={f.ground_speed != null ? Math.round(f.ground_speed).toString() : "—"}
          sub={f.ground_speed != null ? "kt" : undefined} />
        <Stat icon={<Clock className="w-3 h-3" />} label="Aloft"
          value={f.flight_minutes != null ? fmtMin(f.flight_minutes) : "—"} />
        <Stat icon={<Navigation className="w-3 h-3" />} label="ETA"
          value={f.eta_minutes != null ? `~${fmtMin(f.eta_minutes)}` : "—"} />
      </div>
    </div>
  );
}

const POLL_OPTIONS = [
  { label: "10s", value: 10_000 },
  { label: "15s", value: 15_000 },
  { label: "30s", value: 30_000 },
  { label: "60s", value: 60_000 },
];

// Plane SVG points "up" (north) at 0deg; MapMarker rotation handles the heading.
function PlaneIcon({ selected, grounded }: { selected: boolean; grounded: boolean }) {
  const fill = grounded ? "#94a3b8" : selected ? "#fbbf24" : "#38bdf8";
  return (
    <div
      className={`radar-plane ${selected ? "radar-plane--selected" : ""} ${
        grounded ? "radar-plane--grounded" : ""
      }`}
    >
      {selected && !grounded && <span className="radar-halo" />}
      <svg
        width={selected ? 36 : 30}
        height={selected ? 36 : 30}
        viewBox="0 0 39.769 39.769"
        fill={fill}
        stroke="#ffffff"
        strokeWidth="1.5"
      >
        <path d="M36.384 23.28v1.896c0 .46-.211.896-.571 1.181a1.5 1.5 0 0 1-1.282.278l-11.886-2.858v11.457l3.271 2.309a1 1 0 0 1 .424.816v.41c0 .291-.127.565-.346.758a1 1 0 0 1-.798.231l-5.314-.766-5.317.765a1 1 0 0 1-1.142-.989v-.409c0-.326.157-.632.423-.817l3.271-2.31V23.774L5.233 26.632a1.51 1.51 0 0 1-1.279-.277 1.51 1.51 0 0 1-.57-1.181v-1.896c0-.545.296-1.047.771-1.312l12.963-7.207V2.767A2.77 2.77 0 0 1 19.885 0a2.77 2.77 0 0 1 2.767 2.767V14.76l12.964 7.207c.471.266.768.768.768 1.313" />
      </svg>
    </div>
  );
}

/** The Panama hub marker — the platform's center of attention. */
function HubPin() {
  return (
    <div className="relative flex flex-col items-center" title="Panama Hub (PTY)">
      <span className="radar-halo" style={{ borderColor: "rgba(56,189,248,0.6)" }} />
      <div className="relative w-8 h-8 rounded-full bg-gradient-to-br from-sky-400 to-blue-700 border-2 border-white flex items-center justify-center shadow-lg shadow-sky-500/40">
        <Navigation className="w-4 h-4 text-white" />
      </div>
      <span className="mt-1 px-1.5 py-0.5 rounded bg-sky-500 text-white text-[10px] font-extrabold tracking-wide shadow">
        PTY
      </span>
    </div>
  );
}

/** Pin for cargo sitting at an airport between legs (a package badge). */
function AirportPin({ code }: { code: string }) {
  return (
    <div className="flex flex-col items-center" title={`Cargo at ${code}`}>
      <div className="w-7 h-7 rounded-lg bg-amber-500 border-2 border-white shadow-md flex items-center justify-center">
        <Plane className="w-3.5 h-3.5 text-white" />
      </div>
      <span className="mt-0.5 px-1 rounded bg-amber-500 text-white text-[9px] font-bold shadow">{code}</span>
    </div>
  );
}

/** Keeps the globe projection + atmospheric fog applied, re-applying after every
    style (re)load since setStyle clears fog. Driven from inside the Map context. */
function GlobeAtmosphere({ globe }: { globe: boolean }) {
  const { map, isLoaded } = useMap();
  useEffect(() => {
    if (!map) return;
    const apply = () => {
      try {
        map.setProjection({ type: globe ? "globe" : "mercator" });
        map.setRenderWorldCopies(!globe);
        if (globe) {
          // Atmospheric halo + deep-space gradient behind the globe (MapLibre sky).
          map.setSky({
            "sky-color": "#0a1228",
            "sky-horizon-blend": 0.5,
            "horizon-color": "#245c9e",
            "horizon-fog-blend": 0.6,
            "fog-color": "#0d1426",
            "fog-ground-blend": 0.1,
            "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 0.7, 7, 0],
          } as Record<string, unknown>);
        } else {
          map.setSky(undefined as unknown as Record<string, unknown>);
        }
      } catch { /* not ready */ }
    };
    apply();
    map.on("styledata", apply);
    return () => { map.off("styledata", apply); };
  }, [map, isLoaded, globe]);
  return null;
}

/** A labeled toolbar button (icon + text) — clear for non-expert users. */
function ToolButton({ icon, label, active, onClick, title }: {
  icon: ReactNode; label?: string; active?: boolean; onClick: () => void; title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-semibold transition-colors ${
        active
          ? "bg-sky-500 text-white shadow shadow-sky-500/30"
          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)]"
      }`}
    >
      {icon}{label && <span className="hidden sm:inline">{label}</span>}
    </button>
  );
}

/** Keep Panama centered on first load. We deliberately do NOT fit-to-all-flights
    automatically: with worldwide cargo the bounding box spans half the planet and
    its center lands in the middle of an ocean. Panama is the hub, so it stays the
    anchor; the user can press "Fit" to frame everything on demand. */
function FitToFlights({ flights }: { flights: LiveFlight[] }) {
  const { map, isLoaded } = useMap();
  const didCenter = useRef(false);

  useEffect(() => {
    if (!map || !isLoaded || didCenter.current) return;
    map.easeTo({ center: PANAMA, duration: 800 });
    didCenter.current = true;
  }, [map, isLoaded]);

  // flights param kept for API compatibility / future use.
  void flights;
  return null;
}

export function LiveRadarView({ trackedAWBs, selectedAWB, onSelect, onClose, darkMode, onToggleTheme }: LiveRadarViewProps) {
  const mapRef = useRef<MapRef | null>(null);

  // Sidebar collapse (so the map can own the whole screen on a TV).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Demo mode: show real airborne traffic so the radar can be seen working.
  const [demo, setDemo] = useState(false);

  // 3D globe vs flat mercator. Globe = the cinematic, TV-grade view.
  const [globe, setGlobe] = useState<boolean>(() => {
    const saved = localStorage.getItem("radarGlobe");
    return saved ? saved === "true" : true; // default to globe
  });
  useEffect(() => { localStorage.setItem("radarGlobe", String(globe)); }, [globe]);

  // Cinema mode: auto-tour the active flights for an unattended TV display.
  const [cinema, setCinema] = useState(false);
  const cinemaIdxRef = useRef(0);

  // Projection + atmosphere are applied by <GlobeAtmosphere> inside the Map,
  // which also survives style reloads. (See the component above.)

  // The radar's own active list: AWBs added straight from here (independent of
  // the Shipments tracker). We keep the full TrackingResult so we can analyze
  // the multi-leg journey (e.g. waiting in IST for the next flight).
  const [activeShipments, setActiveShipments] = useState<{ awb: string; data: TrackingResult }[]>([]);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Which aircraft is focused on the map (drives the path overlay). Works for
  // both demo (keyed by callsign) and real flights (keyed by awb).
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // Airport coordinates (lazy-loaded) for route lines + at-airport pins.
  const [airports, setAirports] = useState<Record<string, [number, number]>>({});

  // Pairs for the radar's own added shipments. FR24 has historical tracks, so
  // we send any shipment with a flight number — in-transit OR already delivered
  // (a delivered AWB still shows its real flown route).
  const activePairs = useMemo<FlightPair[]>(
    () =>
      activeShipments
        .map((s) => pairFromShipment(s.awb, s.data))
        .filter((p): p is FlightPair => !!p),
    [activeShipments]
  );

  const {
    flights,
    pairs,
    trails,
    isLoading,
    error,
    lastUpdated,
    matched,
    live,
    setLive,
    intervalMs,
    setIntervalMs,
    refresh,
  } = useLiveFlights(trackedAWBs, { extraPairs: activePairs, demo });

  // All shipments we know about (tracker + radar's own list), with their journey.
  const journeys = useMemo(() => {
    const all = [
      ...trackedAWBs.map((t) => ({ awb: t.awb, data: t.data })),
      ...activeShipments.map((s) => ({ awb: s.awb, data: s.data as TrackingResult | null })),
    ];
    const seen = new Set<string>();
    const out: { awb: string; journey: JourneyState }[] = [];
    for (const s of all) {
      if (seen.has(s.awb) || !s.data) continue;
      seen.add(s.awb);
      out.push({ awb: s.awb, journey: analyzeJourney(s.data) });
    }
    return out;
  }, [trackedAWBs, activeShipments]);

  // Shipments currently sitting at an intermediate airport (waiting for a leg).
  const waiting = useMemo(
    () => journeys.filter((j) => j.journey.phase === "at_airport" && j.journey.at),
    [journeys]
  );

  // Load coordinates for every airport that appears in any journey leg.
  useEffect(() => {
    const codes = new Set<string>();
    for (const { journey } of journeys) {
      if (journey.at) codes.add(journey.at);
      for (const leg of journey.legs) {
        if (leg.from) codes.add(leg.from);
        if (leg.to) codes.add(leg.to);
      }
    }
    const missing = [...codes].filter((c) => !(c in airports));
    if (missing.length === 0) return;
    getAirports(missing).then((found) =>
      setAirports((prev) => ({ ...prev, ...found }))
    );
  }, [journeys, airports]);

  // Add an AWB from the radar: track it, pull its current flight number, and
  // push it onto the active list (so it gets plotted even if the tracker
  // doesn't have it). We don't gate on DEP — if it has a flight we try it.
  const handleAdd = useCallback(async () => {
    const raw = query.trim().toUpperCase();
    const m = AWB_RE.exec(raw);
    if (!m) {
      setAddError("Format: XXX-XXXXXXXX");
      return;
    }
    const awb = `${m[1]}-${m[2]}`;
    setAdding(true);
    setAddError(null);
    try {
      const data = await trackAWB(awb);
      if (!data.events?.length) {
        setAddError("No tracking events for this AWB yet");
        return;
      }
      const j = analyzeJourney(data);
      // Helpful status note so the user understands what they'll see. With FR24
      // we can draw the real flown route even for delivered shipments, so these
      // are informational, not errors — only block if there's no flight number.
      if (j.phase === "at_airport" && j.nextFlight) {
        setAddError(`At ${j.at}, waiting for ${j.nextFlight} → ${j.nextTo}`);
      } else if (!pairFromShipment(awb, data)) {
        setAddError("No flight number on this AWB yet");
        return;
      }
      setActiveShipments((prev) =>
        prev.some((s) => s.awb === awb) ? prev : [...prev, { awb, data }]
      );
      setQuery("");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Tracking error");
    } finally {
      setAdding(false);
    }
  }, [query]);

  const removeActive = (awb: string) =>
    setActiveShipments((prev) => prev.filter((s) => s.awb !== awb));

  // Real flown track (FR24) of the focused aircraft, keyed by fr24_id.
  const [realTracks, setRealTracks] = useState<Record<string, [number, number][]>>({});

  const flyTo = (f: LiveFlight) => {
    setFocusKey(flightKey(f));
    if (f.awb && !f.awb.startsWith("DEMO:")) onSelect(f.awb);
    mapRef.current?.flyTo({ center: [f.displayLng, f.displayLat], zoom: 6, duration: 1000 });
    // Pull the real flown path from FR24 for this aircraft (once).
    if (f.fr24_id && !realTracks[f.fr24_id]) {
      getFlightTrack(f.fr24_id).then((track) => {
        if (track.length >= 2) {
          setRealTracks((prev) => ({ ...prev, [f.fr24_id!]: track }));
        }
      });
    }
  };

  const fitAll = () => {
    const bounds = boundsForFlights(flights);
    if (mapRef.current && bounds) {
      // Cap how far it can zoom out so the Panama hub stays readable even when
      // cargo is spread worldwide.
      mapRef.current.fitBounds(bounds, { padding: 100, minZoom: 1.8, maxZoom: 6, duration: 800 });
    }
  };

  // Cinema mode:
  //  - If a flight is SELECTED: cinematic follow — keep that aircraft framed as
  //    it moves (works for demo or real flights), with a tilted globe view.
  //  - If nothing is selected: gentle auto-tour across all flights as a fallback.
  useEffect(() => {
    if (!cinema) return;
    const m = mapRef.current;
    if (!m) return;

    // FOLLOW a specific selected flight.
    if (focusKey) {
      const follow = () => {
        const mm = mapRef.current;
        const f = flights.find((x) => flightKey(x) === focusKey);
        if (!mm || !f) return;
        mm.easeTo({
          center: [f.displayLng, f.displayLat],
          zoom: Math.max(mm.getZoom(), 4.2),
          pitch: globe ? 50 : 0,
          duration: 1800,
          essential: true,
        });
      };
      follow();
      const id = window.setInterval(follow, 2000); // track its movement
      return () => clearInterval(id);
    }

    // No selection -> auto-tour all flights, with a Panama beauty shot each lap.
    const step = () => {
      const mm = mapRef.current;
      if (!mm || flights.length === 0) return;
      const i = cinemaIdxRef.current % (flights.length + 1);
      cinemaIdxRef.current = i + 1;
      if (i === flights.length) {
        const b = boundsForFlights(flights);
        if (b) mm.fitBounds(b, { padding: 120, minZoom: 1.8, maxZoom: 5, duration: 2500, pitch: globe ? 35 : 0 });
      } else {
        const f = flights[i];
        mm.flyTo({ center: [f.displayLng, f.displayLat], zoom: 4.5,
          pitch: globe ? 45 : 0, duration: 2500, essential: true });
      }
    };
    step();
    const id = window.setInterval(step, 7000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cinema, focusKey, flights.length, globe]);

  const zoomBy = (delta: number) => {
    const m = mapRef.current;
    if (m) m.easeTo({ zoom: m.getZoom() + delta, duration: 300 });
  };
  const resetNorth = () => mapRef.current?.easeTo({ bearing: 0, pitch: 0, duration: 500 });

  // Browser fullscreen — one click to throw it on a TV.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Breadcrumb trail of the focused aircraft (path it has flown since opened).
  const focusedTrail = focusKey ? trails[focusKey] : undefined;

  return (
    <div className="fixed inset-0 z-[1000]">
      {/* Full-bleed map. Globe projection = spherical 3D earth (no repeated
          world, planes feel like they float over a real globe). */}
      <Map
        ref={mapRef}
        className="absolute inset-0"
        theme={darkMode ? "dark" : "light"}
        viewport={{ center: PANAMA, zoom: globe ? 2.6 : 2.4 }}
        projection={globe ? { type: "globe" } : { type: "mercator" }}
        minZoom={1.6}
        maxZoom={9}
        attributionControl={false}
      >
        <GlobeAtmosphere globe={globe} />
        <FitToFlights flights={flights} />

        {/* Panama hub — always shown as the platform's center of attention */}
        <MapMarker longitude={PANAMA[0]} latitude={PANAMA[1]}>
          <MarkerContent>
            <HubPin />
          </MarkerContent>
          <MarkerTooltip>
            <div className="text-xs font-semibold">PTY · Panama Hub</div>
          </MarkerTooltip>
        </MapMarker>

        {/* Planned route lines (dashed) for each known shipment: connect its legs
            through their airports. The free feed has no historical track, so this
            shows the intended path of the whole journey. */}
        {!demo && journeys.map(({ awb, journey }) => {
          const stops: [number, number][] = [];
          const codes: string[] = [];
          for (const leg of journey.legs) {
            if (leg.from) codes.push(leg.from);
            if (leg.to) codes.push(leg.to);
          }
          // de-dup consecutive
          const seq = codes.filter((c, i) => c && c !== codes[i - 1]);
          for (const c of seq) {
            const coord = airports[c];
            if (coord) stops.push([coord[1], coord[0]]); // [lng,lat]
          }
          if (stops.length < 2) return null;
          const line: [number, number][] = [];
          for (let i = 0; i < stops.length - 1; i++) {
            line.push(...greatCircle(stops[i], stops[i + 1]));
          }
          // Re-unwrap the joined multi-leg line so leg boundaries stay continuous.
          const continuous = unwrapLng(line);
          return (
            <MapRoute
              key={`route-${awb}`}
              coordinates={continuous}
              color="#94a3b8"
              width={2}
              opacity={0.6}
              dashArray={[2, 2]}
              interactive={false}
            />
          );
        })}

        {/* Cargo waiting at an intermediate airport (e.g. in IST for the PTY leg) */}
        {!demo && waiting.map(({ awb, journey }) => {
          const coord = journey.at ? airports[journey.at] : undefined;
          if (!coord) return null;
          return (
            <MapMarker
              key={`wait-${awb}`}
              longitude={coord[1]}
              latitude={coord[0]}
              onClick={() => { setFocusKey(awb); onSelect(awb); }}
            >
              <MarkerContent>
                <AirportPin code={journey.at!} />
              </MarkerContent>
              <MarkerTooltip>
                <div className="text-xs">
                  <div className="font-semibold">At {journey.at}</div>
                  {journey.nextFlight && (
                    <div className="text-[10px]">waiting {journey.nextFlight} → {journey.nextTo}</div>
                  )}
                  <div className="font-mono text-[10px]">{awb}</div>
                </div>
              </MarkerTooltip>
            </MapMarker>
          );
        })}

        {/* Demo: draw every flight's already-flown track so the map shows the
            full China->Panama lanes with stops, not just the selected one. */}
        {demo && flights.map((f) => {
          if (!f.trail || f.trail.length < 2) return null;
          const isFocused = flightKey(f) === focusKey;
          if (isFocused) return null; // focused one drawn brighter below
          return (
            <MapRoute
              key={`demotrail-${flightKey(f)}`}
              coordinates={unwrapLng(f.trail)}
              color="#38bdf8"
              width={2}
              opacity={0.4}
              interactive={false}
            />
          );
        })}

        {/* Real flown path of the focused aircraft. Prefer the real FR24/demo
            track, fall back to the live-accumulated breadcrumb.
            Both are unwrapped so antimeridian crossings draw the short way. */}
        {(() => {
          const focused = focusKey ? flights.find((x) => flightKey(x) === focusKey) : null;
          // Priority: real FR24 track (fetched on select) > per-position trail >
          // live-accumulated breadcrumb.
          const fr24Track = focused?.fr24_id ? realTracks[focused.fr24_id] : undefined;
          const positionTrail = focused?.trail ?? [];
          const path =
            fr24Track && fr24Track.length >= 2 ? fr24Track
            : positionTrail.length >= 2 ? positionTrail
            : (focusedTrail && focusedTrail.length >= 2 ? focusedTrail : null);
          if (!path) return null;
          const coords = unwrapLng(path);
          // Neon contrail: a wide soft glow underneath + a bright core on top.
          return (
            <>
              <MapRoute coordinates={coords} color="#38bdf8" width={11} opacity={0.18} interactive={false} />
              <MapRoute coordinates={coords} color="#38bdf8" width={5} opacity={0.35} interactive={false} />
              <MapRoute coordinates={coords} color="#e0f2fe" width={2} opacity={0.95} interactive={false} />
            </>
          );
        })()}

        {flights.map((f) => {
          const selected = flightKey(f) === focusKey || (!!f.awb && f.awb === selectedAWB);
          return (
            <MapMarker
              key={flightKey(f)}
              longitude={f.displayLng}
              latitude={f.displayLat}
              rotation={f.track ?? 0}
              rotationAlignment="map"
              onClick={() => flyTo(f)}
            >
              <MarkerContent>
                <PlaneIcon selected={selected} grounded={f.on_ground} />
              </MarkerContent>
              <MarkerTooltip>
                <div className="text-xs">
                  <div className="font-semibold">{f.flight || f.callsign}</div>
                  {f.origin && f.destination && (
                    <div className="text-[10px]">{f.origin} → {f.destination}</div>
                  )}
                  {f.awb && !f.awb.startsWith("DEMO:") && <div className="font-mono text-[10px]">{f.awb}</div>}
                </div>
              </MarkerTooltip>
            </MapMarker>
          );
        })}
      </Map>

      {/* Cinematic vignette for depth on a big screen (non-interactive) */}
      <div className="pointer-events-none absolute inset-0 z-[420]"
        style={{ boxShadow: "inset 0 0 200px 40px rgba(0,0,0,0.55)" }} />

      {/* Bottom toolbar — clear, labeled controls for non-expert users */}
      <div className="radar-hud absolute bottom-5 left-1/2 -translate-x-1/2 z-[450] flex items-center gap-1 rounded-2xl px-2 py-1.5">
        <ToolButton icon={<Minus className="w-4 h-4" />} onClick={() => zoomBy(-1)} title="Zoom out" />
        <ToolButton icon={<Plus className="w-4 h-4" />} onClick={() => zoomBy(1)} title="Zoom in" />
        <ToolButton icon={<Crosshair className="w-4 h-4" />} label="Fit" onClick={fitAll} title="Fit all flights in view" />
        <ToolButton icon={<Compass className="w-4 h-4" />} onClick={resetNorth} title="Reset north / level view" />

        <div className="w-px h-6 bg-[var(--border)] mx-1" />

        <ToolButton
          icon={globe ? <Globe2 className="w-4 h-4" /> : <Map2 className="w-4 h-4" />}
          label={globe ? "Globe" : "Flat"}
          active={globe}
          onClick={() => setGlobe((g) => !g)}
          title="Switch between 3D globe and flat map"
        />
        <ToolButton
          icon={<Sparkles className="w-4 h-4" />}
          label="Demo"
          active={demo}
          onClick={() => setDemo((d) => !d)}
          title="Demo: cargo flights China → Panama with stops"
        />
        <ToolButton
          icon={<Clapperboard className="w-4 h-4" />}
          label="Cinema"
          active={cinema}
          onClick={() => setCinema((c) => !c)}
          title={focusKey
            ? "Cinema: follow the selected flight"
            : "Cinema: select a flight to follow it, or auto-tour all"}
        />

        <div className="w-px h-6 bg-[var(--border)] mx-1" />

        <ToolButton
          icon={<span className={`radar-live-dot w-2 h-2 rounded-full ${live ? "bg-green-400" : "bg-[var(--muted-foreground)]"}`} />}
          label={live ? "Live" : "Paused"}
          active={live}
          onClick={() => setLive(!live)}
          title={live ? "Live updates on — click to pause" : "Paused — click to go live"}
        />

        <div className="w-px h-6 bg-[var(--border)] mx-1" />

        <ToolButton
          icon={darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          onClick={onToggleTheme}
          title={darkMode ? "Light mode" : "Dark mode"}
        />
        <ToolButton
          icon={isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
          label={isFullscreen ? "Exit" : "Full"}
          onClick={toggleFullscreen}
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen (best for TV)"}
        />
      </div>

      {/* World clocks + Panama weather (top-right) */}
      <RadarInfoBar />

      {/* Floating sidebar (collapsible) */}
      {!sidebarCollapsed && (
      <div className="radar-panel-in radar-hud absolute left-4 top-4 bottom-4 z-[400] w-80 max-w-[calc(100%-2rem)] flex flex-col rounded-2xl overflow-hidden">
        {/* Header */}
        <div className="shrink-0 px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="relative w-9 h-9 rounded-xl bg-gradient-to-br from-sky-500 to-blue-700 flex items-center justify-center overflow-hidden shadow-lg shadow-sky-500/30">
                {/* sweeping radar beam */}
                <div className="radar-sweep absolute inset-0">
                  <div className="absolute left-1/2 top-1/2 h-1/2 w-1/2 origin-top-left"
                    style={{ background: "conic-gradient(from 0deg, rgba(255,255,255,0.5), transparent 70%)" }} />
                </div>
                <Radio className="relative w-4 h-4 text-white" />
              </div>
              <div>
                <h2 className="text-sm font-bold tracking-tight text-[var(--foreground)] leading-tight">Live Cargo Radar</h2>
                <p className="text-[10px] text-[var(--muted-foreground)] leading-tight">
                  <span className="text-sky-400 font-semibold">{matched}</span> live
                  {!demo && <> · {pairs.length} tracked</>}{demo && " · demo"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={refresh}
                disabled={isLoading}
                title="Refresh now"
                className="p-1.5 rounded-lg hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
              </button>
              <button
                onClick={() => setSidebarCollapsed(true)}
                title="Hide panel"
                className="p-1.5 rounded-lg hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
              <button
                onClick={onClose}
                title="Back to Shipments"
                className="p-1.5 rounded-lg hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Add AWB to the radar's active list */}
          <div className="mt-3">
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--muted-foreground)]" />
                <input
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setAddError(null); }}
                  onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                  placeholder="Add AWB (e.g. 233-10491880)"
                  className="w-full pl-7 pr-2 py-1.5 text-[11px] rounded-md bg-[var(--muted)] border border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]/60 focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                />
              </div>
              <button
                onClick={handleAdd}
                disabled={adding}
                className="px-3 py-1.5 text-[11px] font-semibold rounded-md bg-sky-500 text-white hover:bg-sky-400 disabled:opacity-50 transition-colors"
              >
                {adding ? "…" : "Add"}
              </button>
            </div>
            {addError && <p className="mt-1 text-[10px] text-red-500">{addError}</p>}
          </div>

          {/* Update frequency (live on/off lives in the bottom toolbar) */}
          {live && (
            <div className="mt-2 flex items-center gap-2 text-[10px] text-[var(--muted-foreground)]">
              <span>Updates</span>
              <select
                value={intervalMs}
                onChange={(e) => setIntervalMs(Number(e.target.value))}
                className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--muted)] border border-[var(--border)] text-[var(--foreground)]"
                title="How often positions refresh"
              >
                {POLL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>every {o.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Focused flight detail (combined cargo + live data) */}
        {(() => {
          const focused = focusKey ? flights.find((x) => flightKey(x) === focusKey) : null;
          return focused ? <FlightDetail f={focused} /> : null;
        })()}

        {/* Flight list */}
        <div className="flex-1 overflow-y-auto">
          {demo ? (
            <ul className="divide-y divide-[var(--border)]">
              {flights.map((f) => (
                <li key={f.callsign || f.hex}>
                  <button
                    onClick={() => flyTo(f)}
                    className="w-full text-left px-4 py-2 hover:bg-[var(--muted)] transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[var(--foreground)]">{f.callsign}</span>
                      <span className="text-[10px] text-[var(--muted-foreground)]">
                        {f.altitude != null ? `${Math.round(f.altitude).toLocaleString()} ft` : "—"}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : pairs.length === 0 && waiting.length === 0 ? (
            <div className="p-6 text-center">
              <Plane className="w-8 h-8 mx-auto text-[var(--muted-foreground)] opacity-40" />
              <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                No flights yet.
              </p>
              <p className="mt-1 text-[10px] text-[var(--muted-foreground)]/70">
                Add an AWB above, or shipments in the air (DEP) show up here. Try Demo mode.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {/* Cargo waiting at an intermediate airport */}
              {waiting.map(({ awb, journey }) => {
                const isActive = activeShipments.some((s) => s.awb === awb);
                return (
                  <li key={`w-${awb}`} className="group relative">
                    <button
                      onClick={() => { setFocusKey(awb); onSelect(awb); const c = journey.at ? airports[journey.at] : null; if (c) mapRef.current?.flyTo({ center: [c[1], c[0]], zoom: 5, duration: 1000 }); }}
                      className="w-full text-left px-4 py-2.5 hover:bg-[var(--muted)] transition-colors"
                    >
                      <div className="flex items-center justify-between pr-5">
                        <span className="text-xs font-semibold text-[var(--foreground)]">
                          {journey.nextFlight || journey.currentFlight || awb}
                        </span>
                        <span className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                          at {journey.at}
                        </span>
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-[var(--muted-foreground)]">{awb}</div>
                      {journey.nextFlight && (
                        <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">
                          waiting {journey.nextFlight} → {journey.nextTo}
                        </div>
                      )}
                    </button>
                    {isActive && (
                      <button
                        onClick={() => removeActive(awb)}
                        title="Remove from radar"
                        className="absolute right-2 top-2 p-1 rounded text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
              {pairs.map((p) => {
                const f = flights.find((x) => x.awb === p.awb);
                const selected = p.awb === selectedAWB;
                const isActive = activeShipments.some((s) => s.awb === p.awb);
                return (
                  <li key={p.awb} className="group relative">
                    <button
                      onClick={() => (f ? flyTo(f) : onSelect(p.awb))}
                      className={`w-full text-left px-4 py-2.5 transition-colors ${
                        selected ? "bg-[var(--accent)]" : "hover:bg-[var(--muted)]"
                      }`}
                    >
                      <div className="flex items-center justify-between pr-5">
                        <span className="text-xs font-semibold text-[var(--foreground)]">
                          {p.flight}
                        </span>
                        {f ? (
                          f.on_ground ? (
                            <span className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                              on ground
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[10px] text-green-600 dark:text-green-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                              airborne
                            </span>
                          )
                        ) : (
                          <span className="text-[10px] text-[var(--muted-foreground)]">
                            no signal
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-[var(--muted-foreground)]">
                        {p.awb}
                      </div>
                      {f && (
                        <div className="mt-1 flex items-center gap-3 text-[10px] text-[var(--muted-foreground)]">
                          <span className="flex items-center gap-0.5">
                            <ArrowUp className="w-3 h-3" />
                            {f.altitude != null ? `${Math.round(f.altitude).toLocaleString()} ft` : "—"}
                          </span>
                          <span className="flex items-center gap-0.5">
                            <Gauge className="w-3 h-3" />
                            {f.ground_speed != null ? `${Math.round(f.ground_speed)} kt` : "—"}
                          </span>
                        </div>
                      )}
                    </button>
                    {isActive && (
                      <button
                        onClick={() => removeActive(p.awb)}
                        title="Remove from radar"
                        className="absolute right-2 top-2 p-1 rounded text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 px-4 py-2 border-t border-[var(--border)] flex items-center justify-between">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {lastUpdated
              ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}`
              : "Not updated yet"}
          </span>
          <button
            onClick={fitAll}
            title="Fit all flights"
            className="flex items-center gap-1 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <Crosshair className="w-3 h-3" /> Fit
          </button>
        </div>

        {error && (
          <div className="shrink-0 px-4 py-2 bg-red-500/10 border-t border-red-500/30">
            <p className="text-[10px] text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}
      </div>
      )}

      {/* Re-open panel button when collapsed */}
      {sidebarCollapsed && (
        <button
          onClick={() => setSidebarCollapsed(false)}
          title="Show panel"
          className="radar-hud radar-panel-in absolute left-4 top-4 z-[400] flex items-center gap-2 px-3 h-11 rounded-2xl text-sm font-semibold text-[var(--foreground)]"
        >
          <PanelLeftOpen className="w-5 h-5 text-sky-400" />
          Flights
        </button>
      )}
    </div>
  );
}

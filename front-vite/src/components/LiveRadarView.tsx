import { useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from "react";
import { LngLatBounds } from "maplibre-gl";
import { Map, MapMarker, MarkerContent, MarkerTooltip, MapRoute, useMap } from "./ui/map";
import type { MapRef } from "./ui/map";
import { Radio, Plane, RefreshCw, Crosshair, Gauge, ArrowUp, X, Search, Trash2, Clock, Navigation, Globe2, Plus, Minus, Compass, Map as Map2, Clapperboard, Sun, Moon, PanelLeftOpen, PanelLeftClose, Maximize, Minimize, Play } from "lucide-react";
import { RadarInfoBar } from "./RadarInfoBar";
import type { TrackedAWB } from "../hooks/useTrackedAWBs";
import { useLiveFlights, pairFromShipment, flightKey, type LiveFlight } from "../hooks/useLiveFlights";
import { getAirports, getFlightTrack, type TrackingResult } from "../lib/api";
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

interface AirportGroup {
  code: string;
  items: { awb: string; journey: JourneyState }[];
}

interface LiveRadarViewProps {
  trackedAWBs: TrackedAWB[];
  selectedAWB: string | null;
  onSelect: (awb: string) => void;
  onClose: () => void; // back to Shipments (full-screen radar)
  darkMode: boolean;
  onToggleTheme: () => void;
  onAddAWB: (awb: string) => Promise<TrackingResult | null>; // shared add (same list as normal view); returns scraped data
  onRemoveAWB: (awb: string) => void;          // shared remove
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
function FlightDetail({ f, onClose, onPlay, playing, onGoTo }: {
  f: LiveFlight; onClose: () => void; onPlay: () => void; playing: boolean;
  onGoTo: (code: string) => void;
}) {
  const pct = f.distance_flown_pct ?? 0;
  // A replay is possible only when a real track exists (or can be fetched).
  const canPlay = !!f.fr24_id || (f.trail?.length ?? 0) >= 2;
  return (
    <div className="radar-panel-in relative px-4 py-3 border-b border-[var(--border)] bg-gradient-to-b from-[var(--muted)]/30 to-transparent">
      {/* actions: replay + deselect */}
      <div className="absolute top-2 right-2 flex items-center gap-1">
        {canPlay && (
          <button
            onClick={onPlay}
            title={playing ? "Replaying route…" : "Replay this flight's route"}
            className={`radar-tool flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold ${
              playing ? "bg-amber-500 text-white" : "bg-[var(--muted)] text-[var(--foreground)] hover:bg-amber-500 hover:text-white"
            }`}
          >
            <Play className="w-3 h-3" /> {playing ? "Playing" : "Replay"}
          </button>
        )}
        <button
          onClick={onClose}
          title="Deselect — show all flights"
          className="radar-tool p-1 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)]"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {/* flight + route headline */}
      <div className="flex items-start justify-between gap-2 pr-24">
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
            <button
              onClick={() => onGoTo(f.origin!)}
              title={`Jump to origin (${f.origin})`}
              className="radar-tool text-lg font-bold text-[var(--foreground)] hover:text-amber-400 underline decoration-dotted decoration-[var(--muted-foreground)] underline-offset-4"
            >
              {f.origin}
            </button>
            <Plane className="w-3.5 h-3.5 text-amber-400 -rotate-45" />
            <button
              onClick={() => onGoTo(f.destination!)}
              title={`Jump to destination (${f.destination})`}
              className="radar-tool text-lg font-bold text-[var(--foreground)] hover:text-amber-400 underline decoration-dotted decoration-[var(--muted-foreground)] underline-offset-4"
            >
              {f.destination}
            </button>
          </div>
        )}
      </div>

      {/* route progress */}
      {f.distance_flown_pct != null && (
        <div className="mt-3">
          <div className="relative h-2 rounded-full bg-[var(--border)] overflow-hidden">
            <div
              className="radar-progress-fill h-full rounded-full"
              style={{ width: `${pct}%`, ["--radar-accent" as string]: "#e5e5e5" }}
            />
            {/* plane glyph riding the progress bar */}
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 transition-all duration-700"
              style={{ left: `${Math.max(3, Math.min(97, pct))}%` }}
            >
              <Plane className="w-3 h-3 text-zinc-100 rotate-90 drop-shadow" />
            </div>
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] font-medium text-[var(--muted-foreground)]">
            <span className="text-amber-400">{Math.round(pct)}% flown</span>
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

// Credit-conscious intervals. Positions barely move in a minute at altitude and
// the map interpolates between updates, so long intervals look identical while
// costing far fewer FR24 credits. 5 min is the recommended default.
const POLL_OPTIONS = [
  { label: "1 min", value: 60_000 },
  { label: "2 min", value: 120_000 },
  { label: "5 min", value: 300_000 },
  { label: "10 min", value: 600_000 },
];

// Plane SVG points "up" (north) at 0deg; MapMarker rotation handles the heading.
function PlaneIcon({ selected, grounded, dark }: { selected: boolean; grounded: boolean; dark: boolean }) {
  // Neutral by default (white on dark, near-black on light); amber when selected.
  const fill = grounded ? "#9ca3af" : selected ? "#fbbf24" : dark ? "#f5f5f5" : "#1a1a1a";
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
        stroke={dark ? "#0a0a0a" : "#ffffff"}
        strokeWidth="1.5"
      >
        <path d="M36.384 23.28v1.896c0 .46-.211.896-.571 1.181a1.5 1.5 0 0 1-1.282.278l-11.886-2.858v11.457l3.271 2.309a1 1 0 0 1 .424.816v.41c0 .291-.127.565-.346.758a1 1 0 0 1-.798.231l-5.314-.766-5.317.765a1 1 0 0 1-1.142-.989v-.409c0-.326.157-.632.423-.817l3.271-2.31V23.774L5.233 26.632a1.51 1.51 0 0 1-1.279-.277 1.51 1.51 0 0 1-.57-1.181v-1.896c0-.545.296-1.047.771-1.312l12.963-7.207V2.767A2.77 2.77 0 0 1 19.885 0a2.77 2.77 0 0 1 2.767 2.767V14.76l12.964 7.207c.471.266.768.768.768 1.313" />
      </svg>
    </div>
  );
}

/** The Panama hub marker — the platform's center of attention. */
// NOTE on anchoring: MapLibre markers anchor at the CENTER of their element. So
// each pin keeps its ICON as a centered box (anchored exactly on the lat/lng) and
// renders its text label ABSOLUTELY positioned below — the label doesn't shift
// the element's center, so the icon stays glued to the geographic point.
function HubPin() {
  return (
    <div className="relative" title="Panama Hub (PTY)">
      <span className="radar-halo" style={{ borderColor: "rgba(56,189,248,0.6)" }} />
      <div className="relative w-8 h-8 rounded-full bg-gradient-to-br from-zinc-600 to-zinc-800 border-2 border-white flex items-center justify-center shadow-lg shadow-amber-500/40">
        <Navigation className="w-4 h-4 text-white" />
      </div>
      <span className="absolute left-1/2 top-full -translate-x-1/2 mt-1 px-1.5 py-0.5 rounded bg-amber-500 text-white text-[10px] font-extrabold tracking-wide shadow whitespace-nowrap">
        PTY
      </span>
    </div>
  );
}

/** Pin for cargo at an airport. Shows a count badge when several shipments are
    grouped there (e.g. the Panama hub), so markers don't overlap. */
function AirportPin({ code, variant = "waiting", count = 1 }: {
  code: string; variant?: "waiting" | "awaiting" | "delivered"; count?: number;
}) {
  const color = variant === "delivered" ? "bg-emerald-500"
    : variant === "awaiting" ? "bg-zinc-500"
    : "bg-amber-500";
  const size = count > 1 ? "w-9 h-9" : "w-7 h-7";
  return (
    <div className="relative" title={`${count} cargo at ${code}`}>
      <div className={`${size} rounded-xl ${color} border-2 border-white shadow-md flex items-center justify-center transition-all`}>
        {count > 1
          ? <span className="text-white text-xs font-extrabold tabular-nums">{count}</span>
          : <Plane className="w-3.5 h-3.5 text-white" />}
      </div>
      <span className={`absolute left-1/2 top-full -translate-x-1/2 mt-0.5 px-1 rounded ${color} text-white text-[9px] font-bold shadow whitespace-nowrap`}>{code}</span>
    </div>
  );
}

/** Marker for a departure (origin) airport — a bright ringed dot, clearly
    visible on the dark map and distinct from the colored cargo pins. */
function OriginDot({ code }: { code: string }) {
  return (
    <div className="relative" title={`Origin: ${code}`}>
      {/* soft halo + solid white core with a sky ring */}
      <div className="w-4 h-4 rounded-full bg-sky-400/25 flex items-center justify-center">
        <div className="w-2.5 h-2.5 rounded-full bg-white ring-2 ring-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.8)]" />
      </div>
      <span className="absolute left-1/2 top-full -translate-x-1/2 mt-0.5 px-1 rounded bg-black/60 text-sky-200 text-[8px] font-bold tracking-wide whitespace-nowrap">{code}</span>
    </div>
  );
}

/** Marker for a flight that's airborne per the tracker but has no live ADS-B
    signal — an ESTIMATED position (dashed, muted, clearly "not confirmed"). */
function EstimatedPin() {
  return (
    <div className="relative" title="Estimated position — no live signal">
      <div className="w-7 h-7 rounded-full border-2 border-dashed border-zinc-400 bg-zinc-500/30 flex items-center justify-center backdrop-blur-sm">
        <Plane className="w-3.5 h-3.5 text-zinc-200" />
      </div>
      <span className="absolute left-1/2 top-full -translate-x-1/2 mt-0.5 px-1 rounded bg-zinc-600/80 text-white text-[8px] font-semibold shadow whitespace-nowrap">~est</span>
    </div>
  );
}

/** Keeps the globe projection + atmospheric fog applied, re-applying after every
    style (re)load since setStyle clears fog. Driven from inside the Map context. */
function GlobeAtmosphere({ globe, dark }: { globe: boolean; dark: boolean }) {
  const { map, isLoaded } = useMap();
  useEffect(() => {
    if (!map) return;
    const apply = () => {
      try {
        map.setProjection({ type: globe ? "globe" : "mercator" });
        map.setRenderWorldCopies(!globe);
        if (globe) {
          // Atmosphere behind the globe — neutral deep-space in dark (no blue
          // cast), soft light haze in light so the bright map stays readable.
          map.setSky(
            dark
              ? ({
                  "sky-color": "#0a0a0a",
                  "sky-horizon-blend": 0.5,
                  "horizon-color": "#3a3a3a",
                  "horizon-fog-blend": 0.6,
                  "fog-color": "#0a0a0a",
                  "fog-ground-blend": 0.1,
                  "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 0.7, 7, 0],
                } as Record<string, unknown>)
              : ({
                  "sky-color": "#dfe3e8",
                  "sky-horizon-blend": 0.6,
                  "horizon-color": "#b8bfc7",
                  "horizon-fog-blend": 0.7,
                  "fog-color": "#eceef1",
                  "fog-ground-blend": 0.1,
                  "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 0.7, 7, 0],
                } as Record<string, unknown>)
          );
        } else {
          map.setSky(undefined as unknown as Record<string, unknown>);
        }
      } catch { /* not ready */ }
    };
    apply();
    map.on("styledata", apply);
    return () => { map.off("styledata", apply); };
  }, [map, isLoaded, globe, dark]);
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
      className={`radar-tool flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-semibold ${
        active
          ? "bg-amber-500 text-white shadow shadow-amber-500/30"
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

export function LiveRadarView({ trackedAWBs, selectedAWB, onSelect, onClose, darkMode, onToggleTheme, onAddAWB, onRemoveAWB }: LiveRadarViewProps) {
  const mapRef = useRef<MapRef | null>(null);

  // Sidebar collapse (so the map can own the whole screen on a TV).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);


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

  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Which aircraft is focused on the map (drives the path overlay).
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // Airport coordinates (lazy-loaded) for route lines + at-airport pins.
  const [airports, setAirports] = useState<Record<string, [number, number]>>({});

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
  } = useLiveFlights(trackedAWBs);

  // Journey state per tracked shipment (the SHARED list — same as the normal view).
  const journeys = useMemo(() => {
    const out: { awb: string; journey: JourneyState }[] = [];
    for (const t of trackedAWBs) {
      if (!t.data) continue;
      out.push({ awb: t.awb, journey: analyzeJourney(t.data) });
    }
    return out;
  }, [trackedAWBs]);

  // Shipments currently sitting at an intermediate airport (waiting for a leg).
  const waiting = useMemo(
    () => journeys.filter((j) => j.journey.phase === "at_airport" && j.journey.at),
    [journeys]
  );

  // Shipments accepted at origin but not departed yet → awaiting their flight.
  const awaiting = useMemo(
    () => journeys.filter((j) => j.journey.phase === "awaiting_departure" && j.journey.at),
    [journeys]
  );

  // Delivered / ready at destination → completed (green pin at destination).
  const delivered = useMemo(
    () => journeys.filter((j) => j.journey.phase === "delivered" && j.journey.at),
    [journeys]
  );

  // Group all airport-pinned cargo (waiting + awaiting + delivered) by airport,
  // so a hub like PTY shows ONE pin with a count instead of N overlapping markers.
  const airportGroups = useMemo<AirportGroup[]>(() => {
    // NOTE: `Map` is shadowed by the mapcn import above, so use a plain object.
    const groups: Record<string, AirportGroup> = {};
    for (const j of [...waiting, ...awaiting, ...delivered]) {
      const code = j.journey.at as string;
      if (!groups[code]) groups[code] = { code, items: [] };
      groups[code].items.push(j);
    }
    return Object.values(groups);
  }, [waiting, awaiting, delivered]);

  // Origin airports of shipments that have already LEFT origin (in flight,
  // at a later stop, or delivered) — a small dot marks where each one started.
  // Skipped when the origin is also the current pin (awaiting) to avoid dupes.
  const originDots = useMemo(() => {
    const pinnedHere = new Set([...waiting, ...awaiting, ...delivered].map((j) => j.journey.at));
    const codes: Record<string, number> = {};
    for (const { journey } of journeys) {
      const o = journey.from || journey.legs[0]?.from;
      // Only mark the origin once it's no longer where the cargo currently sits.
      if (o && journey.phase !== "awaiting_departure" && !(pinnedHere.has(o) && journey.at === o)) {
        codes[o] = (codes[o] || 0) + 1;
      }
    }
    return Object.entries(codes).map(([code, count]) => ({ code, count }));
  }, [journeys, waiting, awaiting, delivered]);

  // Shipments that ARE in flight per the tracker but have NO live position
  // (FR24/airplanes.live didn't locate them) — we'll estimate their spot.
  const noSignal = useMemo(() => {
    const live = new Set(flights.map((f) => f.awb).filter(Boolean));
    return journeys.filter(
      (j) => j.journey.phase === "in_flight" && !live.has(j.awb)
        && j.journey.from && j.journey.to
    );
  }, [journeys, flights]);

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

  // Add a normalized AWB to the SHARED list (same as the normal view) via
  // onAddAWB → shows in both views + persists. onAddAWB performs the (FREE)
  // scrape and returns the data, so we validate on THAT result instead of
  // scraping a second time. If the shipment isn't usable, we roll the add back
  // with onRemoveAWB. FR24 is only hit later, and only for shipments in flight.
  const addAwbByCode = useCallback(async (awb: string) => {
    setAdding(true);
    setAddError(null);
    try {
      const data = await onAddAWB(awb);
      if (!data?.events?.length) {
        setAddError("No tracking events for this AWB yet");
        onRemoveAWB(awb);
        return;
      }
      const j = analyzeJourney(data);
      if (j.phase === "at_airport" && j.nextFlight) {
        // Valid shipment, just waiting at a stop — keep it; show an info note.
        setAddError(`At ${j.at}, waiting for ${j.nextFlight} → ${j.nextTo}`);
      } else if (!pairFromShipment(awb, data)) {
        setAddError("No flight number on this AWB yet");
        onRemoveAWB(awb);
        return;
      }
      setQuery("");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Tracking error");
    } finally {
      setAdding(false);
    }
  }, [onAddAWB, onRemoveAWB]);

  const handleAdd = useCallback(() => {
    const m = AWB_RE.exec(query.trim().toUpperCase());
    if (!m) { setAddError("Format: XXX-XXXXXXXX"); return; }
    addAwbByCode(`${m[1]}-${m[2]}`);
  }, [query, addAwbByCode]);

  const removeActive = (awb: string) => onRemoveAWB(awb);

  // Real flown track (FR24) of the focused aircraft, keyed by fr24_id.
  const [realTracks, setRealTracks] = useState<Record<string, [number, number][]>>({});

  const flyTo = (f: LiveFlight) => {
    setFocusKey(flightKey(f));
    if (f.awb) onSelect(f.awb);
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

  // Deselect the focused flight and frame the whole network (Panama-anchored).
  // This is the "back to overview" action — what to press after clicking a plane.
  const showAll = () => {
    setFocusKey(null);
    setCinema(false);
    stopPlayback();
    const bounds = boundsForFlights(flights);
    if (mapRef.current && bounds) {
      mapRef.current.fitBounds(bounds, { padding: 110, minZoom: 1.8, maxZoom: 6,
        duration: 1000, pitch: 0, bearing: 0 });
    } else {
      mapRef.current?.easeTo({ center: PANAMA, zoom: globe ? 2.6 : 2.4, pitch: 0, bearing: 0, duration: 1000 });
    }
  };
  const fitAll = showAll; // alias kept for existing calls

  // ── Flight playback ───────────────────────────────────────────────────────
  // Replay a flight's real flown track (FR24) in ~12s: a plane glides along the
  // path, the camera follows, and the trail draws in behind it. Only available
  // when a real track exists — we never fabricate a route.
  const PLAYBACK_MS = 12000;
  const [playback, setPlayback] = useState<{ key: string; track: [number, number][]; progress: number } | null>(null);
  const playRafRef = useRef<number | null>(null);

  const stopPlayback = useCallback(() => {
    if (playRafRef.current) cancelAnimationFrame(playRafRef.current);
    playRafRef.current = null;
    setPlayback(null);
  }, []);

  const playTrack = useCallback((key: string, track: [number, number][]) => {
    if (track.length < 2) return;
    if (playRafRef.current) cancelAnimationFrame(playRafRef.current);
    setFocusKey(key);
    setCinema(false);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / PLAYBACK_MS);
      const idx = Math.min(track.length - 1, Math.floor(t * (track.length - 1)));
      const pos = track[idx];
      setPlayback({ key, track, progress: t });
      mapRef.current?.easeTo({
        center: pos, zoom: Math.max(mapRef.current.getZoom(), 4.5),
        pitch: globe ? 50 : 0, duration: 120, essential: true,
      });
      if (t < 1) playRafRef.current = requestAnimationFrame(tick);
      else playRafRef.current = null;
    };
    playRafRef.current = requestAnimationFrame(tick);
  }, [globe]);

  // Resolve a flight's track (cached realTracks → live trail → FR24 on demand),
  // then play it. Does nothing if no real track is available.
  const playFlight = useCallback(async (f: LiveFlight) => {
    let track: [number, number][] | undefined =
      (f.fr24_id && realTracks[f.fr24_id]) ||
      (f.trail && f.trail.length >= 2 ? (f.trail as [number, number][]) : undefined);
    if (!track && f.fr24_id) {
      track = await getFlightTrack(f.fr24_id);
      if (track && track.length >= 2) {
        setRealTracks((prev) => ({ ...prev, [f.fr24_id!]: track! }));
      }
    }
    if (track && track.length >= 2) playTrack(flightKey(f), unwrapLng(track));
  }, [realTracks, playTrack]);

  useEffect(() => () => { if (playRafRef.current) cancelAnimationFrame(playRafRef.current); }, []);

  // Live data read by the cinema loop via a ref, so the effect does NOT depend on
  // flights/waiting/awaiting (which change every poll) — otherwise cinema would
  // tear down and restart on every refresh, feeling broken.
  const cinemaDataRef = useRef({ flights, waiting, awaiting, airports });
  cinemaDataRef.current = { flights, waiting, awaiting, airports };

  // Cinema = a hands-off AUTO-TOUR (presentation mode for the TV): it cycles
  // through every shipment (live flights + airport pins) and ends each lap on a
  // Panama beauty shot. It ignores any selection — to study one flight, turn
  // Cinema off and click it. Stable deps so polling never restarts the tour.
  useEffect(() => {
    if (!cinema || !mapRef.current) return;
    cinemaIdxRef.current = 0;
    const step = () => {
      const mm = mapRef.current;
      if (!mm) return;
      const { flights: fl, waiting: wt, awaiting: aw, airports: ap } = cinemaDataRef.current;
      const stops: [number, number][] = [
        ...fl.map((f) => [f.displayLng, f.displayLat] as [number, number]),
        ...[...wt, ...aw]
          .map((j) => (j.journey.at ? ap[j.journey.at] : undefined))
          .filter((c): c is [number, number] => !!c)
          .map((c) => [c[1], c[0]] as [number, number]),
      ];
      if (stops.length === 0) return;
      const i = cinemaIdxRef.current % (stops.length + 1);
      cinemaIdxRef.current = i + 1;
      if (i === stops.length) {
        const b = boundsForFlights(fl) ?? new LngLatBounds();
        b.extend(PANAMA);
        stops.forEach((s) => b.extend(s));
        mm.fitBounds(b, { padding: 120, minZoom: 1.8, maxZoom: 5, duration: 2500, pitch: globe ? 35 : 0 });
      } else {
        mm.flyTo({ center: stops[i], zoom: 4.5, pitch: globe ? 45 : 0, duration: 2500, essential: true });
      }
    };
    step();
    const id = window.setInterval(step, 7000);
    return () => clearInterval(id);
  }, [cinema, globe]);

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
        <GlobeAtmosphere globe={globe} dark={darkMode} />
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
        {journeys.map(({ awb, journey }) => {
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

        {/* Cargo at airports, GROUPED by airport so a hub (PTY) shows one pin
            with a count instead of N overlapping markers. Click = zoom + select. */}
        {airportGroups.map((g) => {
          const coord = airports[g.code];
          if (!coord) return null;
          const n = g.items.length;
          // Pin color by group makeup: all-delivered = green (done), any waiting
          // for a connection = amber, else (only awaiting-departure) = neutral.
          const allDelivered = g.items.every((it) => it.journey.phase === "delivered");
          const anyWaiting = g.items.some((it) => it.journey.phase === "at_airport");
          const variant: "waiting" | "awaiting" | "delivered" =
            allDelivered ? "delivered" : anyWaiting ? "waiting" : "awaiting";
          const first = g.items[0];
          return (
            <MapMarker
              key={`grp-${g.code}`}
              longitude={coord[1]}
              latitude={coord[0]}
              onClick={() => {
                if (n === 1) { setFocusKey(first.awb); onSelect(first.awb); }
                mapRef.current?.flyTo({ center: [coord[1], coord[0]], zoom: 5, duration: 900 });
              }}
            >
              <MarkerContent>
                <AirportPin code={g.code} count={n} variant={variant} />
              </MarkerContent>
              <MarkerTooltip>
                <div className="text-xs">
                  <div className="font-semibold">{g.code} · {n} shipment{n > 1 ? "s" : ""}</div>
                  {g.items.slice(0, 6).map((it) => (
                    <div key={it.awb} className="font-mono text-[10px] text-[var(--muted-foreground)]">{it.awb}</div>
                  ))}
                  {n > 6 && <div className="text-[10px]">+{n - 6} more</div>}
                </div>
              </MarkerTooltip>
            </MapMarker>
          );
        })}

        {/* Origin dots: a small marker at each departure airport that has shipments
            already en route / arrived, so you can see where cargo started from. */}
        {originDots.map(({ code, count }) => {
          const coord = airports[code];
          if (!coord) return null;
          return (
            <MapMarker key={`orig-${code}`} longitude={coord[1]} latitude={coord[0]}>
              <MarkerContent><OriginDot code={code} /></MarkerContent>
              <MarkerTooltip>
                <div className="text-xs font-semibold">{code} · origin ({count})</div>
              </MarkerTooltip>
            </MapMarker>
          );
        })}

        {/* In flight per the tracker but no live ADS-B signal → estimated spot
            on the great-circle from origin to destination (best-effort guess) */}
        {noSignal.map(({ awb, journey }) => {
          const o = journey.from ? airports[journey.from] : undefined;
          const d = journey.to ? airports[journey.to] : undefined;
          if (!o || !d) return null;
          // Halfway along the route as a rough estimate.
          const arc = greatCircle([o[1], o[0]], [d[1], d[0]]);
          const mid = arc[Math.floor(arc.length / 2)];
          return (
            <MapMarker
              key={`nosig-${awb}`}
              longitude={mid[0]}
              latitude={mid[1]}
              onClick={() => { setFocusKey(awb); onSelect(awb); }}
            >
              <MarkerContent>
                <EstimatedPin />
              </MarkerContent>
              <MarkerTooltip>
                <div className="text-xs">
                  <div className="font-semibold">{journey.currentFlight} · est. position</div>
                  <div className="text-[10px]">{journey.from} → {journey.to} · no live ADS-B signal</div>
                  <div className="font-mono text-[10px]">{awb}</div>
                </div>
              </MarkerTooltip>
            </MapMarker>
          );
        })}

        {/* Faint flown-track line for EVERY flight, so the whole network of
            routes is visible at a glance (the focused one is drawn brighter below). */}
        {flights.map((f) => {
          if (!f.trail || f.trail.length < 2) return null;
          if (flightKey(f) === focusKey) return null; // focused one drawn brighter below
          return (
            <MapRoute
              key={`trail-${flightKey(f)}`}
              coordinates={unwrapLng(f.trail)}
              color="#e5e5e5"
              width={2}
              opacity={0.4}
              interactive={false}
            />
          );
        })}

        {/* PLAYBACK overlay: the track draws in progressively + an animated plane
            rides the leading edge, camera follows. Replaces the static trail while
            a replay is running. */}
        {playback && playback.track.length >= 2 && (() => {
          const n = playback.track.length;
          const upto = Math.max(2, Math.floor(playback.progress * (n - 1)) + 1);
          const drawn = playback.track.slice(0, upto);
          const head = drawn[drawn.length - 1];
          const prev = drawn[drawn.length - 2] ?? head;
          const heading = (Math.atan2(head[0] - prev[0], head[1] - prev[1]) * 180) / Math.PI;
          return (
            <>
              <MapRoute coordinates={drawn} color="#fbbf24" width={11} opacity={0.18} interactive={false} />
              <MapRoute coordinates={drawn} color="#fbbf24" width={5} opacity={0.4} interactive={false} />
              <MapRoute coordinates={drawn} color="#fde68a" width={2} opacity={0.95} interactive={false} />
              <MapMarker longitude={head[0]} latitude={head[1]} rotation={heading} rotationAlignment="map">
                <MarkerContent><PlaneIcon selected grounded={false} dark={darkMode} /></MarkerContent>
              </MapMarker>
            </>
          );
        })()}

        {/* Real flown path of the focused aircraft. Prefer the real FR24/demo
            track, fall back to the live-accumulated breadcrumb.
            Both are unwrapped so antimeridian crossings draw the short way. */}
        {!playback && (() => {
          const focused = focusKey ? flights.find((x) => flightKey(x) === focusKey) : null;
          // Priority: the per-position trail FIRST — it arrives FRESH on every
          // poll (FR24 sends the full path each time), so it stays in sync with
          // the moving plane. The on-click realTracks and the live breadcrumb are
          // only fallbacks when the position trail is empty.
          const positionTrail = focused?.trail ?? [];
          const fr24Track = focused?.fr24_id ? realTracks[focused.fr24_id] : undefined;
          const path =
            positionTrail.length >= 2 ? positionTrail
            : fr24Track && fr24Track.length >= 2 ? fr24Track
            : (focusedTrail && focusedTrail.length >= 2 ? focusedTrail : null);
          if (!path) return null;
          const coords = unwrapLng(path);
          // Neon contrail: a wide soft glow underneath + a bright core on top.
          return (
            <>
              <MapRoute coordinates={coords} color="#e5e5e5" width={11} opacity={0.18} interactive={false} />
              <MapRoute coordinates={coords} color="#e5e5e5" width={5} opacity={0.35} interactive={false} />
              <MapRoute coordinates={coords} color="#fafafa" width={2} opacity={0.95} interactive={false} />
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
                <PlaneIcon selected={selected} grounded={f.on_ground} dark={darkMode} />
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
        style={{ boxShadow: darkMode ? "inset 0 0 200px 40px rgba(0,0,0,0.55)" : "inset 0 0 160px 30px rgba(0,0,0,0.12)" }} />

      {/* Bottom toolbar — clear, labeled controls for non-expert users */}
      <div className="radar-in-up radar-hud absolute bottom-5 left-1/2 -translate-x-1/2 z-[450] flex items-center gap-1 rounded-2xl px-2 py-1.5">
        <ToolButton icon={<Minus className="w-4 h-4" />} onClick={() => zoomBy(-1)} title="Zoom out" />
        <ToolButton icon={<Plus className="w-4 h-4" />} onClick={() => zoomBy(1)} title="Zoom in" />
        <ToolButton icon={<Crosshair className="w-4 h-4" />} label="Fit" onClick={showAll} title="Fit all shipments in view" />
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
          icon={<Clapperboard className="w-4 h-4" />}
          label="Cinema"
          active={cinema}
          onClick={() => setCinema((c) => !c)}
          title="Cinema: auto-tour all shipments (presentation mode)"
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
      <div className="radar-in-left radar-hud absolute left-4 top-4 bottom-4 z-[400] w-80 max-w-[calc(100%-2rem)] flex flex-col rounded-2xl overflow-hidden">
        {/* Header */}
        <div className="shrink-0 px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="relative w-9 h-9 rounded-xl bg-gradient-to-br from-zinc-700 to-zinc-900 flex items-center justify-center overflow-hidden shadow-lg shadow-amber-500/30">
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
                  <span className="text-amber-400 font-semibold">{matched}</span> live · {pairs.length} tracked
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
                className="px-3 py-1.5 text-[11px] font-semibold rounded-md bg-amber-500 text-white hover:bg-amber-400 disabled:opacity-50 transition-colors"
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

        {/* Focused shipment detail. Works for BOTH live flights (FR24 position)
            AND shipments shown only as airport pins — for the latter we build a
            light LiveFlight from the tracked data so the panel (route, jump-to-
            origin, replay) still shows. */}
        {(() => {
          if (!focusKey) return null;
          // 1) A live flight with a real position.
          let focused: LiveFlight | undefined = flights.find((x) => flightKey(x) === focusKey);
          // 2) Otherwise an airport-pinned shipment (focusKey === awb).
          if (!focused) {
            const t = trackedAWBs.find((x) => x.awb === focusKey);
            const j = t?.data ? analyzeJourney(t.data) : null;
            if (t && j) {
              const pair = pairFromShipment(t.awb, t.data);
              const here = j.at ? airports[j.at] : undefined;
              focused = {
                callsign: pair?.flight ?? t.awb,
                flight: pair?.flight ?? null,
                awb: t.awb,
                fr24_id: null, hex: null, registration: null,
                aircraft_type: null, aircraft_desc: null,
                lat: here ? here[0] : 0, lng: here ? here[1] : 0,
                displayLat: here ? here[0] : 0, displayLng: here ? here[1] : 0,
                track: null, ground_speed: null, altitude: null, vertical_rate: null,
                on_ground: true, seen_pos: null,
                origin: j.from ?? t.data?.origin ?? null,
                destination: j.to ?? t.data?.destination ?? null,
                distance_remaining_nm: null, distance_flown_pct: null,
                eta_minutes: null, flight_minutes: null, trail: [],
              };
            }
          }
          return focused ? (
            <FlightDetail
              f={focused}
              onClose={showAll}
              onPlay={() => playFlight(focused!)}
              playing={!!playback && playback.key === flightKey(focused!)}
              onGoTo={(code) => {
                const c = airports[code];
                if (c) mapRef.current?.flyTo({ center: [c[1], c[0]], zoom: 5, duration: 1200, essential: true });
              }}
            />
          ) : null;
        })()}

        {/* Flight list */}
        <div className="flex-1 overflow-y-auto">
          {pairs.length === 0 && waiting.length === 0 ? (
            <div className="p-6 text-center">
              <Plane className="w-8 h-8 mx-auto text-[var(--muted-foreground)] opacity-40" />
              <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                No flights yet.
              </p>
              <p className="mt-1 text-[10px] text-[var(--muted-foreground)]/70">
                Add an AWB above, or tracked shipments in transit show up here automatically.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {/* Cargo waiting at an intermediate airport */}
              {waiting.map(({ awb, journey }) => {
                const isActive = true; // all radar AWBs live in the shared tracked list
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
                const isActive = true; // all radar AWBs live in the shared tracked list
                return (
                  <li key={p.awb} className="group relative">
                    <button
                      onClick={() => {
                        if (f) { flyTo(f); return; }
                        // No live position → focus it anyway (opens the detail
                        // panel) and fly to where it currently sits, if known.
                        setFocusKey(p.awb);
                        onSelect(p.awb);
                        const jr = journeys.find((x) => x.awb === p.awb)?.journey;
                        const c = jr?.at ? airports[jr.at] : null;
                        if (c) mapRef.current?.flyTo({ center: [c[1], c[0]], zoom: 5, duration: 1000 });
                      }}
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
                    <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      {f && (!!f.fr24_id || (f.trail?.length ?? 0) >= 2) && (
                        <button
                          onClick={(e) => { e.stopPropagation(); playFlight(f); }}
                          title="Replay this flight's route"
                          className="p-1 rounded text-[var(--muted-foreground)] hover:text-amber-500"
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {isActive && (
                        <button
                          onClick={(e) => { e.stopPropagation(); removeActive(p.awb); }}
                          title="Remove from radar"
                          className="p-1 rounded text-[var(--muted-foreground)] hover:text-red-500"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
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
          <PanelLeftOpen className="w-5 h-5 text-amber-400" />
          Flights
        </button>
      )}
    </div>
  );
}

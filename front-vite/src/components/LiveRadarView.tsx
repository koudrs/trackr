import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { LngLatBounds } from "maplibre-gl";
import { Map, MapMarker, MarkerContent, MarkerTooltip, MapControls, MapRoute, useMap } from "./ui/map";
import type { MapRef } from "./ui/map";
import { Radio, Plane, RefreshCw, Crosshair, Gauge, ArrowUp, X, Search, Sparkles, Trash2, Clock, Navigation } from "lucide-react";
import type { TrackedAWB } from "../hooks/useTrackedAWBs";
import { useLiveFlights, pairFromShipment, flightKey, type LiveFlight, type FlightPair } from "../hooks/useLiveFlights";
import { trackAWB, getAirports, type TrackingResult } from "../lib/api";
import { analyzeJourney, type JourneyState } from "../lib/journey";

/**
 * Build a bounding box that handles flights straddling the antimeridian
 * (e.g. China->Panama crosses 180deg). A naive min/max over longitudes would
 * span ~the whole globe; instead we unwrap each longitude relative to a running
 * reference so adjacent points never differ by more than 180deg.
 */
function boundsForFlights(flights: LiveFlight[]): LngLatBounds | null {
  if (flights.length === 0) return null;
  const bounds = new LngLatBounds();
  let refLng = flights[0].displayLng;
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
  return pts;
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

/** Detail panel for the focused aircraft: combines cargo + live flight data. */
function FlightDetail({ f }: { f: LiveFlight }) {
  return (
    <div className="px-4 py-3 bg-[var(--muted)]/50 border-b border-[var(--border)]">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-[var(--foreground)]">{f.flight || f.callsign}</span>
        {f.origin && f.destination && (
          <span className="text-xs font-medium text-[var(--foreground)]">{f.origin} → {f.destination}</span>
        )}
      </div>
      {f.aircraft_desc && (
        <div className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">
          {f.aircraft_desc}{f.registration ? ` · ${f.registration}` : ""}
        </div>
      )}

      {/* progress bar */}
      {f.distance_flown_pct != null && (
        <div className="mt-2">
          <div className="h-1.5 rounded-full bg-[var(--border)] overflow-hidden">
            <div className="h-full bg-blue-500" style={{ width: `${f.distance_flown_pct}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-[9px] text-[var(--muted-foreground)]">
            <span>{Math.round(f.distance_flown_pct)}% flown</span>
            {f.distance_remaining_nm != null && <span>{Math.round(f.distance_remaining_nm).toLocaleString()} nm left</span>}
          </div>
        </div>
      )}

      {/* live stats grid */}
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        <div className="flex items-center gap-1 text-[var(--muted-foreground)]">
          <ArrowUp className="w-3 h-3" />
          {f.altitude != null ? `${Math.round(f.altitude).toLocaleString()} ft` : "—"}
          {vrLabel(f.vertical_rate) && <span className="opacity-70">· {vrLabel(f.vertical_rate)}</span>}
        </div>
        <div className="flex items-center gap-1 text-[var(--muted-foreground)]">
          <Gauge className="w-3 h-3" />
          {f.ground_speed != null ? `${Math.round(f.ground_speed)} kt` : "—"}
        </div>
        <div className="flex items-center gap-1 text-[var(--muted-foreground)]">
          <Clock className="w-3 h-3" />
          {f.flight_minutes != null ? `${fmtMin(f.flight_minutes)} aloft` : "—"}
        </div>
        <div className="flex items-center gap-1 text-[var(--muted-foreground)]">
          <Navigation className="w-3 h-3" />
          {f.eta_minutes != null ? `ETA ~${fmtMin(f.eta_minutes)}` : "—"}
        </div>
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
  const fill = grounded ? "#94a3b8" : selected ? "#f59e0b" : "#2563eb";
  return (
    <svg
      width="30"
      height="30"
      viewBox="0 0 39.769 39.769"
      className={`drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)] ${grounded ? "opacity-70" : ""}`}
      fill={fill}
      stroke="#ffffff"
      strokeWidth="1.5"
    >
      <path d="M36.384 23.28v1.896c0 .46-.211.896-.571 1.181a1.5 1.5 0 0 1-1.282.278l-11.886-2.858v11.457l3.271 2.309a1 1 0 0 1 .424.816v.41c0 .291-.127.565-.346.758a1 1 0 0 1-.798.231l-5.314-.766-5.317.765a1 1 0 0 1-1.142-.989v-.409c0-.326.157-.632.423-.817l3.271-2.31V23.774L5.233 26.632a1.51 1.51 0 0 1-1.279-.277 1.51 1.51 0 0 1-.57-1.181v-1.896c0-.545.296-1.047.771-1.312l12.963-7.207V2.767A2.77 2.77 0 0 1 19.885 0a2.77 2.77 0 0 1 2.767 2.767V14.76l12.964 7.207c.471.266.768.768.768 1.313" />
    </svg>
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

/** Auto-fit the map to all flights once they first load. */
function FitToFlights({ flights }: { flights: LiveFlight[] }) {
  const { map, isLoaded } = useMap();
  const didFit = useRef(false);

  useEffect(() => {
    if (!map || !isLoaded || flights.length === 0 || didFit.current) return;
    const bounds = boundsForFlights(flights);
    if (bounds) map.fitBounds(bounds, { padding: 100, maxZoom: 6, duration: 1000 });
    didFit.current = true;
  }, [map, isLoaded, flights]);

  return null;
}

export function LiveRadarView({ trackedAWBs, selectedAWB, onSelect, onClose }: LiveRadarViewProps) {
  const mapRef = useRef<MapRef | null>(null);

  // Demo mode: show real airborne traffic so the radar can be seen working.
  const [demo, setDemo] = useState(false);

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

  // In-air pairs for the radar's own added shipments (those currently flying).
  const activePairs = useMemo<FlightPair[]>(
    () =>
      activeShipments
        .map((s) => pairFromShipment(s.awb, s.data))
        .filter((p): p is FlightPair => !!p && analyzeJourney(
          activeShipments.find((s) => s.awb === p.awb)!.data
        ).phase === "in_flight"),
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
      // Helpful status note so the user understands what they'll see.
      if (j.phase === "at_airport" && j.nextFlight) {
        setAddError(`At ${j.at}, waiting for ${j.nextFlight} → ${j.nextTo}`);
      } else if (j.phase === "delivered") {
        setAddError(`Already delivered/at destination (${j.at})`);
      } else if (j.phase !== "in_flight" && !pairFromShipment(awb, data)) {
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

  const flyTo = (f: LiveFlight) => {
    setFocusKey(flightKey(f));
    if (f.awb && !f.awb.startsWith("DEMO:")) onSelect(f.awb);
    mapRef.current?.flyTo({ center: [f.displayLng, f.displayLat], zoom: 6, duration: 1000 });
  };

  const fitAll = () => {
    const bounds = boundsForFlights(flights);
    if (mapRef.current && bounds) {
      mapRef.current.fitBounds(bounds, { padding: 100, maxZoom: 6, duration: 800 });
    }
  };

  // Breadcrumb trail of the focused aircraft (path it has flown since opened).
  const focusedTrail = focusKey ? trails[focusKey] : undefined;

  return (
    <div className="fixed inset-0 z-[1000]">
      {/* Full-bleed map */}
      <Map
        ref={mapRef}
        className="absolute inset-0"
        viewport={{ center: [0, 20], zoom: 1.5 }}
      >
        <MapControls position="bottom-right" />
        <FitToFlights flights={flights} />

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
          return (
            <MapRoute
              key={`route-${awb}`}
              coordinates={line}
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

        {/* Flown path of the focused aircraft (live breadcrumb) */}
        {focusedTrail && focusedTrail.length >= 2 && (
          <MapRoute coordinates={focusedTrail} color="#2563eb" width={3} opacity={0.85} />
        )}

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

      {/* Floating sidebar */}
      <div className="absolute left-4 top-4 bottom-4 z-[400] w-72 max-w-[calc(100%-2rem)] flex flex-col rounded-xl border border-[var(--border)] bg-[var(--card)]/95 backdrop-blur shadow-xl overflow-hidden">
        {/* Header */}
        <div className="shrink-0 px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center">
                <Radio className="w-4 h-4 text-white" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-[var(--foreground)]">Live Radar</h2>
                <p className="text-[10px] text-[var(--muted-foreground)]">
                  {matched}/{demo ? matched : pairs.length} flights{demo ? " (demo)" : " tracked"}
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
                className="px-2.5 py-1.5 text-[11px] font-medium rounded-md bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {adding ? "…" : "Add"}
              </button>
            </div>
            {addError && <p className="mt-1 text-[10px] text-red-500">{addError}</p>}
          </div>

          {/* Live toggle + interval + demo */}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              onClick={() => setLive(!live)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors ${
                live
                  ? "bg-green-500/10 border-green-500/40 text-green-600 dark:text-green-400"
                  : "bg-[var(--muted)] border-[var(--border)] text-[var(--muted-foreground)]"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${live ? "bg-green-500 animate-pulse" : "bg-[var(--muted-foreground)]"}`} />
              {live ? "LIVE" : "PAUSED"}
            </button>
            <select
              value={intervalMs}
              onChange={(e) => setIntervalMs(Number(e.target.value))}
              disabled={!live}
              className="text-[11px] px-2 py-1 rounded-md bg-[var(--muted)] border border-[var(--border)] text-[var(--foreground)] disabled:opacity-50"
              title="Polling interval"
            >
              {POLL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  every {o.label}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => setDemo((d) => !d)}
            className={`mt-2 w-full flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-colors ${
              demo
                ? "bg-indigo-500/10 border-indigo-500/40 text-indigo-600 dark:text-indigo-400"
                : "bg-[var(--muted)] border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            }`}
            title="Show real airborne traffic (temporary demo)"
          >
            <Sparkles className="w-3 h-3" />
            {demo ? "Demo ON — showing live traffic" : "Demo mode"}
          </button>
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
    </div>
  );
}

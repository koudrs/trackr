import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { getFlights, type FlightPosition } from "../lib/api";
import type { TrackedAWB } from "./useTrackedAWBs";

// Statuses worth sending to FR24 for a real flown track. FR24 has the historical
// trajectory, so we include recently-flown legs (arrived/received/delivered),
// not just airborne (DEP) — that's how a delivered shipment still shows its route.
const TRACKABLE_STATUSES = ["DEP", "ARR", "RCF", "NFD", "DLV"];

// Poll cadence when live is ON. Default 5 min: FR24 caches positions ~5 min and
// the frontend dead-reckons (interpolates) smoothly in between for free, so
// polling faster just burns credits without improving what you see.
const DEFAULT_INTERVAL_MS = 300_000;
const MAX_DEAD_RECKON_S = 45; // stop extrapolating if polls stall
const EARTH_RADIUS_NM = 3440.065; // for great-circle dead reckoning
const FRAME_MS = 120; // ~8fps state commits — plenty smooth for cruising planes
const TRAIL_MAX_POINTS = 200; // breadcrumb cap per aircraft

/** Stable identity for an aircraft across polls (for trails + marker keys). */
export function flightKey(f: { awb?: string | null; callsign?: string; hex?: string | null }): string {
  return f.awb || f.callsign || f.hex || "?";
}

export interface FlightPair {
  awb: string;
  flight: string;
  origin?: string | null;
  destination?: string | null;
  depTime?: string | null; // ISO timestamp of the DEP event
}

/** A flight position with the local time we received it (for interpolation). */
interface TimedFlight extends FlightPosition {
  receivedAt: number;
}

/**
 * Move a point forward along its heading (great-circle dead reckoning).
 * Keeps planes gliding between sparse polls instead of jumping every cycle.
 */
function deadReckon(f: TimedFlight, elapsedS: number): { lat: number; lng: number } {
  if (f.on_ground || f.track == null || !f.ground_speed || elapsedS <= 0) {
    return { lat: f.lat, lng: f.lng };
  }
  const e = Math.min(elapsedS, MAX_DEAD_RECKON_S);
  const distNm = f.ground_speed * (e / 3600); // knots -> nm
  const ang = distNm / EARTH_RADIUS_NM; // angular distance (rad)
  const brng = (f.track * Math.PI) / 180;
  const lat1 = (f.lat * Math.PI) / 180;
  const lng1 = (f.lng * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(brng)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(ang) * Math.cos(lat1),
      Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2)
    );

  // Normalize longitude to [-180, 180) so a plane crossing the dateline stays
  // on the single rendered world copy (the map uses renderWorldCopies: false).
  const lngDeg = (((lng2 * 180) / Math.PI + 540) % 360) - 180;
  return { lat: (lat2 * 180) / Math.PI, lng: lngDeg };
}

/** Read + JSON.parse a localStorage value, falling back on any error. */
function readStored<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s != null ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Build an enriched FlightPair from a shipment: flight number + route + DEP time. */
export function pairFromShipment(awb: string, data: TrackedAWB["data"]): FlightPair | null {
  const events = data?.events;
  if (!events?.length) return null;
  const flight = events.find((e) => e.flight)?.flight;
  if (!flight) return null;
  // The DEP event timestamp = when it took off (events are newest-first).
  const dep = events.find((e) => e.status_code === "DEP");
  return {
    awb,
    flight,
    origin: data?.origin ?? null,
    destination: data?.destination ?? null,
    depTime: dep?.timestamp ?? null,
  };
}

/** Derive trackable pairs from tracked shipments (in-transit or recently flown). */
export function deriveInAirPairs(trackedAWBs: TrackedAWB[]): FlightPair[] {
  const pairs: FlightPair[] = [];
  for (const t of trackedAWBs) {
    if (!t.data?.events?.length) continue;
    if (!TRACKABLE_STATUSES.includes(t.data.events[0].status_code)) continue;
    const p = pairFromShipment(t.awb, t.data);
    if (p) pairs.push(p);
  }
  return pairs;
}

export interface LiveFlight extends FlightPosition {
  /** Dead-reckoned position for display (falls back to the raw fix). */
  displayLat: number;
  displayLng: number;
}

interface UseLiveFlightsOptions {
  /** Extra in-air pairs the radar manages itself (its own active list). */
  extraPairs?: FlightPair[];
}

export function useLiveFlights(
  trackedAWBs: TrackedAWB[],
  options: UseLiveFlightsOptions = {}
) {
  const { extraPairs = [] } = options;
  const [live, setLive] = useState<boolean>(() => readStored<boolean>("radarLive", false) === true);
  const [intervalMs, setIntervalMs] = useState<number>(() => {
    const n = readStored<number>("radarIntervalMs", DEFAULT_INTERVAL_MS);
    return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_INTERVAL_MS;
  });

  const [displayFlights, setDisplayFlights] = useState<LiveFlight[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [matched, setMatched] = useState(0);

  // Accumulated breadcrumb trail per aircraft (key = awb||callsign||hex). The
  // free API only gives the current position, so we build the path live by
  // appending each real fix. Capped per aircraft to stay light.
  const [trails, setTrails] = useState<Record<string, [number, number][]>>({});

  // Latest fixes, stamped with arrival time, read by the animation loop.
  const fixesRef = useRef<TimedFlight[]>([]);
  const pollRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  const fetchRef = useRef<() => void>(() => {});

  const extraKey = useMemo(
    () => extraPairs.map((p) => `${p.awb}:${p.flight}`).sort().join("|"),
    [extraPairs]
  );

  // Combine tracker-derived in-air pairs with the radar's own active list.
  const pairs = useMemo(() => {
    const fromTracker = deriveInAirPairs(trackedAWBs);
    const seen = new Set(fromTracker.map((p) => p.awb));
    return [...fromTracker, ...extraPairs.filter((p) => !seen.has(p.awb))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedAWBs, extraKey]);
  const pairsKey = useMemo(
    () => pairs.map((p) => `${p.awb}:${p.flight}`).sort().join("|"),
    [pairs]
  );

  useEffect(() => {
    localStorage.setItem("radarLive", JSON.stringify(live));
  }, [live]);
  useEffect(() => {
    localStorage.setItem("radarIntervalMs", JSON.stringify(intervalMs));
  }, [intervalMs]);

  const fetchFlights = useCallback(async () => {
    if (pairs.length === 0) {
      fixesRef.current = [];
      setDisplayFlights([]);
      setMatched(0);
      setError(null); // nothing to fetch -> clear any stale error (kiosk safety)
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const res = await getFlights(pairs);
      const now = performance.now();
      fixesRef.current = res.flights.map((f) => ({ ...f, receivedAt: now }));
      setMatched(res.matched);
      setLastUpdated(new Date().toISOString());
      // Append each fresh real fix to that aircraft's breadcrumb trail.
      setTrails((prev) => {
        const next = { ...prev };
        for (const f of res.flights) {
          if (f.on_ground) continue;
          const k = flightKey(f);
          const path = next[k] ? [...next[k]] : [];
          const last = path[path.length - 1];
          // Skip near-duplicate points (no movement) and cap length.
          if (!last || Math.abs(last[0] - f.lng) > 1e-4 || Math.abs(last[1] - f.lat) > 1e-4) {
            path.push([f.lng, f.lat]);
          }
          next[k] = path.slice(-TRAIL_MAX_POINTS);
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error fetching flights");
    } finally {
      setIsLoading(false);
    }
  }, [pairs]);

  // Animation loop: glide planes forward between polls via dead reckoning.
  useEffect(() => {
    const tick = (now: number) => {
      if (now - lastFrameRef.current >= FRAME_MS) {
        lastFrameRef.current = now;
        setDisplayFlights(
          fixesRef.current.map((f) => {
            const { lat, lng } = deadReckon(f, (now - f.receivedAt) / 1000);
            return { ...f, displayLat: lat, displayLng: lng };
          })
        );
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Keep a stable handle to the latest fetcher so the polling timer doesn't
  // depend on fetchFlights' identity (which changes on every trackedAWBs poll).
  useEffect(() => {
    fetchRef.current = fetchFlights;
  }, [fetchFlights]);

  // Switch OFF = a single request on view load / when the flight set changes.
  // When live is ON the polling effect owns the initial + repeated fetches, so
  // we skip here to avoid a duplicate fetch on mount.
  useEffect(() => {
    if (!live) fetchRef.current();
  }, [pairsKey, live]);

  // Polling: only while live is ON and the tab is visible. Keyed on pairsKey
  // (content), not fetchFlights identity, so an unrelated AWB refresh doesn't
  // tear down and restart the timer.
  useEffect(() => {
    const clear = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    if (!live) {
      clear();
      return;
    }

    const start = () => {
      clear();
      fetchRef.current(); // immediate refresh on enabling / regaining focus
      pollRef.current = window.setInterval(() => fetchRef.current(), intervalMs);
    };

    const onVisibility = () => {
      if (document.hidden) clear();
      else start();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [live, intervalMs, pairsKey]);

  return {
    flights: displayFlights,
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
    refresh: fetchFlights,
  };
}

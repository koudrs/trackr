const API_BASE = import.meta.env.VITE_API_URL || "/api";

export interface TrackingEvent {
  timestamp: string | null;
  status_code: string;
  description: string;
  location: string | null;
  flight: string | null;
  pieces: number | null;
}

export interface TrackingResult {
  awb: string;
  airline: string;
  iata_code: string | null;
  origin: string | null;
  destination: string | null;
  pieces: number | null;
  weight: number | null;
  status: string | null;
  events: TrackingEvent[];
  tracked_at: string;
  source: string;
}

export interface TrackingError {
  awb: string;
  error: string;
  carrier?: string;
  suggestion?: string;
}

export async function trackAWB(awb: string): Promise<TrackingResult> {
  const res = await fetch(`${API_BASE}/track/${awb}`);

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.detail?.error || "Error tracking AWB");
  }

  return res.json();
}

// --- Live flight tracking (airplanes.live via /api/flights) ---------------

export interface FlightPosition {
  callsign: string;
  flight: string | null; // IATA flight number we matched (e.g. "CM473")
  awb: string | null; // tracked AWB this aircraft belongs to
  hex: string | null;
  registration: string | null;
  aircraft_type: string | null;
  aircraft_desc: string | null; // human-readable, e.g. "BOEING 767-300"
  lat: number;
  lng: number;
  track: number | null; // true heading in degrees, for icon rotation
  ground_speed: number | null; // knots
  altitude: number | null; // feet
  vertical_rate: number | null; // ft/min: + climb, - descent, ~0 cruise
  on_ground: boolean;
  seen_pos: number | null;
  // Route + timing (combined from the shipment tracking + live position)
  origin: string | null;
  destination: string | null;
  distance_remaining_nm: number | null;
  distance_flown_pct: number | null;
  eta_minutes: number | null;
  flight_minutes: number | null;
  // Real flown trail from OpenSky, as [[lng, lat], ...]. Empty when unavailable.
  trail: [number, number][];
}

export interface FlightPositionList {
  flights: FlightPosition[];
  source: string;
  fetched_at: string;
  requested: number;
  matched: number;
}

/**
 * Fetch live positions for a set of tracked flights.
 *
 * @param pairs list of { awb, flight } derived from in-transit shipments.
 *              flight is the IATA flight number from events[].flight.
 */
export interface FlightQuery {
  awb: string;
  flight: string;
  origin?: string | null;
  destination?: string | null;
  depTime?: string | null; // ISO timestamp of the DEP event
}

/** Fetch coordinates for IATA airport codes: { IST: [lat, lng], ... }. */
export async function getAirports(codes: string[]): Promise<Record<string, [number, number]>> {
  const uniq = [...new Set(codes.filter(Boolean))];
  if (uniq.length === 0) return {};
  const res = await fetch(`${API_BASE}/airports?codes=${encodeURIComponent(uniq.join(","))}`);
  if (!res.ok) return {};
  const data = await res.json();
  return data.airports ?? {};
}

export async function getFlights(
  pairs: FlightQuery[],
  demo = false
): Promise<FlightPositionList> {
  if (demo) {
    const res = await fetch(`${API_BASE}/flights?demo=1`);
    if (!res.ok) throw new Error("Error fetching demo flights");
    return res.json();
  }

  // Token: AWB:FLIGHT:ORIGIN:DEST:DEP_ISO (trailing fields optional). The AWB
  // has a hyphen, never a colon, so colon is a safe separator.
  const tokens = pairs
    .filter((p) => p.flight)
    .map((p) =>
      [p.awb, p.flight, p.origin ?? "", p.destination ?? "", p.depTime ?? ""].join(":")
    )
    .join(",");

  const res = await fetch(`${API_BASE}/flights?flights=${encodeURIComponent(tokens)}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.detail?.error || "Error fetching live flights");
  }

  return res.json();
}

import type { TrackingResult, TrackingEvent } from "./api";

/**
 * Derive a cargo shipment's current journey state from its tracking events.
 *
 * A cargo AWB can be multi-leg (e.g. CGO -> IST -> PTY). We work out where the
 * shipment IS right now: flying a leg, or sitting at an intermediate airport
 * waiting for the next booked leg (e.g. waiting in IST for TK0903 to PTY).
 *
 * Events are newest-first (index 0 = latest).
 */

export type JourneyPhase =
  | "awaiting_departure" // accepted at origin, not departed yet
  | "in_flight"          // departed, en route (may or may not have a live signal)
  | "at_airport"         // landed at an intermediate stop, waiting for next leg
  | "delivered"
  | "unknown";

export interface Leg {
  flight: string;
  from: string | null;
  to: string | null;
}

export interface JourneyState {
  phase: JourneyPhase;
  at: string | null; // where the cargo currently is (origin/at_airport/delivered)
  currentFlight: string | null; // active leg (in_flight) or just-completed leg
  from: string | null;
  to: string | null;
  nextFlight: string | null; // booked onward leg when waiting at a stop
  nextTo: string | null;
  legs: Leg[];
}

const ARRIVED = new Set(["ARR", "RCF"]);
const DONE = new Set(["DLV", "NFD"]);

export function analyzeJourney(data: TrackingResult | null): JourneyState {
  const empty: JourneyState = {
    phase: "unknown", at: null, currentFlight: null,
    from: null, to: null, nextFlight: null, nextTo: null, legs: [],
  };
  const events = data?.events;
  if (!events?.length) return empty;

  const origin = data!.origin ?? null;
  const destination = data!.destination ?? null;
  const latest = events[0];
  const sc = latest.status_code;

  // Reconstruct legs (oldest->newest) keyed by flight number.
  const legMap = new Map<string, Leg>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e: TrackingEvent = events[i];
    if (!e.flight) continue;
    const leg = legMap.get(e.flight) ?? { flight: e.flight, from: null, to: null };
    if (e.status_code === "DEP" && e.location && !leg.from) leg.from = e.location;
    else if (ARRIVED.has(e.status_code) && e.location) leg.to = e.location;
    else if (e.status_code === "BKD" && e.location && !leg.from) leg.from = e.location;
    legMap.set(e.flight, leg);
  }
  const legs = [...legMap.values()];

  // Origin is the shipment's first departure point — always populate `from` so
  // the radar can mark the origin and "jump to origin" works in every phase.
  const startFrom = origin ?? legs[0]?.from ?? null;

  if (DONE.has(sc)) {
    return { ...empty, phase: "delivered", at: destination ?? latest.location, from: startFrom, to: destination, legs };
  }

  if (sc === "DEP") {
    return {
      ...empty, phase: "in_flight", currentFlight: latest.flight,
      from: latest.location ?? origin, to: destination, legs,
    };
  }

  if (ARRIVED.has(sc)) {
    const here = latest.location;
    if (here && destination && here !== destination) {
      // Waiting at an intermediate stop for the next booked leg out of "here".
      const onward = events.find(
        (e) => e.status_code === "BKD" && e.location === here && e.flight !== latest.flight
      );
      return {
        ...empty, phase: "at_airport", at: here, currentFlight: latest.flight,
        from: startFrom, to: destination,
        nextFlight: onward?.flight ?? null, nextTo: destination, legs,
      };
    }
    return { ...empty, phase: "at_airport", at: here ?? destination, from: startFrom, to: destination, legs };
  }

  // Accepted/booked at origin but not departed yet → awaiting its flight.
  // Use the first booked leg's flight (if any) as the upcoming flight.
  const firstFlight = legs.find((l) => l.flight)?.flight ?? null;
  return {
    ...empty, phase: "awaiting_departure",
    at: origin ?? latest.location,
    from: origin ?? latest.location, to: destination,
    nextFlight: firstFlight, nextTo: destination, legs,
  };
}

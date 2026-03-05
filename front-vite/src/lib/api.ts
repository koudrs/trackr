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

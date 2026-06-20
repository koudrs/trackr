import { useState, useEffect, useCallback } from "react";
import type { TrackingResult } from "../lib/api";
import type { TrackedAWB } from "./useTrackedAWBs";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

/**
 * System guides = the AWBs from Seal Cargo, tracked server-side (free scraping,
 * NO FR24) and served ready. We expose them as TrackedAWB[] so the normal-view
 * list and the radar can consume them exactly like manually-tracked shipments.
 */
export function useGuias() {
  const [guias, setGuias] = useState<TrackedAWB[]>([]);
  const [isLoading, setIsLoading] = useState(true); // Start true so UI shows loading
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/guias-tracked`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        return;
      }
      const list: TrackingResult[] = Array.isArray(data.guias) ? data.guias : [];
      setGuias(
        list.map((d) => ({
          awb: d.awb,
          data: d,
          lastUpdated: new Date().toISOString(),
          isLoading: false,
          error: null,
          isSystem: true,
        }))
      );
      setLastUpdated(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load shipments");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load once on mount only. NO automatic polling — re-scraping costs ScraperAPI
  // credits, so refreshes are manual (button) and the backend keeps a smart
  // per-status cache (stable shipments cached for hours).
  useEffect(() => {
    load();
  }, [load]);

  return { guias, isLoading, error, lastUpdated, refresh: load };
}

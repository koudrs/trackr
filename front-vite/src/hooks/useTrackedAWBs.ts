import { useState, useEffect, useCallback, useRef } from "react";
import { trackAWB, type TrackingResult } from "../lib/api";

const STORAGE_KEY = "tracked_awbs";
const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutos

export interface TrackedAWB {
  awb: string;
  data: TrackingResult | null;
  lastUpdated: string;
  isLoading: boolean;
  error: string | null;
  // Connection/transshipment tracking
  connectionAWB?: string; // AWB of connecting flight (e.g., 810-XXXXX for MIA→PTY)
  parentAWB?: string; // If this is a connection, reference to parent AWB
}

export function useTrackedAWBs() {
  const [trackedAWBs, setTrackedAWBs] = useState<TrackedAWB[]>([]);
  const intervalRef = useRef<number | null>(null);

  // Load from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as TrackedAWB[];
        setTrackedAWBs(parsed.map(t => ({ ...t, isLoading: false })));
      } catch {
        // ignore
      }
    }
  }, []);

  // Save to localStorage when trackedAWBs changes
  useEffect(() => {
    if (trackedAWBs.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trackedAWBs));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [trackedAWBs]);

  const refreshAWB = useCallback(async (awb: string) => {
    setTrackedAWBs(prev =>
      prev.map(t => t.awb === awb ? { ...t, isLoading: true, error: null } : t)
    );

    try {
      const data = await trackAWB(awb);
      setTrackedAWBs(prev =>
        prev.map(t =>
          t.awb === awb
            ? { ...t, data, lastUpdated: new Date().toISOString(), isLoading: false, error: null }
            : t
        )
      );
      return data;
    } catch (err) {
      const error = err instanceof Error ? err.message : "Error";
      setTrackedAWBs(prev =>
        prev.map(t => t.awb === awb ? { ...t, isLoading: false, error } : t)
      );
      return null;
    }
  }, []);

  const addAWB = useCallback(async (awb: string): Promise<TrackingResult | null> => {
    // Check if already tracked
    const existing = trackedAWBs.find(t => t.awb === awb);
    if (existing) {
      return refreshAWB(awb);
    }

    // Add new
    const newTracked: TrackedAWB = {
      awb,
      data: null,
      lastUpdated: new Date().toISOString(),
      isLoading: true,
      error: null,
    };

    setTrackedAWBs(prev => [newTracked, ...prev]);

    try {
      const data = await trackAWB(awb);
      setTrackedAWBs(prev =>
        prev.map(t =>
          t.awb === awb
            ? { ...t, data, lastUpdated: new Date().toISOString(), isLoading: false }
            : t
        )
      );
      return data;
    } catch (err) {
      const error = err instanceof Error ? err.message : "Error";
      setTrackedAWBs(prev =>
        prev.map(t => t.awb === awb ? { ...t, isLoading: false, error } : t)
      );
      throw err;
    }
  }, [trackedAWBs, refreshAWB]);

  const removeAWB = useCallback((awb: string) => {
    setTrackedAWBs(prev => {
      // Also remove any connections and update parent references
      return prev
        .filter(t => t.awb !== awb && t.parentAWB !== awb)
        .map(t => t.connectionAWB === awb ? { ...t, connectionAWB: undefined } : t);
    });
  }, []);

  // Add a connection AWB to an existing tracked AWB
  const addConnection = useCallback(async (parentAWB: string, connectionAWB: string): Promise<TrackingResult | null> => {
    // Check if connection already exists
    const existingConnection = trackedAWBs.find(t => t.awb === connectionAWB);
    if (existingConnection) {
      // Just link them
      setTrackedAWBs(prev => prev.map(t => {
        if (t.awb === parentAWB) return { ...t, connectionAWB };
        if (t.awb === connectionAWB) return { ...t, parentAWB };
        return t;
      }));
      return existingConnection.data;
    }

    // Add new connection AWB
    const newTracked: TrackedAWB = {
      awb: connectionAWB,
      data: null,
      lastUpdated: new Date().toISOString(),
      isLoading: true,
      error: null,
      parentAWB,
    };

    setTrackedAWBs(prev => [
      ...prev.map(t => t.awb === parentAWB ? { ...t, connectionAWB } : t),
      newTracked,
    ]);

    try {
      const data = await trackAWB(connectionAWB);
      setTrackedAWBs(prev =>
        prev.map(t =>
          t.awb === connectionAWB
            ? { ...t, data, lastUpdated: new Date().toISOString(), isLoading: false }
            : t
        )
      );
      return data;
    } catch (err) {
      const error = err instanceof Error ? err.message : "Error";
      setTrackedAWBs(prev =>
        prev.map(t => t.awb === connectionAWB ? { ...t, isLoading: false, error } : t)
      );
      throw err;
    }
  }, [trackedAWBs]);

  // Remove connection link (but keep the AWB tracked)
  const unlinkConnection = useCallback((parentAWB: string) => {
    setTrackedAWBs(prev => prev.map(t => {
      if (t.awb === parentAWB) return { ...t, connectionAWB: undefined };
      if (t.parentAWB === parentAWB) return { ...t, parentAWB: undefined };
      return t;
    }));
  }, []);

  const clearAll = useCallback(() => {
    setTrackedAWBs([]);
  }, []);

  // Auto-refresh all AWBs
  const refreshAll = useCallback(async () => {
    for (const tracked of trackedAWBs) {
      if (!tracked.isLoading) {
        await refreshAWB(tracked.awb);
      }
    }
  }, [trackedAWBs, refreshAWB]);

  // Setup auto-refresh interval
  useEffect(() => {
    if (trackedAWBs.length > 0) {
      intervalRef.current = window.setInterval(() => {
        refreshAll();
      }, REFRESH_INTERVAL);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [trackedAWBs.length, refreshAll]);

  return {
    trackedAWBs,
    addAWB,
    removeAWB,
    clearAll,
    refreshAWB,
    refreshAll,
    addConnection,
    unlinkConnection,
  };
}

"use client";

import { useState } from "react";
import { TrackingForm } from "@/components/tracking-form";
import { TrackingResultCard } from "@/components/tracking-result";
import { SupportedCarriers } from "@/components/supported-carriers";
import { trackAWB, type TrackingResult } from "@/lib/api";

export default function Home() {
  const [result, setResult] = useState<TrackingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleClear = () => {
    setResult(null);
    setError(null);
  };

  const handleTrack = async (awb: string) => {
    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const data = await trackAWB(awb);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-4 md:py-6 gap-4">
      <div className="text-center">
        <h1 className="text-xl md:text-2xl font-bold">Tracking de Carga</h1>
        <p className="text-sm text-muted-foreground">Ingresa tu AWB para rastrear</p>
      </div>

      <TrackingForm onSubmit={handleTrack} onClear={handleClear} isLoading={isLoading} />

      {error && (
        <div className="bg-destructive/10 text-destructive px-3 py-1.5 rounded text-sm max-w-md text-center">
          {error}
        </div>
      )}

      {result && <TrackingResultCard data={result} />}

      {!result && !error && <SupportedCarriers />}
    </main>
  );
}

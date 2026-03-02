"use client";

import { useState, useRef } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";

interface TrackingFormProps {
  onSubmit: (awb: string, token?: string) => void;
  onClear?: () => void;
  isLoading?: boolean;
}

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

export function TrackingForm({ onSubmit, onClear, isLoading }: TrackingFormProps) {
  const [awb, setAwb] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (awb.trim()) {
      onSubmit(awb.trim(), token || undefined);
      // Reset turnstile after submit
      turnstileRef.current?.reset();
      setToken(null);
    }
  };

  const handleClear = () => {
    setAwb("");
    onClear?.();
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col items-center gap-1.5 w-full max-w-sm">
      <div className="flex gap-1.5 w-full">
        <div className="relative flex-1">
          <Input
            type="text"
            placeholder="XXX-XXXXXXXX"
            value={awb}
            onChange={(e) => setAwb(e.target.value)}
            className="font-mono pr-7 h-9 text-sm"
            disabled={isLoading}
          />
          {awb && !isLoading && (
            <button
              type="button"
              onClick={handleClear}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Button
          type="submit"
          disabled={isLoading || !awb.trim() || (!!TURNSTILE_SITE_KEY && !token)}
          size="sm"
          className="h-9 px-3"
        >
          {isLoading ? (
            <span className="animate-pulse">...</span>
          ) : (
            <Search className="h-4 w-4" />
          )}
        </Button>
      </div>

      {TURNSTILE_SITE_KEY && (
        <div className="h-0 overflow-hidden">
          <Turnstile
            ref={turnstileRef}
            siteKey={TURNSTILE_SITE_KEY}
            onSuccess={setToken}
            onExpire={() => setToken(null)}
            options={{
              size: "invisible",
            }}
          />
        </div>
      )}
    </form>
  );
}

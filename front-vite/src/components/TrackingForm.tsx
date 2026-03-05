import { useState } from "react";
import { Search, X } from "lucide-react";

interface TrackingFormProps {
  onSubmit: (awb: string) => void;
  onClear?: () => void;
  isLoading?: boolean;
}

export function TrackingForm({ onSubmit, onClear, isLoading }: TrackingFormProps) {
  const [awb, setAwb] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (awb.trim()) {
      onSubmit(awb.trim());
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
          <input
            type="text"
            placeholder="XXX-XXXXXXXX"
            value={awb}
            onChange={(e) => setAwb(e.target.value)}
            className="w-full h-9 px-3 pr-7 rounded-md border border-[var(--border)] bg-[var(--card)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-50"
            disabled={isLoading}
          />
          {awb && !isLoading && (
            <button
              type="button"
              onClick={handleClear}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <button
          type="submit"
          disabled={isLoading || !awb.trim()}
          className="h-9 px-3 rounded-md bg-[var(--primary)] text-[var(--primary-foreground)] text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
        >
          {isLoading ? (
            <span className="animate-pulse">...</span>
          ) : (
            <Search className="h-4 w-4" />
          )}
        </button>
      </div>
    </form>
  );
}

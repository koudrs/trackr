import { Loader2 } from "lucide-react";

interface LoadingCardProps {
  awb: string;
  message?: string;
}

export function LoadingCard({ awb, message = "Processing tracking..." }: LoadingCardProps) {
  return (
    <div className="w-full rounded-lg border border-[var(--border)]/60 bg-[var(--card)] shadow-sm">
      <div className="p-6">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-full bg-blue-100">
            <Loader2 className="h-6 w-6 text-blue-600 animate-spin" />
          </div>
          <div>
            <p className="font-mono text-lg font-bold">{awb}</p>
            <p className="text-sm text-[var(--muted-foreground)]">{message}</p>
          </div>
        </div>

        {/* Skeleton content */}
        <div className="mt-6 space-y-4">
          {/* Route skeleton */}
          <div className="flex items-center justify-between py-3 px-4 bg-[var(--muted)]/50 rounded-lg animate-pulse">
            <div className="flex items-center gap-3">
              <div className="h-5 w-12 bg-[var(--muted)] rounded" />
              <div className="h-4 w-4 bg-[var(--muted)] rounded" />
              <div className="h-5 w-12 bg-[var(--muted)] rounded" />
            </div>
            <div className="flex items-center gap-4">
              <div className="h-4 w-16 bg-[var(--muted)] rounded" />
              <div className="h-4 w-20 bg-[var(--muted)] rounded" />
            </div>
          </div>

          {/* Timeline skeleton */}
          <div className="border-t border-[var(--border)] pt-4">
            <div className="h-3 w-20 bg-[var(--muted)] rounded mb-4 animate-pulse" />
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex gap-3 animate-pulse">
                  <div className="h-6 w-6 bg-[var(--muted)] rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-24 bg-[var(--muted)] rounded" />
                    <div className="h-3 w-32 bg-[var(--muted)] rounded" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Progress indicator */}
      <div className="border-t border-[var(--border)] px-6 py-3 bg-blue-50/50">
        <div className="flex items-center gap-2 text-xs text-blue-600">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Connecting to airline...</span>
        </div>
      </div>
    </div>
  );
}

import { Weight, Plane, CheckCircle2, TrendingUp } from "lucide-react";
import type { TrackedAWB } from "../hooks/useTrackedAWBs";

interface DashboardProps {
  trackedAWBs: TrackedAWB[];
}

export function Dashboard({ trackedAWBs }: DashboardProps) {
  const totalTracking = trackedAWBs.length;
  const withData = trackedAWBs.filter(t => t.data);

  const delivered = withData.filter(t => t.data?.events[0]?.status_code === "DLV").length;
  const inTransit = withData.filter(t => {
    const status = t.data?.events[0]?.status_code;
    return status && ["DEP", "ARR", "RCF"].includes(status);
  }).length;
  const pending = withData.filter(t => {
    const status = t.data?.events[0]?.status_code;
    return status && ["BKD", "RCS", "MAN", "NFD"].includes(status);
  }).length;
  const withErrors = trackedAWBs.filter(t => t.error).length;

  const totalPieces = withData.reduce((sum, t) => sum + (t.data?.pieces || 0), 0);
  const totalWeight = withData.reduce((sum, t) => sum + (t.data?.weight || 0), 0);

  const routes = withData
    .filter(t => t.data?.origin && t.data?.destination)
    .map(t => `${t.data!.origin}-${t.data!.destination}`);
  const uniqueRoutes = [...new Set(routes)].length;

  if (totalTracking === 0) {
    return null;
  }

  return (
    <div className="bg-[var(--card)] rounded-xl border border-[var(--border)] p-5 shadow-sm h-full flex flex-col">
      {/* Stats Grid - 2x2 */}
      <div className="grid grid-cols-2 gap-3 flex-1">
        {/* Total */}
        <div className="rounded-xl p-4 flex flex-col justify-center border border-[var(--border)]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <TrendingUp className="h-5 w-5 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[var(--foreground)]">{totalTracking}</p>
              <p className="text-xs text-[var(--muted-foreground)]">Total • {uniqueRoutes} routes</p>
            </div>
          </div>
        </div>

        {/* Transit - RED */}
        <div className="rounded-xl p-4 flex flex-col justify-center border border-[var(--border)]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-500/10">
              <Plane className="h-5 w-5 text-red-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[var(--foreground)]">{inTransit}</p>
              <p className="text-xs text-[var(--muted-foreground)]">Transit • {pending} pend.</p>
            </div>
          </div>
        </div>

        {/* Delivered - BLUE */}
        <div className="rounded-xl p-4 flex flex-col justify-center border border-[var(--border)]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <CheckCircle2 className="h-5 w-5 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[var(--foreground)]">{delivered}</p>
              <p className="text-xs text-[var(--muted-foreground)]">
                Delivered {withErrors > 0 && <span className="text-red-500">• {withErrors} err</span>}
              </p>
            </div>
          </div>
        </div>

        {/* Carga */}
        <div className="rounded-xl p-4 flex flex-col justify-center border border-[var(--border)]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-orange-500/10">
              <Weight className="h-5 w-5 text-orange-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[var(--foreground)]">{totalWeight.toLocaleString()}<span className="text-sm font-normal ml-0.5">kg</span></p>
              <p className="text-xs text-[var(--muted-foreground)]">{totalPieces.toLocaleString()} pieces</p>
            </div>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-4 pt-4 border-t border-[var(--border)]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-[var(--foreground)]">Shipment Status</span>
          <span className="text-xs text-[var(--muted-foreground)]">{totalTracking} total</span>
        </div>
        <div className="h-2.5 bg-[var(--muted)] rounded-full overflow-hidden flex">
          {delivered > 0 && (
            <div
              className="bg-blue-500 h-full"
              style={{ width: `${(delivered / totalTracking) * 100}%` }}
            />
          )}
          {inTransit > 0 && (
            <div
              className="bg-red-400 h-full"
              style={{ width: `${(inTransit / totalTracking) * 100}%` }}
            />
          )}
          {pending > 0 && (
            <div
              className="bg-yellow-500 h-full"
              style={{ width: `${(pending / totalTracking) * 100}%` }}
            />
          )}
          {withErrors > 0 && (
            <div
              className="bg-red-500 h-full"
              style={{ width: `${(withErrors / totalTracking) * 100}%` }}
            />
          )}
        </div>
        {/* Legend */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5 text-[10px]">
          {delivered > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-500" />
              <span className="text-[var(--muted-foreground)]">Delivered ({delivered})</span>
            </span>
          )}
          {inTransit > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-400" />
              <span className="text-[var(--muted-foreground)]">Transit ({inTransit})</span>
            </span>
          )}
          {pending > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-yellow-500" />
              <span className="text-[var(--muted-foreground)]">Pending ({pending})</span>
            </span>
          )}
          {withErrors > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              <span className="text-[var(--muted-foreground)]">Error ({withErrors})</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

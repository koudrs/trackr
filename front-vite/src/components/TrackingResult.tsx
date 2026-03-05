import type { TrackingResult, TrackingEvent } from "../lib/api";
import type { LucideIcon } from "lucide-react";
import {
  Plane,
  Package,
  Weight,
  Calendar,
  CheckCircle2,
  Circle,
  PackageCheck,
  PlaneTakeoff,
  PlaneLanding,
  Warehouse,
  Bell,
  Clock,
  Link2,
  ArrowRight,
} from "lucide-react";

interface ConnectionInfo {
  awb: string;
  data: TrackingResult | null;
  isParent?: boolean; // true if this is the parent AWB
}

interface TrackingResultProps {
  data: TrackingResult;
  connection?: ConnectionInfo;
  onSelectConnection?: (awb: string) => void;
}

const STATUS_CONFIG: Record<string, { label: string; icon: LucideIcon; color: string }> = {
  BKD: { label: "Booked", icon: Calendar, color: "text-gray-500" },
  RCS: { label: "Received", icon: PackageCheck, color: "text-yellow-500" },
  MAN: { label: "Manifested", icon: Package, color: "text-orange-500" },
  DEP: { label: "Departed", icon: PlaneTakeoff, color: "text-red-500" },
  ARR: { label: "Arrived", icon: PlaneLanding, color: "text-green-500" },
  RCF: { label: "At destination", icon: Warehouse, color: "text-teal-500" },
  NFD: { label: "Ready", icon: Bell, color: "text-cyan-500" },
  DLV: { label: "Delivered", icon: CheckCircle2, color: "text-blue-500" },
  DDL: { label: "Delayed", icon: Clock, color: "text-orange-500" },
  UNK: { label: "Processing", icon: Circle, color: "text-gray-500" },
};

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  return date.toLocaleDateString("es-PA", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatWeight(weight: number | null): string {
  if (!weight) return "";
  return `${weight.toLocaleString()} kg`;
}

function TimelineEvent({ event, isFirst, isLast }: { event: TrackingEvent; isFirst: boolean; isLast: boolean }) {
  const config = STATUS_CONFIG[event.status_code] || STATUS_CONFIG.UNK;
  const Icon = config.icon;

  return (
    <div className="flex gap-2">
      <div className="flex flex-col items-center">
        <div className={`rounded-full p-1.5 ${isFirst ? "bg-[var(--primary)]/10 ring-2 ring-[var(--primary)]" : "bg-[var(--muted)]"}`}>
          <Icon className={`h-3 w-3 ${isFirst ? "text-[var(--primary)]" : config.color}`} />
        </div>
        {!isLast && <div className="w-px flex-1 bg-[var(--border)]" />}
      </div>

      <div className={`pb-3 flex-1 min-w-0 ${isLast ? "pb-0" : ""}`}>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-sm font-medium ${isFirst ? "" : "text-[var(--muted-foreground)]"}`}>
            {config.label}
          </span>
          {event.location && (
            <span className="font-mono text-[10px] px-1.5 py-0 rounded border border-[var(--border)] bg-[var(--card)]">
              {event.location}
            </span>
          )}
          {event.flight && (
            <span className="text-[10px] text-[var(--muted-foreground)] flex items-center gap-0.5">
              <Plane className="h-2.5 w-2.5" />
              {event.flight}
            </span>
          )}
        </div>

        {event.description && event.description !== event.status_code && (
          <p className="text-xs text-[var(--muted-foreground)] truncate">{event.description}</p>
        )}

        {event.timestamp && (
          <span className="text-[10px] text-[var(--muted-foreground)]">{formatDateTime(event.timestamp)}</span>
        )}
      </div>
    </div>
  );
}

export function TrackingResultCard({ data, connection, onSelectConnection }: TrackingResultProps) {
  const latestEvent = data.events[0];
  const latestConfig = latestEvent ? STATUS_CONFIG[latestEvent.status_code] || STATUS_CONFIG.UNK : null;
  const connectionConfig = connection?.data?.events[0]
    ? STATUS_CONFIG[connection.data.events[0].status_code] || STATUS_CONFIG.UNK
    : null;

  return (
    <div className="w-full rounded-lg border border-[var(--border)]/60 bg-[var(--card)] shadow-sm">
      {/* Header */}
      <div className="p-4 pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-mono text-lg font-bold">{data.awb}</p>
              {connection && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 font-medium">
                  {connection.isParent ? "Connection" : "Primary"}
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--muted-foreground)]">{data.airline} ({data.iata_code})</p>
          </div>
          {latestConfig && (
            <span className="text-xs px-2.5 py-1 shrink-0 rounded-md bg-[var(--secondary)] text-[var(--secondary-foreground)] flex items-center">
              <latestConfig.icon className={`h-3.5 w-3.5 mr-1.5 ${latestConfig.color}`} />
              {latestConfig.label}
            </span>
          )}
        </div>

        {/* Route + Stats */}
        <div className="flex items-center justify-between mt-3 py-2.5 px-3 bg-[var(--muted)]/70 rounded-lg border border-[var(--border)]/40 gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-base font-bold">{data.origin || "?"}</span>
            <Plane className="h-4 w-4 text-[var(--muted-foreground)]" />
            <span className="font-mono text-base font-bold">{data.destination || "?"}</span>
            {/* Show full route if connection exists */}
            {connection?.data && !connection.isParent && (
              <>
                <ArrowRight className="h-3 w-3 text-blue-500" />
                <span className="font-mono text-base font-bold text-blue-500">{connection.data.destination || "?"}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 text-sm">
            {data.pieces && (
              <span className="flex items-center gap-1">
                <Package className="h-4 w-4 text-[var(--muted-foreground)]" />
                <strong>{data.pieces}</strong> pcs
              </span>
            )}
            {data.weight && (
              <span className="flex items-center gap-1">
                <Weight className="h-4 w-4 text-[var(--muted-foreground)]" />
                <strong>{formatWeight(data.weight)}</strong>
              </span>
            )}
          </div>
        </div>

        {/* Connection Card */}
        {connection && connection.data && (
          <div
            className="mt-3 p-3 rounded-lg border border-blue-500/30 bg-blue-500/5 cursor-pointer hover:bg-blue-500/10 transition-colors"
            onClick={() => onSelectConnection?.(connection.awb)}
          >
            <div className="flex items-center gap-2 mb-2">
              <Link2 className="h-4 w-4 text-blue-500" />
              <span className="text-xs font-medium text-blue-500">
                {connection.isParent ? "Primary Shipment" : "Connecting Flight"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-bold">{connection.awb}</span>
                <span className="text-xs text-[var(--muted-foreground)]">
                  {connection.data.origin} → {connection.data.destination}
                </span>
              </div>
              {connectionConfig && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--muted)] text-[var(--muted-foreground)] flex items-center gap-1">
                  <connectionConfig.icon className={`h-3 w-3 ${connectionConfig.color}`} />
                  {connectionConfig.label}
                </span>
              )}
            </div>
            {connection.data.events[0]?.timestamp && (
              <p className="text-[10px] text-[var(--muted-foreground)] mt-1">
                {formatDateTime(connection.data.events[0].timestamp)}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Events Timeline */}
      {data.events.length > 0 && (
        <div className="p-4 pt-0">
          <div className="border-t border-[var(--border)] pt-3">
            <p className="text-xs font-medium mb-2 text-[var(--muted-foreground)] uppercase tracking-wide">History</p>
            <div>
              {data.events.map((event, idx) => (
                <TimelineEvent
                  key={idx}
                  event={event}
                  isFirst={idx === 0}
                  isLast={idx === data.events.length - 1}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

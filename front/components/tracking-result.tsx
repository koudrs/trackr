"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { TrackingResult, TrackingEvent } from "@/lib/api";
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
} from "lucide-react";

interface TrackingResultProps {
  data: TrackingResult;
}

const STATUS_CONFIG: Record<string, { label: string; icon: typeof Circle; color: string }> = {
  BKD: { label: "Reservado", icon: Calendar, color: "text-blue-500" },
  RCS: { label: "Recibido", icon: PackageCheck, color: "text-yellow-500" },
  MAN: { label: "Manifestado", icon: Package, color: "text-orange-500" },
  DEP: { label: "En vuelo", icon: PlaneTakeoff, color: "text-purple-500" },
  ARR: { label: "Aterrizó", icon: PlaneLanding, color: "text-indigo-500" },
  RCF: { label: "En destino", icon: Warehouse, color: "text-teal-500" },
  NFD: { label: "Listo", icon: Bell, color: "text-cyan-500" },
  DLV: { label: "Entregado", icon: CheckCircle2, color: "text-green-500" },
  DDL: { label: "Retrasado", icon: Clock, color: "text-red-500" },
  UNK: { label: "En proceso", icon: Circle, color: "text-gray-500" },
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
        <div className={`rounded-full p-1.5 ${isFirst ? "bg-primary/10 ring-2 ring-primary" : "bg-muted"}`}>
          <Icon className={`h-3 w-3 ${isFirst ? "text-primary" : config.color}`} />
        </div>
        {!isLast && <div className="w-px flex-1 bg-border" />}
      </div>

      <div className={`pb-3 flex-1 min-w-0 ${isLast ? "pb-0" : ""}`}>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-sm font-medium ${isFirst ? "" : "text-muted-foreground"}`}>
            {config.label}
          </span>
          {event.location && (
            <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0 bg-background">
              {event.location}
            </Badge>
          )}
          {event.flight && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
              <Plane className="h-2.5 w-2.5" />
              {event.flight}
            </span>
          )}
        </div>

        {event.description && event.description !== event.status_code && (
          <p className="text-xs text-muted-foreground truncate">{event.description}</p>
        )}

        {event.timestamp && (
          <span className="text-[10px] text-muted-foreground">{formatDateTime(event.timestamp)}</span>
        )}
      </div>
    </div>
  );
}

export function TrackingResultCard({ data }: TrackingResultProps) {
  const latestEvent = data.events[0];
  const latestConfig = latestEvent ? STATUS_CONFIG[latestEvent.status_code] || STATUS_CONFIG.UNK : null;

  return (
    <Card className="w-full max-w-md shadow-sm border-border/60">
      <CardHeader className="p-4 pb-3">
        {/* Header row: AWB + Status */}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-lg font-bold">{data.awb}</p>
            <p className="text-xs text-muted-foreground">{data.airline} ({data.iata_code})</p>
          </div>
          {latestConfig && (
            <Badge className="text-xs px-2.5 py-1 shrink-0 shadow-sm" variant="secondary">
              <latestConfig.icon className={`h-3.5 w-3.5 mr-1.5 ${latestConfig.color}`} />
              {latestConfig.label}
            </Badge>
          )}
        </div>

        {/* Route + Stats in one row */}
        <div className="flex items-center justify-between mt-3 py-2.5 px-3 bg-muted/70 rounded-lg border border-border/40 gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-base font-bold">{data.origin || "?"}</span>
            <Plane className="h-4 w-4 text-muted-foreground" />
            <span className="font-mono text-base font-bold">{data.destination || "?"}</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {data.pieces && (
              <span className="flex items-center gap-1">
                <Package className="h-4 w-4 text-muted-foreground" />
                <strong>{data.pieces}</strong> pzas
              </span>
            )}
            {data.weight && (
              <span className="flex items-center gap-1">
                <Weight className="h-4 w-4 text-muted-foreground" />
                <strong>{formatWeight(data.weight)}</strong>
              </span>
            )}
          </div>
        </div>
      </CardHeader>

      {data.events.length > 0 && (
        <CardContent className="p-4 pt-0">
          <div className="border-t pt-3">
            <p className="text-xs font-medium mb-2 text-muted-foreground uppercase tracking-wide">Historial</p>
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
        </CardContent>
      )}
    </Card>
  );
}

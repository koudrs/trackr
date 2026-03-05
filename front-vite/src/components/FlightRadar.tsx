import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMap, Tooltip } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { TrackedAWB } from "../hooks/useTrackedAWBs";

// Hook to detect dark mode
function useDarkMode() {
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

interface FlightRadarProps {
  trackedAWBs: TrackedAWB[];
  onSelect: (awb: string) => void;
}

// Coordenadas reales
const PANAMA: L.LatLngTuple = [9.0, -79.5];    // Ciudad de Panamá
const CHINA: L.LatLngTuple = [31.2, 121.5];    // Shanghai

// Generar curva entre dos puntos (great circle simplificado)
function generateArc(start: L.LatLngTuple, end: L.LatLngTuple, points = 50): L.LatLngTuple[] {
  const arc: L.LatLngTuple[] = [];
  for (let i = 0; i <= points; i++) {
    const t = i / points;
    const lat = start[0] + (end[0] - start[0]) * t;
    // Curva hacia el norte en el medio del trayecto
    const curve = Math.sin(t * Math.PI) * 25;
    const lng = start[1] + (end[1] - start[1]) * t;
    arc.push([lat + curve, lng]);
  }
  return arc;
}

// Icono del avión - apunta hacia arriba (norte) por defecto
function createPlaneIcon(rotation: number, isDark: boolean) {
  const fillColor = isDark ? "#f8fafc" : "#1e293b";
  return L.divIcon({
    className: "plane-marker",
    html: `<svg width="20" height="20" viewBox="0 0 39.769 39.769" fill="${fillColor}" style="transform: rotate(${rotation}deg); filter: drop-shadow(1px 1px 2px rgba(0,0,0,0.3));">
      <path d="M36.384 23.28v1.896c0 .46-.211.896-.571 1.181a1.5 1.5 0 0 1-1.282.278l-11.886-2.858v11.457l3.271 2.309a1 1 0 0 1 .424.816v.41c0 .291-.127.565-.346.758a1 1 0 0 1-.798.231l-5.314-.766-5.317.765a1 1 0 0 1-1.142-.989v-.409c0-.326.157-.632.423-.817l3.271-2.31V23.774L5.233 26.632a1.51 1.51 0 0 1-1.279-.277 1.51 1.51 0 0 1-.57-1.181v-1.896c0-.545.296-1.047.771-1.312l12.963-7.207V2.767A2.77 2.77 0 0 1 19.885 0a2.77 2.77 0 0 1 2.767 2.767V14.76l12.964 7.207c.471.266.768.768.768 1.313"/>
    </svg>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

// Icono de origen (punto azul)
const originIcon = L.divIcon({
  className: "origin-marker",
  html: `<div style="width:12px;height:12px;background:#3b82f6;border:2px solid white;border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,0.3);"></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

// Icono de destino (pin azul)
const destIcon = L.divIcon({
  className: "dest-marker",
  html: `<div style="width:16px;height:16px;background:#2563eb;border:2px solid white;border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;">
    <svg width="10" height="10" viewBox="0 0 24 24" fill="white"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
  </div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

// Componente para ajustar los bounds del mapa
function FitBounds() {
  const map = useMap();
  useEffect(() => {
    const bounds = L.latLngBounds([PANAMA, CHINA]);
    map.fitBounds(bounds, { padding: [20, 20] });
  }, [map]);
  return null;
}

function isRecentDeparture(tracked: TrackedAWB): boolean {
  if (tracked.data?.events[0]?.status_code !== "DEP") return false;
  const timestamp = tracked.data.events[0].timestamp;
  if (!timestamp) return false;
  const hoursDiff = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60);
  return hoursDiff <= 48;
}

export function FlightRadar({ trackedAWBs, onSelect }: FlightRadarProps) {
  const isDark = useDarkMode();

  const activeFlights = trackedAWBs.filter((t) => {
    const status = t.data?.events[0]?.status_code;
    return status === "DEP" && (isRecentDeparture(t) || t.data?.destination === "PTY");
  });

  const hasFlights = activeFlights.length > 0;
  const origins = hasFlights
    ? [...new Set(activeFlights.map((f) => f.data?.origin).filter(Boolean))]
    : [];

  const flightArc = generateArc(CHINA, PANAMA);

  // Ordenar por timestamp de despegue: más antiguo primero (más cerca de Panamá)
  const sortedFlights = [...activeFlights].sort((a, b) => {
    const timeA = a.data?.events[0]?.timestamp ? new Date(a.data.events[0].timestamp).getTime() : 0;
    const timeB = b.data?.events[0]?.timestamp ? new Date(b.data.events[0].timestamp).getTime() : 0;
    return timeA - timeB;
  });

  const displayFlights = sortedFlights.slice(0, 6);

  // Calcular posiciones de aviones en la curva
  const planePositions = displayFlights.map((_, index) => {
    const t = displayFlights.length === 1 ? 0.5 : 0.15 + (index / (displayFlights.length - 1)) * 0.7;
    const pointIndex = Math.floor(t * (flightArc.length - 1));
    const nextIndex = Math.min(pointIndex + 1, flightArc.length - 1);

    const pos = flightArc[pointIndex];
    const next = flightArc[nextIndex];

    const dLng = next[1] - pos[1];
    const dLat = next[0] - pos[0];
    const angle = Math.atan2(dLng, dLat) * (180 / Math.PI);

    return { pos, angle };
  });

  return (
    <div className="bg-[var(--card)] rounded-xl border border-[var(--border)] p-4 shadow-sm h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <div className="w-9 h-9 rounded-xl bg-slate-800 flex items-center justify-center shadow">
              <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" />
              </svg>
            </div>
            {hasFlights && (
              <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shadow border-2 border-white">
                {activeFlights.length}
              </span>
            )}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[var(--foreground)]">Flight Radar</h3>
            <p className="text-[10px] text-[var(--muted-foreground)]">
              {hasFlights ? `${origins.join(", ")} → PTY` : "No active flights"}
            </p>
          </div>
        </div>
        {hasFlights && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/10 border border-green-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            <span className="text-[10px] text-green-500 font-medium">LIVE</span>
          </div>
        )}
      </div>

      {/* Map - isolate creates new stacking context so Leaflet z-indexes don't escape */}
      <div className="relative flex-1 min-h-28 rounded-lg overflow-hidden isolate">
        <MapContainer
          center={[20, 20]}
          zoom={1}
          style={{ height: "100%", width: "100%" }}
          zoomControl={false}
          attributionControl={false}
          scrollWheelZoom={false}
          dragging={false}
          doubleClickZoom={false}
          touchZoom={false}
          keyboard={false}
        >
          <TileLayer
            url={isDark
              ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              : "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png"
            }
            opacity={isDark ? 0.7 : 0.5}
          />
          <FitBounds />

          {/* Ruta de vuelo */}
          <Polyline
            positions={flightArc}
            pathOptions={{ color: "#94a3b8", weight: 2, dashArray: "6, 6" }}
          />

          {/* Marcador origen: China */}
          <Marker position={CHINA} icon={originIcon} />

          {/* Marcador destino: Panama */}
          <Marker position={PANAMA} icon={destIcon} />

          {/* Aviones */}
          {displayFlights.map((flight, index) => {
            const { pos, angle } = planePositions[index];
            return (
              <Marker
                key={flight.awb}
                position={pos}
                icon={createPlaneIcon(angle, isDark)}
                eventHandlers={{ click: () => onSelect(flight.awb) }}
              >
                <Tooltip direction="top" offset={[0, -10]} className="flight-tooltip">
                  <span className="font-mono text-[10px]">{flight.awb}</span>
                </Tooltip>
              </Marker>
            );
          })}
        </MapContainer>

        {/* Labels sobre el mapa */}
        {hasFlights && (
          <>
            <div className="absolute right-2 top-2 z-[1000]">
              <span className="text-[8px] font-mono font-bold text-[var(--foreground)] bg-[var(--card)]/90 px-1.5 py-0.5 rounded shadow-sm">
                {origins.length === 1 ? origins[0] : "CHINA"}
              </span>
            </div>
            <div className="absolute left-2 bottom-2 z-[1000]">
              <span className="text-[8px] font-mono font-bold text-white bg-red-600 px-1.5 py-0.5 rounded shadow-md">
                PTY
              </span>
            </div>
          </>
        )}
      </div>

      {/* AWB chips */}
      {hasFlights ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {activeFlights.slice(0, 5).map((flight) => (
            <button
              key={flight.awb}
              onClick={() => onSelect(flight.awb)}
              className="text-[9px] px-2 py-0.5 rounded-full bg-[var(--muted)] text-[var(--muted-foreground)] hover:bg-[var(--accent)] transition-colors font-mono"
            >
              {flight.awb}
            </button>
          ))}
          {activeFlights.length > 5 && (
            <span className="text-[9px] px-2 py-0.5 text-[var(--muted-foreground)]">+{activeFlights.length - 5}</span>
          )}
        </div>
      ) : (
        <div className="mt-2.5 text-center">
          <p className="text-[10px] text-[var(--muted-foreground)]">
            Flights in transit will appear here
          </p>
        </div>
      )}
    </div>
  );
}

import { useState, useMemo } from "react";
import {
  X,
  RefreshCw,
  Trash2,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Plane,
  PlaneTakeoff,
  PlaneLanding,
  Package,
  BoxIcon,
  Search,
  ChevronDown,
  Link2,
  Unlink,
} from "lucide-react";
import type { TrackedAWB } from "../hooks/useTrackedAWBs";

interface TrackingSidebarProps {
  trackedAWBs: TrackedAWB[];
  selectedAWB: string | null;
  onSelect: (awb: string) => void;
  onRemove: (awb: string) => void;
  onRefresh: (awb: string) => void;
  onClearAll: () => void;
  onRefreshAll: () => void;
  onTrack: (awb: string) => void;
  onAddConnection: (parentAWB: string, connectionAWB: string) => Promise<unknown>;
  onUnlinkConnection: (parentAWB: string) => void;
  isOpen?: boolean;
  onClose?: () => void;
}

type FilterType = "all" | "transit" | "delivered" | "pending";

function formatEventDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  return date.toLocaleDateString("es-PA", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getStatusInfo(tracked: TrackedAWB): { icon: React.ReactNode; label: string; color: string; bgColor: string; priority: number } {
  if (tracked.isLoading) {
    return {
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
      label: "Loading",
      color: "text-blue-500",
      bgColor: "bg-blue-500/20",
      priority: 0,
    };
  }
  if (tracked.error) {
    return {
      icon: <AlertCircle className="h-3.5 w-3.5" />,
      label: "Error",
      color: "text-red-500",
      bgColor: "bg-red-500/20",
      priority: 1,
    };
  }
  if (tracked.data) {
    const status = tracked.data.events[0]?.status_code;
    if (status === "DLV") {
      return {
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        label: "Delivered",
        color: "text-blue-500",
        bgColor: "bg-blue-500/20",
        priority: 10,
      };
    }
    if (status === "ARR") {
      return {
        icon: <PlaneLanding className="h-3.5 w-3.5" />,
        label: "Arrived",
        color: "text-green-500",
        bgColor: "bg-green-500/20",
        priority: 3,
      };
    }
    if (status === "DEP") {
      return {
        icon: <PlaneTakeoff className="h-3.5 w-3.5" />,
        label: "Departed",
        color: "text-red-500",
        bgColor: "bg-red-500/20",
        priority: 4,
      };
    }
    if (status === "RCF" || status === "NFD") {
      return {
        icon: <Package className="h-3.5 w-3.5" />,
        label: status === "NFD" ? "Ready" : "At destination",
        color: "text-teal-500",
        bgColor: "bg-teal-500/20",
        priority: 2,
      };
    }
    if (status === "MAN") {
      return {
        icon: <BoxIcon className="h-3.5 w-3.5" />,
        label: "Manifested",
        color: "text-orange-500",
        bgColor: "bg-orange-500/20",
        priority: 5,
      };
    }
    if (status === "RCS") {
      return {
        icon: <Package className="h-3.5 w-3.5" />,
        label: "Received",
        color: "text-yellow-500",
        bgColor: "bg-yellow-500/20",
        priority: 6,
      };
    }
    if (status === "BKD") {
      return {
        icon: <Clock className="h-3.5 w-3.5" />,
        label: "Booked",
        color: "text-blue-500",
        bgColor: "bg-blue-500/20",
        priority: 7,
      };
    }
  }
  return {
    icon: <Clock className="h-3.5 w-3.5" />,
    label: "Pending",
    color: "text-gray-500",
    bgColor: "bg-gray-500/20",
    priority: 8,
  };
}

// Check if DEP event is recent (within last 48 hours)
function isRecentDeparture(tracked: TrackedAWB): boolean {
  if (tracked.data?.events[0]?.status_code !== "DEP") return false;
  const timestamp = tracked.data.events[0].timestamp;
  if (!timestamp) return false;
  const eventDate = new Date(timestamp);
  const now = new Date();
  const hoursDiff = (now.getTime() - eventDate.getTime()) / (1000 * 60 * 60);
  return hoursDiff <= 48;
}

function sortAWBs(awbs: TrackedAWB[]): TrackedAWB[] {
  return [...awbs].sort((a, b) => {
    // 1. PRIORITY: DEP + destination PTY first (en camino a Panamá)
    const aDepToPTY = a.data?.events[0]?.status_code === "DEP" && a.data?.destination === "PTY" ? 1 : 0;
    const bDepToPTY = b.data?.events[0]?.status_code === "DEP" && b.data?.destination === "PTY" ? 1 : 0;
    if (bDepToPTY !== aDepToPTY) return bDepToPTY - aDepToPTY;

    // 2. Recent DEP (últimas 48h) - vuelos activos cualquier destino
    const aRecentDep = isRecentDeparture(a) ? 1 : 0;
    const bRecentDep = isRecentDeparture(b) ? 1 : 0;
    if (bRecentDep !== aRecentDep) return bRecentDep - aRecentDep;

    // 3. PTY routes (destination = PTY)
    const aPTY = a.data?.destination === "PTY" ? 1 : 0;
    const bPTY = b.data?.destination === "PTY" ? 1 : 0;
    if (bPTY !== aPTY) return bPTY - aPTY;

    // 4. By status priority (closer to delivery = higher)
    const aPriority = getStatusInfo(a).priority;
    const bPriority = getStatusInfo(b).priority;
    if (aPriority !== bPriority) return aPriority - bPriority;

    // 5. By last updated (most recent first)
    return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
  });
}

function getFilteredAWBs(
  awbs: TrackedAWB[],
  filter: FilterType,
  airlineFilter: string,
  searchQuery: string
): TrackedAWB[] {
  let filtered = [...awbs];

  // Filter by airline
  if (airlineFilter && airlineFilter !== "all") {
    filtered = filtered.filter((t) => t.data?.iata_code === airlineFilter);
  }

  // Filter by search query
  if (searchQuery.trim()) {
    const query = searchQuery.toLowerCase();
    filtered = filtered.filter(
      (t) =>
        t.awb.toLowerCase().includes(query) ||
        t.data?.airline?.toLowerCase().includes(query) ||
        t.data?.origin?.toLowerCase().includes(query) ||
        t.data?.destination?.toLowerCase().includes(query)
    );
  }

  // Filter by status
  if (filter !== "all") {
    filtered = filtered.filter((t) => {
      const status = t.data?.events[0]?.status_code;
      if (filter === "delivered") return status === "DLV";
      if (filter === "transit") return ["DEP", "ARR", "RCF"].includes(status || "");
      if (filter === "pending") return ["BKD", "RCS", "MAN", "NFD"].includes(status || "") || !status;
      return true;
    });
  }

  return sortAWBs(filtered);
}

export function TrackingSidebar({
  trackedAWBs,
  selectedAWB,
  onSelect,
  onRemove,
  onRefresh,
  onClearAll,
  onRefreshAll,
  onTrack,
  onAddConnection,
  onUnlinkConnection,
  isOpen = false,
  onClose,
}: TrackingSidebarProps) {
  const [airlineFilter, setAirlineFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showAirlineDropdown, setShowAirlineDropdown] = useState(false);
  const [addingConnectionFor, setAddingConnectionFor] = useState<string | null>(null);
  const [connectionInput, setConnectionInput] = useState("");

  // Get unique airlines from tracked AWBs
  const airlines = useMemo(() => {
    const airlineSet = new Map<string, string>();
    trackedAWBs.forEach((t) => {
      if (t.data?.iata_code && t.data?.airline) {
        airlineSet.set(t.data.iata_code, t.data.airline);
      }
    });
    return Array.from(airlineSet.entries()).map(([code, name]) => ({ code, name }));
  }, [trackedAWBs]);

  const filteredAWBs = getFilteredAWBs(trackedAWBs, "all", airlineFilter, searchQuery);

  // Handle search submit
  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      onTrack(searchQuery.trim());
      setSearchQuery("");
    }
  };

  // Mobile sidebar classes
  const mobileClasses = isOpen
    ? "translate-x-0"
    : "-translate-x-full";

  // Split AWBs into two groups: En Vuelo (DEP) and Aterrizó (ARR)
  const enVueloAWBs = filteredAWBs.filter((t) => {
    const status = t.data?.events[0]?.status_code;
    return status === "DEP" || isRecentDeparture(t);
  });

  const aterrizoAWBs = filteredAWBs.filter((t) => {
    const status = t.data?.events[0]?.status_code;
    return status === "ARR";
  });

  const otherAWBs = filteredAWBs.filter((t) => {
    const status = t.data?.events[0]?.status_code;
    return !["DEP", "ARR"].includes(status || "") && !isRecentDeparture(t);
  });

  if (trackedAWBs.length === 0) {
    return (
      <aside className={`fixed lg:static inset-y-0 left-0 z-50 w-[420px] h-screen border-r border-[var(--border)] bg-[var(--card)] flex flex-col transform transition-transform duration-300 ease-in-out lg:translate-x-0 ${mobileClasses}`}>
        <div className="p-5 border-b border-[var(--border)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-lg bg-blue-100">
                <Plane className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <h2 className="text-sm font-semibold">My Trackings</h2>
                <p className="text-xs text-[var(--muted-foreground)]">0 shipments</p>
              </div>
            </div>
            {/* Close button for mobile */}
            {onClose && (
              <button
                onClick={onClose}
                className="lg:hidden p-1.5 rounded-lg hover:bg-[var(--muted)] text-[var(--muted-foreground)]"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center">
            <Package className="h-12 w-12 mx-auto text-[var(--muted-foreground)]/50 mb-3" />
            <p className="text-sm text-[var(--muted-foreground)]">
              Los AWBs que rastrees aparecerán aquí
            </p>
            <p className="text-xs text-[var(--muted-foreground)]/70 mt-1">
              Auto-refresh every 5 minutes
            </p>
          </div>
        </div>
      </aside>
    );
  }

  // Handle adding connection
  const handleAddConnection = async (e: React.FormEvent, parentAWB: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (connectionInput.trim()) {
      try {
        await onAddConnection(parentAWB, connectionInput.trim());
        setConnectionInput("");
        setAddingConnectionFor(null);
      } catch {
        // Error handled by parent
      }
    }
  };

  // Get connection AWB data
  const getConnectionData = (connectionAWB: string) => {
    return trackedAWBs.find(t => t.awb === connectionAWB);
  };

  // Render a compact AWB card for the split view
  const renderCompactCard = (tracked: TrackedAWB) => {
    const statusInfo = getStatusInfo(tracked);
    const destination = tracked.data?.destination;
    // Show add connection button if: destination is not PTY and no connection yet
    // This allows adding connections for any AWB that stops at an intermediate point (MIA, AMS, etc.)
    const canAddConnection = destination && destination !== "PTY" && !tracked.connectionAWB && tracked.data;
    const hasConnection = !!tracked.connectionAWB;
    const connectionData = hasConnection ? getConnectionData(tracked.connectionAWB!) : null;
    const isAddingConnection = addingConnectionFor === tracked.awb;

    return (
      <div key={tracked.awb}>
        <div
          className={`group p-2 border-b border-[var(--border)]/50 cursor-pointer hover:bg-[var(--muted)]/30 transition-all ${
            selectedAWB === tracked.awb
              ? "bg-[var(--muted)]/50 border-l-2 border-l-[var(--primary)]"
              : "border-l-2 border-l-transparent"
          }`}
          onClick={() => onSelect(tracked.awb)}
        >
          <div className="flex items-center justify-between gap-1 mb-1">
            <span className="font-mono text-xs font-medium truncate">{tracked.awb}</span>
            <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              {canAddConnection && (
                <button
                  onClick={(e) => { e.stopPropagation(); setAddingConnectionFor(tracked.awb); }}
                  className="p-0.5 rounded hover:bg-blue-500/20 text-blue-500"
                  title="Add connecting flight"
                >
                  <Link2 className="h-2.5 w-2.5" />
                </button>
              )}
              {hasConnection && (
                <button
                  onClick={(e) => { e.stopPropagation(); onUnlinkConnection(tracked.awb); }}
                  className="p-0.5 rounded hover:bg-orange-500/20 text-orange-500"
                  title="Unlink connection"
                >
                  <Unlink className="h-2.5 w-2.5" />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onRefresh(tracked.awb); }}
                className="p-0.5 rounded hover:bg-[var(--muted)] text-[var(--muted-foreground)]"
                disabled={tracked.isLoading}
              >
                <RefreshCw className={`h-2.5 w-2.5 ${tracked.isLoading ? "animate-spin" : ""}`} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onRemove(tracked.awb); }}
                className="p-0.5 rounded hover:bg-red-500/20 text-[var(--muted-foreground)] hover:text-red-500"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          </div>

          {tracked.data?.origin && tracked.data?.destination && (
            <div className="flex items-center gap-1 text-[10px] mb-1">
              <span className="font-mono">{tracked.data.origin}</span>
              <Plane className="h-2.5 w-2.5 text-[var(--muted-foreground)]" />
              <span className="font-mono">{tracked.data.destination}</span>
              {hasConnection && connectionData?.data && (
                <>
                  <span className="text-[var(--muted-foreground)]">→</span>
                  <span className="font-mono text-blue-500">{connectionData.data.destination}</span>
                </>
              )}
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className={`inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full ${statusInfo.bgColor} ${statusInfo.color}`}>
              {statusInfo.icon}
              {statusInfo.label}
            </span>
            {tracked.data?.events[0]?.timestamp && (
              <span className="text-[9px] text-[var(--muted-foreground)]">
                {formatEventDateTime(tracked.data.events[0].timestamp)}
              </span>
            )}
          </div>

          {/* Connection info badge */}
          {hasConnection && connectionData && (
            <div
              className="mt-1.5 flex items-center gap-1 text-[9px] px-1.5 py-1 rounded bg-blue-500/10 border border-blue-500/20 cursor-pointer"
              onClick={(e) => { e.stopPropagation(); onSelect(connectionData.awb); }}
            >
              <Link2 className="h-2.5 w-2.5 text-blue-500" />
              <span className="font-mono text-blue-500">{connectionData.awb}</span>
              <span className="text-[var(--muted-foreground)]">
                {connectionData.data?.origin} → {connectionData.data?.destination}
              </span>
              {connectionData.data?.events[0]?.status_code && (
                <span className={`ml-auto ${getStatusInfo(connectionData).color}`}>
                  {connectionData.data.events[0].status_code}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Add connection form */}
        {isAddingConnection && (
          <form
            onSubmit={(e) => handleAddConnection(e, tracked.awb)}
            className="p-2 bg-blue-500/5 border-b border-[var(--border)]"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[9px] text-[var(--muted-foreground)] mb-1.5">
              Add connecting flight from {destination} → PTY
            </p>
            <div className="flex gap-1">
              <input
                type="text"
                placeholder="810-XXXXXXXX"
                value={connectionInput}
                onChange={(e) => setConnectionInput(e.target.value)}
                className="flex-1 h-6 px-2 rounded border border-[var(--border)] bg-[var(--background)] text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                autoFocus
              />
              <button
                type="submit"
                className="px-2 h-6 rounded bg-blue-500 text-white text-[10px] font-medium hover:bg-blue-600"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => { setAddingConnectionFor(null); setConnectionInput(""); }}
                className="px-2 h-6 rounded bg-[var(--muted)] text-[var(--muted-foreground)] text-[10px] hover:bg-[var(--accent)]"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    );
  };

  return (
    <aside className={`fixed lg:static inset-y-0 left-0 z-50 w-[420px] h-screen border-r border-[var(--border)] bg-[var(--card)] flex flex-col overflow-hidden transform transition-transform duration-300 ease-in-out lg:translate-x-0 ${mobileClasses}`}>
      {/* Compact Header */}
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          {/* Search */}
          <form onSubmit={handleSearchSubmit} className="flex-1 relative">
            <input
              type="text"
              placeholder="Search AWB..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-7 px-2.5 pr-7 rounded border border-[var(--border)] bg-[var(--background)] text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
            />
            <button
              type="submit"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <Search className="h-3 w-3" />
            </button>
          </form>

          {/* Airline dropdown */}
          {airlines.length > 1 && (
            <div className="relative">
              <button
                onClick={() => setShowAirlineDropdown(!showAirlineDropdown)}
                className="flex items-center gap-1 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--background)] text-[10px] hover:bg-[var(--muted)]"
              >
                <Plane className="h-3 w-3" />
                <span>{airlineFilter === "all" ? "All" : airlineFilter}</span>
                <ChevronDown className={`h-3 w-3 transition-transform ${showAirlineDropdown ? "rotate-180" : ""}`} />
              </button>
              {showAirlineDropdown && (
                <div className="absolute top-full right-0 mt-1 py-1 rounded border border-[var(--border)] bg-[var(--card)] shadow-lg z-10 min-w-32">
                  <button
                    onClick={() => { setAirlineFilter("all"); setShowAirlineDropdown(false); }}
                    className={`w-full px-2 py-1 text-[10px] text-left hover:bg-[var(--muted)] ${airlineFilter === "all" ? "bg-[var(--muted)]" : ""}`}
                  >
                    All
                  </button>
                  {airlines.map((airline) => (
                    <button
                      key={airline.code}
                      onClick={() => { setAirlineFilter(airline.code); setShowAirlineDropdown(false); }}
                      className={`w-full px-2 py-1 text-[10px] text-left hover:bg-[var(--muted)] ${airlineFilter === airline.code ? "bg-[var(--muted)]" : ""}`}
                    >
                      {airline.code}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <button onClick={onRefreshAll} className="p-1 rounded hover:bg-[var(--muted)]" title="Refresh">
            <RefreshCw className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
          </button>
          <button onClick={onClearAll} className="p-1 rounded hover:bg-red-100" title="Clear all">
            <Trash2 className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
          </button>
          {onClose && (
            <button onClick={onClose} className="lg:hidden p-1 rounded hover:bg-[var(--muted)]">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Top Row: Departed | Arrived (50% height) */}
      <div className="flex-1 flex overflow-hidden border-b border-[var(--border)]">
        {/* Departed Column - RED */}
        <div className="flex-1 flex flex-col border-r border-[var(--border)]">
          <div className="px-3 py-2 bg-red-500/10 border-b border-[var(--border)] flex items-center gap-2">
            <PlaneTakeoff className="h-4 w-4 text-red-500" />
            <span className="text-xs font-semibold text-red-500">Departed</span>
            <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-500 font-medium">
              {enVueloAWBs.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {enVueloAWBs.length === 0 ? (
              <div className="p-4 text-center">
                <PlaneTakeoff className="h-6 w-6 mx-auto text-[var(--muted-foreground)]/30 mb-2" />
                <p className="text-[10px] text-[var(--muted-foreground)]">No flights</p>
              </div>
            ) : (
              enVueloAWBs.map(renderCompactCard)
            )}
          </div>
        </div>

        {/* Arrived Column - GREEN */}
        <div className="flex-1 flex flex-col">
          <div className="px-3 py-2 bg-green-500/10 border-b border-[var(--border)] flex items-center gap-2">
            <PlaneLanding className="h-4 w-4 text-green-500" />
            <span className="text-xs font-semibold text-green-500">Arrived</span>
            <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-500 font-medium">
              {aterrizoAWBs.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {aterrizoAWBs.length === 0 ? (
              <div className="p-4 text-center">
                <PlaneLanding className="h-6 w-6 mx-auto text-[var(--muted-foreground)]/30 mb-2" />
                <p className="text-[10px] text-[var(--muted-foreground)]">No arrivals</p>
              </div>
            ) : (
              aterrizoAWBs.map(renderCompactCard)
            )}
          </div>
        </div>
      </div>

      {/* Bottom Row: Others (50% height) */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-3 py-2 bg-[var(--muted)]/50 border-b border-[var(--border)] flex items-center gap-2">
          <Package className="h-4 w-4 text-[var(--muted-foreground)]" />
          <span className="text-xs font-semibold text-[var(--muted-foreground)]">Others</span>
          <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--muted)] text-[var(--muted-foreground)] font-medium">
            {otherAWBs.length}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {otherAWBs.length === 0 ? (
            <div className="p-4 text-center">
              <Package className="h-6 w-6 mx-auto text-[var(--muted-foreground)]/30 mb-2" />
              <p className="text-[10px] text-[var(--muted-foreground)]">No pending</p>
            </div>
          ) : (
            otherAWBs.map(renderCompactCard)
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-[var(--border)] bg-[var(--muted)]/30">
        <div className="flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
          <span>Auto-refresh: 5 min</span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Active
          </span>
        </div>
      </div>
    </aside>
  );
}

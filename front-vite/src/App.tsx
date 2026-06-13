import { useState, useEffect } from "react";
import { Menu, Moon, Sun, Radar, List, ChevronRight } from "lucide-react";
import { TrackingForm } from "./components/TrackingForm";
import { TrackingResultCard } from "./components/TrackingResult";
import { SupportedCarriers } from "./components/SupportedCarriers";
import { TrackingSidebar } from "./components/TrackingSidebar";
import { Dashboard } from "./components/Dashboard";
import { LiveRadarView } from "./components/LiveRadarView";
import { LoadingCard } from "./components/LoadingCard";
import { ErrorCard } from "./components/ErrorCard";
import { useTrackedAWBs } from "./hooks/useTrackedAWBs";
import type { TrackingResult } from "./lib/api";

type View = "tracking" | "radar";

function App() {
  const [selectedResult, setSelectedResult] = useState<TrackingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedAWB, setSelectedAWB] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<View>(() => {
    const saved = localStorage.getItem("view");
    return saved === "radar" ? "radar" : "tracking";
  });
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem("darkMode");
    return saved ? JSON.parse(saved) : false;
  });

  useEffect(() => {
    localStorage.setItem("view", view);
  }, [view]);

  useEffect(() => {
    localStorage.setItem("darkMode", JSON.stringify(darkMode));
    if (darkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [darkMode]);

  const { trackedAWBs, addAWB, removeAWB, clearAll, refreshAWB, refreshAll, addConnection, unlinkConnection } = useTrackedAWBs();

  const handleClear = () => {
    setSelectedResult(null);
    setError(null);
    setSelectedAWB(null);
  };

  const handleTrack = async (awb: string) => {
    setIsLoading(true);
    setError(null);
    setSelectedResult(null);
    setSelectedAWB(awb);
    setSidebarOpen(false); // Close sidebar on mobile after tracking

    try {
      const data = await addAWB(awb);
      if (data) {
        setSelectedResult(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRetry = async () => {
    if (selectedAWB) {
      await handleTrack(selectedAWB);
    }
  };

  const handleDismissError = () => {
    setError(null);
    if (selectedAWB) {
      removeAWB(selectedAWB);
    }
    setSelectedAWB(null);
  };

  const handleSelectFromSidebar = (awb: string) => {
    const tracked = trackedAWBs.find((t) => t.awb === awb);
    if (tracked) {
      setSelectedAWB(awb);
      setSelectedResult(tracked.data);
      setError(tracked.error);
      setSidebarOpen(false); // Close sidebar on mobile after selection
      if (tracked.isLoading) {
        setIsLoading(true);
      } else {
        setIsLoading(false);
      }
    }
  };

  const handleRefreshFromSidebar = async (awb: string) => {
    if (selectedAWB === awb) {
      setIsLoading(true);
      setError(null);
    }
    const data = await refreshAWB(awb);
    if (selectedAWB === awb) {
      setIsLoading(false);
      if (data) {
        setSelectedResult(data);
        setError(null);
      } else {
        const tracked = trackedAWBs.find((t) => t.awb === awb);
        if (tracked?.error) {
          setError(tracked.error);
        }
      }
    }
  };

  const selectedTracked = selectedAWB ? trackedAWBs.find((t) => t.awb === selectedAWB) : null;
  const showLoading = isLoading || (selectedTracked?.isLoading && !selectedResult);
  const currentError = error || (selectedTracked?.error && !selectedResult ? selectedTracked.error : null);

  // Get connection info for selected AWB
  const getConnectionInfo = () => {
    if (!selectedTracked) return undefined;

    // If this AWB has a connection (child AWB)
    if (selectedTracked.connectionAWB) {
      const connectionTracked = trackedAWBs.find(t => t.awb === selectedTracked.connectionAWB);
      if (connectionTracked) {
        return {
          awb: connectionTracked.awb,
          data: connectionTracked.data,
          isParent: false, // The connection is the child (connecting flight)
        };
      }
    }

    // If this AWB is a connection (has a parent)
    if (selectedTracked.parentAWB) {
      const parentTracked = trackedAWBs.find(t => t.awb === selectedTracked.parentAWB);
      if (parentTracked) {
        return {
          awb: parentTracked.awb,
          data: parentTracked.data,
          isParent: true, // The connection is the parent (primary shipment)
        };
      }
    }

    return undefined;
  };

  const connectionInfo = getConnectionInfo();

  return (
    <div className="h-screen flex overflow-hidden bg-[var(--background)]">
      {/* Mobile Sidebar Overlay */}
      <div
        className={`fixed inset-0 bg-black/50 z-40 lg:hidden transition-opacity duration-300 ${
          sidebarOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setSidebarOpen(false)}
      />

      {/* Sidebar (hidden in radar mode so the full-screen map owns the screen) */}
      {view !== "radar" && (
        <TrackingSidebar
          trackedAWBs={trackedAWBs}
          selectedAWB={selectedAWB}
          onSelect={handleSelectFromSidebar}
          onRemove={removeAWB}
          onRefresh={handleRefreshFromSidebar}
          onClearAll={clearAll}
          onRefreshAll={refreshAll}
          onTrack={handleTrack}
          onAddConnection={addConnection}
          onUnlinkConnection={unlinkConnection}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
      )}

      {/* Main Content — hidden while the full-screen radar is open so it can't
          bleed through behind the map. */}
      <main className={`flex-1 flex flex-col h-screen overflow-hidden ${view === "radar" ? "hidden" : ""}`}>
        {/* Header */}
        <header className="shrink-0 bg-[var(--card)] border-b border-[var(--border)] px-4 lg:px-6 py-3">
          <div className="max-w-5xl mx-auto">
            <div className="flex items-center justify-between gap-3">
              {/* Mobile menu button + Brand */}
              <div className="flex items-center gap-3 shrink-0">
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="lg:hidden p-2 -ml-2 rounded-lg hover:bg-[var(--muted)] text-[var(--foreground)]"
                >
                  <Menu className="h-5 w-5" />
                </button>
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-amber-500 flex items-center justify-center shadow-md shadow-amber-500/30">
                    <Radar className="h-5 w-5 text-white" />
                  </div>
                  <div>
                    <h1 className="text-base lg:text-lg font-bold leading-none">Cargo Tracking</h1>
                    <p className="text-[10px] lg:text-xs text-[var(--muted-foreground)] hidden sm:block mt-0.5">
                      Real-time air cargo
                    </p>
                  </div>
                </div>
              </div>

              {/* View switch: Shipments / Radar — prominent segmented control */}
              <div className="flex items-center rounded-xl border border-[var(--border)] bg-[var(--muted)]/60 p-1 shadow-inner">
                <button
                  onClick={() => setView("tracking")}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold transition-all ${
                    view === "tracking"
                      ? "bg-amber-500 text-white shadow-md shadow-amber-500/30"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--card)]/60"
                  }`}
                  title="Shipments list"
                >
                  <List className="h-4 w-4" />
                  <span className="hidden sm:inline">Shipments</span>
                </button>
                <button
                  onClick={() => setView("radar")}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold transition-all ${
                    view === "radar"
                      ? "bg-amber-500 text-white shadow-md shadow-amber-500/30"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--card)]/60"
                  }`}
                  title="Live flight radar"
                >
                  <Radar className="h-4 w-4" />
                  <span className="hidden sm:inline">Radar</span>
                  {trackedAWBs.length > 0 && (
                    <span className={`ml-0.5 flex items-center justify-center min-w-5 h-5 px-1 rounded-full text-[10px] font-bold ${
                      view === "radar" ? "bg-white/25" : "bg-amber-500/15 text-amber-500"
                    }`}>
                      {trackedAWBs.length}
                    </span>
                  )}
                </button>
              </div>

              {/* Right actions: search + theme */}
              <div className="flex items-center gap-2 shrink-0">
                <div className="hidden sm:block">
                  <TrackingForm onSubmit={handleTrack} onClear={handleClear} isLoading={isLoading} />
                </div>
                <button
                  onClick={() => setDarkMode(!darkMode)}
                  className="p-2 rounded-lg hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                  title={darkMode ? "Light mode" : "Dark mode"}
                >
                  {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
                </button>
              </div>
            </div>

            {/* Mobile search form */}
            <div className="sm:hidden mt-3">
              <TrackingForm onSubmit={handleTrack} onClear={handleClear} isLoading={isLoading} />
            </div>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 px-4 lg:px-6 py-6 overflow-y-auto">
          <div className="max-w-5xl mx-auto">
            {/* Top Row: a CTA to open the real radar + Dashboard stats */}
            {trackedAWBs.length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                <button
                  onClick={() => setView("radar")}
                  className="group relative overflow-hidden rounded-xl border border-[var(--border)] bg-gradient-to-br from-amber-500/10 to-transparent p-5 text-left transition-all hover:border-amber-500/40 hover:shadow-md"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-xl bg-amber-500 flex items-center justify-center shadow-md shadow-amber-500/30 group-hover:scale-105 transition-transform">
                        <Radar className="h-6 w-6 text-white" />
                      </div>
                      <div>
                        <h3 className="text-base font-bold text-[var(--foreground)]">Open Live Radar</h3>
                        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
                          Track your {trackedAWBs.length} shipment{trackedAWBs.length > 1 ? "s" : ""} on a live world map
                        </p>
                      </div>
                    </div>
                    <ChevronRight className="h-5 w-5 text-[var(--muted-foreground)] group-hover:text-amber-500 group-hover:translate-x-1 transition-all" />
                  </div>
                </button>
                <Dashboard trackedAWBs={trackedAWBs} />
              </div>
            )}

            {/* Loading State */}
            {showLoading && selectedAWB && (
              <div className="mb-6">
                <h2 className="text-sm font-medium text-[var(--muted-foreground)] mb-3 uppercase tracking-wide">
                  Processing
                </h2>
                <LoadingCard awb={selectedAWB} />
              </div>
            )}

            {/* Error State */}
            {currentError && !showLoading && selectedAWB && (
              <div className="mb-6">
                <h2 className="text-sm font-medium text-[var(--muted-foreground)] mb-3 uppercase tracking-wide">
                  Tracking Error
                </h2>
                <ErrorCard
                  awb={selectedAWB}
                  error={currentError}
                  onRetry={handleRetry}
                  onDismiss={handleDismissError}
                  isRetrying={isLoading}
                />
              </div>
            )}

            {/* Selected Result */}
            {selectedResult && !showLoading && !currentError && (
              <div className="mb-6">
                <h2 className="text-sm font-medium text-[var(--muted-foreground)] mb-3 uppercase tracking-wide">
                  Shipment Details
                </h2>
                <TrackingResultCard
                  data={selectedResult}
                  connection={connectionInfo}
                  onSelectConnection={handleSelectFromSidebar}
                />
              </div>
            )}

            {/* Welcome state - no trackings */}
            {!selectedAWB && trackedAWBs.length === 0 && (
              <div className="mb-6">
                <SupportedCarriers />
              </div>
            )}

            {/* Empty state - has trackings but none selected */}
            {!selectedAWB && trackedAWBs.length > 0 && (
              <div className="bg-[var(--card)] rounded-xl border border-[var(--border)]/60 p-8 text-center shadow-sm">
                <p className="text-[var(--muted-foreground)]">
                  <span className="hidden lg:inline">Select a shipment from the left panel to view details</span>
                  <span className="lg:hidden">Tap the menu to see your shipments</span>
                </p>
                <p className="text-sm text-[var(--muted-foreground)]/70 mt-2">
                  or enter a new AWB in the search bar
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <footer className="shrink-0 bg-[var(--card)] border-t border-[var(--border)] px-4 lg:px-6 py-3">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <p className="text-xs text-[var(--muted-foreground)]">
              Powered by{" "}
              <a
                href="https://koudrs.com"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                koudrs.com
              </a>
            </p>
            <p className="text-xs text-[var(--muted-foreground)]">
              {trackedAWBs.length > 0 ? `${trackedAWBs.length} shipments` : "No shipments"}
            </p>
          </div>
        </footer>
      </main>

      {/* Full-screen live radar (rendered above everything via fixed inset-0) */}
      {view === "radar" && (
        <LiveRadarView
          trackedAWBs={trackedAWBs}
          selectedAWB={selectedAWB}
          onSelect={handleSelectFromSidebar}
          onClose={() => setView("tracking")}
          darkMode={darkMode}
          onToggleTheme={() => setDarkMode(!darkMode)}
          onAddAWB={addAWB}
          onRemoveAWB={removeAWB}
        />
      )}
    </div>
  );
}

export default App;

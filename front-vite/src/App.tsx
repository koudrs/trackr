import { useState, useEffect } from "react";
import { Menu, Moon, Sun } from "lucide-react";
import { TrackingForm } from "./components/TrackingForm";
import { TrackingResultCard } from "./components/TrackingResult";
import { SupportedCarriers } from "./components/SupportedCarriers";
import { TrackingSidebar } from "./components/TrackingSidebar";
import { Dashboard } from "./components/Dashboard";
import { FlightRadar } from "./components/FlightRadar";
import { LoadingCard } from "./components/LoadingCard";
import { ErrorCard } from "./components/ErrorCard";
import { useTrackedAWBs } from "./hooks/useTrackedAWBs";
import type { TrackingResult } from "./lib/api";

function App() {
  const [selectedResult, setSelectedResult] = useState<TrackingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedAWB, setSelectedAWB] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem("darkMode");
    return saved ? JSON.parse(saved) : false;
  });

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
      setError(err instanceof Error ? err.message : "Error desconocido");
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
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
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

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Header */}
        <header className="shrink-0 bg-[var(--card)] border-b border-[var(--border)] px-4 lg:px-6 py-4">
          <div className="max-w-5xl mx-auto">
            <div className="flex items-center justify-between gap-4">
              {/* Mobile menu button + Title */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="lg:hidden p-2 -ml-2 rounded-lg hover:bg-[var(--muted)] text-[var(--foreground)]"
                >
                  <Menu className="h-5 w-5" />
                </button>
                <div>
                  <h1 className="text-lg lg:text-xl font-bold">Cargo Tracking</h1>
                  <p className="text-xs lg:text-sm text-[var(--muted-foreground)] hidden sm:block">
                    Air cargo tracking system
                  </p>
                </div>
              </div>

              {/* Dark mode toggle */}
              <button
                onClick={() => setDarkMode(!darkMode)}
                className="p-2 rounded-lg hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                title={darkMode ? "Light mode" : "Dark mode"}
              >
                {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </button>

              {/* Tracking count badge for mobile */}
              {trackedAWBs.length > 0 && (
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="lg:hidden flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-medium"
                >
                  <span>{trackedAWBs.length}</span>
                  <span className="hidden xs:inline">shipments</span>
                </button>
              )}

              {/* Search form */}
              <div className="hidden sm:block">
                <TrackingForm onSubmit={handleTrack} onClear={handleClear} isLoading={isLoading} />
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
            {/* Top Row: Flight Radar + Dashboard Stats (side by side on lg) */}
            {trackedAWBs.length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                <FlightRadar trackedAWBs={trackedAWBs} onSelect={handleSelectFromSidebar} />
                <Dashboard trackedAWBs={trackedAWBs} />
              </div>
            )}

            {/* Loading State */}
            {showLoading && selectedAWB && (
              <div className="mb-6">
                <h2 className="text-sm font-medium text-[var(--muted-foreground)] mb-3 uppercase tracking-wide">
                  Procesando
                </h2>
                <LoadingCard awb={selectedAWB} />
              </div>
            )}

            {/* Error State */}
            {currentError && !showLoading && selectedAWB && (
              <div className="mb-6">
                <h2 className="text-sm font-medium text-[var(--muted-foreground)] mb-3 uppercase tracking-wide">
                  Error en Tracking
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
    </div>
  );
}

export default App;

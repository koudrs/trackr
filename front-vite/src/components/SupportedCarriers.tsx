import { Plane, Package, Search, ArrowRight } from "lucide-react";

interface CarrierInfo {
  name: string;
  iata: string;
  prefixes: string[];
}

const CARRIERS: CarrierInfo[] = [
  { name: "DHL Aviation", iata: "D0", prefixes: ["155", "423", "615", "936", "947", "992"] },
  { name: "Atlas Air", iata: "5Y", prefixes: ["369", "403"] },
  { name: "China Cargo", iata: "CK", prefixes: ["112", "781"] },
  { name: "MAS Air", iata: "M5", prefixes: ["865", "870"] },
  { name: "Turkish Cargo", iata: "TK", prefixes: ["235"] },
  { name: "Amerijet", iata: "M6", prefixes: ["810"] },
  { name: "AF/KLM Cargo", iata: "AF/KL", prefixes: ["057", "074", "129"] },
  { name: "IAG Cargo", iata: "IB/BA", prefixes: ["053", "060", "075", "125"] },
  { name: "LATAM Cargo", iata: "LA", prefixes: ["045"] },
];

export function SupportedCarriers() {
  return (
    <div className="space-y-4">
      {/* Welcome Card */}
      <div className="rounded-xl border border-[var(--border)]/60 bg-gradient-to-br from-blue-50 to-indigo-50 p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-full bg-blue-100">
            <Package className="h-6 w-6 text-blue-600" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-bold text-gray-900">Welcome to Cargo Tracking</h2>
            <p className="text-sm text-gray-600 mt-1">
              Real-time air cargo tracking system
            </p>
          </div>
        </div>

        {/* How it works */}
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="flex items-center gap-2 p-3 rounded-lg bg-white/70 border border-white">
            <div className="w-6 h-6 rounded-full bg-blue-500 text-white text-xs font-bold flex items-center justify-center">1</div>
            <span className="text-xs text-gray-700">Enter your AWB</span>
          </div>
          <div className="flex items-center gap-2 p-3 rounded-lg bg-white/70 border border-white">
            <div className="w-6 h-6 rounded-full bg-blue-500 text-white text-xs font-bold flex items-center justify-center">2</div>
            <span className="text-xs text-gray-700">Automatic tracking</span>
          </div>
          <div className="flex items-center gap-2 p-3 rounded-lg bg-white/70 border border-white">
            <div className="w-6 h-6 rounded-full bg-blue-500 text-white text-xs font-bold flex items-center justify-center">3</div>
            <span className="text-xs text-gray-700">Updates every 5 min</span>
          </div>
        </div>

        {/* AWB Format hint */}
        <div className="mt-4 p-3 rounded-lg bg-white/80 border border-blue-100">
          <div className="flex items-center gap-2 text-xs text-gray-600">
            <Search className="h-3.5 w-3.5 text-blue-500" />
            <span>AWB Format:</span>
            <code className="font-mono px-1.5 py-0.5 rounded bg-gray-100 text-gray-800">XXX-XXXXXXXX</code>
            <ArrowRight className="h-3 w-3 text-gray-400" />
            <span className="text-gray-500">Example: 057-12345678</span>
          </div>
        </div>
      </div>

      {/* Carriers Grid */}
      <div className="rounded-xl border border-[var(--border)]/60 bg-[var(--card)] shadow-sm overflow-hidden">
        <div className="p-4 border-b border-[var(--border)]/60 bg-[var(--muted)]/30">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Plane className="h-4 w-4 text-blue-500" />
              Supported Airlines
            </h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
              {CARRIERS.length} carriers
            </span>
          </div>
        </div>
        <div className="p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {CARRIERS.map((carrier) => (
              <div
                key={carrier.name}
                className="flex items-center justify-between p-2.5 rounded-lg border border-[var(--border)]/40 bg-[var(--muted)]/20 hover:bg-[var(--muted)]/40 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">
                    {carrier.iata}
                  </span>
                  <span className="text-xs font-medium">{carrier.name}</span>
                </div>
                <div className="flex gap-1 flex-wrap justify-end">
                  {carrier.prefixes.slice(0, 3).map((prefix) => (
                    <span
                      key={prefix}
                      className="font-mono text-[10px] px-1.5 py-0 rounded border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)]"
                    >
                      {prefix}
                    </span>
                  ))}
                  {carrier.prefixes.length > 3 && (
                    <span className="text-[10px] text-[var(--muted-foreground)]">
                      +{carrier.prefixes.length - 3}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

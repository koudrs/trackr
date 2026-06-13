import { useEffect, useState } from "react";
import { Cloud, CloudRain, CloudSnow, Sun, CloudLightning, CloudFog } from "lucide-react";

/** World clocks + Panama weather, shown top-right on the radar.
    All cargo schedules are GMT-5, but showing key timezones helps read the map. */

interface Zone {
  label: string;
  tz: string; // IANA timezone
  flag: string; // emoji flag
  lat: number;
  lon: number;
}

// Panama is the hub (shown first/highlighted). The rest are key cargo lanes and
// stops on the network (China origin, Alaska/Miami/Mexico transit, Europe + IST).
// Real cargo-lane stops (transit points), not final destinations. Central America
// is omitted on purpose — it shares Panama's timezone, so it adds nothing.
const ZONES: Zone[] = [
  { label: "Panama", tz: "America/Panama", flag: "🇵🇦", lat: 8.98, lon: -79.52 },
  { label: "Shanghai", tz: "Asia/Shanghai", flag: "🇨🇳", lat: 31.23, lon: 121.47 },
  { label: "Hong Kong", tz: "Asia/Hong_Kong", flag: "🇭🇰", lat: 22.31, lon: 113.91 },
  { label: "Anchorage", tz: "America/Anchorage", flag: "🇺🇸", lat: 61.17, lon: -150.0 },
  { label: "Honolulu", tz: "Pacific/Honolulu", flag: "🇺🇸", lat: 21.32, lon: -157.92 },
  { label: "Los Angeles", tz: "America/Los_Angeles", flag: "🇺🇸", lat: 33.94, lon: -118.41 },
  { label: "Miami", tz: "America/New_York", flag: "🇺🇸", lat: 25.79, lon: -80.29 },
  { label: "Mexico City", tz: "America/Mexico_City", flag: "🇲🇽", lat: 19.43, lon: -99.13 },
  { label: "Istanbul", tz: "Europe/Istanbul", flag: "🇹🇷", lat: 41.0, lon: 28.98 },
  { label: "Paris", tz: "Europe/Paris", flag: "🇫🇷", lat: 49.01, lon: 2.55 },
  { label: "Madrid", tz: "Europe/Madrid", flag: "🇪🇸", lat: 40.47, lon: -3.56 },
  { label: "Amsterdam", tz: "Europe/Amsterdam", flag: "🇳🇱", lat: 52.31, lon: 4.76 },
];

function timeIn(tz: string, now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
}

type Wx = { temp: number; code: number };

/** A clock row for a secondary timezone with its current weather (widescreen TV). */
function ClockRow({ zone, now, wx }: { zone: Zone; now: Date; wx?: Wx }) {
  const icon = wx ? weatherIcon(wx.code) : null;
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="flex items-center gap-2 text-sm text-[var(--muted-foreground)] whitespace-nowrap">
        <span className="text-lg">{zone.flag}</span>
        {zone.label}
      </span>
      <span className="flex items-center gap-2">
        {icon && wx && (
          <span className="flex items-center gap-0.5 text-xs text-[var(--muted-foreground)]">
            <icon.Icon className="w-3.5 h-3.5 text-amber-400" />
            {wx.temp}°
          </span>
        )}
        <span className="tabular-nums text-lg font-bold text-[var(--foreground)] w-12 text-right">
          {timeIn(zone.tz, now)}
        </span>
      </span>
    </div>
  );
}

// Open-Meteo WMO weather codes -> icon + label.
function weatherIcon(code: number) {
  if (code === 0) return { Icon: Sun, label: "Clear" };
  if (code <= 3) return { Icon: Cloud, label: "Cloudy" };
  if (code <= 48) return { Icon: CloudFog, label: "Fog" };
  if (code <= 67) return { Icon: CloudRain, label: "Rain" };
  if (code <= 77) return { Icon: CloudSnow, label: "Snow" };
  if (code <= 82) return { Icon: CloudRain, label: "Showers" };
  if (code <= 99) return { Icon: CloudLightning, label: "Storm" };
  return { Icon: Cloud, label: "—" };
}

/** Vertical info rail on the right: Panama (hub) headlined with its weather +
    local time, then the other key timezones listed below. */
export function RadarInfoBar() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000 * 30);
    return () => clearInterval(id);
  }, []);
  const weather = useWeather(); // weather[i] aligns with ZONES[i]

  const panama = ZONES[0];
  const rest = ZONES.slice(1);
  const panamaWx = weather[0];
  const wx = panamaWx ? weatherIcon(panamaWx.code) : null;

  return (
    <div className="radar-in-right radar-hud absolute top-4 right-4 z-[440] w-72 rounded-2xl overflow-hidden">
      {/* Panama hub headline */}
      <div className="px-5 py-4 bg-gradient-to-b from-amber-500/10 to-transparent border-b border-[var(--border)]">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-amber-400 font-bold">
          <span className="text-lg">{panama.flag}</span> Panama Hub
        </div>
        <div className="mt-2 flex items-end justify-between">
          <span className="tabular-nums text-5xl font-extrabold text-[var(--foreground)] leading-none">
            {timeIn(panama.tz, now)}
          </span>
          {panamaWx && wx && (
            <div className="flex items-center gap-1.5">
              <wx.Icon className="w-7 h-7 text-amber-400" />
              <span className="text-2xl font-bold tabular-nums text-[var(--foreground)]">{panamaWx.temp}°</span>
            </div>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--muted-foreground)]">
          <span>GMT-5 · all cargo times</span>
          {panamaWx && wx && <span>{wx.label}</span>}
        </div>
      </div>

      {/* Other timezones + their weather (scrolls if the list is long) */}
      <div className="px-5 py-2 divide-y divide-[var(--border)]/60 max-h-[55vh] overflow-y-auto">
        {rest.map((z, i) => <ClockRow key={z.tz} zone={z} now={now} wx={weather[i + 1]} />)}
      </div>
    </div>
  );
}

/** Open-Meteo current weather for ALL zones in one request (free, no key).
    Returns an array aligned with ZONES (undefined entries until loaded). */
function useWeather(): (Wx | undefined)[] {
  const [data, setData] = useState<(Wx | undefined)[]>([]);
  useEffect(() => {
    let alive = true;
    const lats = ZONES.map((z) => z.lat).join(",");
    const lons = ZONES.map((z) => z.lon).join(",");
    const fetchWx = () => {
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=temperature_2m,weather_code`)
        .then((r) => r.json())
        .then((j) => {
          if (!alive) return;
          // Multi-location returns an array; single returns an object.
          const arr = Array.isArray(j) ? j : [j];
          setData(arr.map((loc) => loc?.current
            ? { temp: Math.round(loc.current.temperature_2m), code: loc.current.weather_code }
            : undefined));
        })
        .catch(() => { /* best-effort */ });
    };
    fetchWx();
    const id = setInterval(fetchWx, 10 * 60 * 1000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return data;
}

import { useEffect, useState } from "react";
import { Cloud, CloudRain, CloudSnow, Sun, CloudLightning, CloudFog } from "lucide-react";

/** World clocks + Panama weather, shown top-right on the radar.
    All cargo schedules are GMT-5, but showing key timezones helps read the map. */

interface Zone {
  label: string;
  tz: string; // IANA timezone
  flag: string; // emoji flag
}

// Panama is the hub (shown first/highlighted). The rest are key cargo lanes and
// stops on the network (China origin, Alaska/Miami/Mexico transit, Europe + IST).
const ZONES: Zone[] = [
  { label: "Panama", tz: "America/Panama", flag: "🇵🇦" },
  { label: "China", tz: "Asia/Shanghai", flag: "🇨🇳" },
  { label: "Alaska", tz: "America/Anchorage", flag: "🇺🇸" },
  { label: "USA (MIA)", tz: "America/New_York", flag: "🇺🇸" },
  { label: "Mexico", tz: "America/Mexico_City", flag: "🇲🇽" },
  { label: "Amsterdam", tz: "Europe/Amsterdam", flag: "🇳🇱" },
  { label: "Paris", tz: "Europe/Paris", flag: "🇫🇷" },
  { label: "Turkey", tz: "Europe/Istanbul", flag: "🇹🇷" },
];

function timeIn(tz: string, now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
}

/** A clock row for a secondary timezone (sized for a widescreen TV). */
function ClockRow({ zone, now }: { zone: Zone; now: Date }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="flex items-center gap-2 text-sm text-[var(--muted-foreground)] whitespace-nowrap">
        <span className="text-lg">{zone.flag}</span>
        {zone.label}
      </span>
      <span className="tabular-nums text-lg font-bold text-[var(--foreground)]">
        {timeIn(zone.tz, now)}
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
  const weather = useWeather();

  const panama = ZONES[0];
  const rest = ZONES.slice(1);
  const wx = weather ? weatherIcon(weather.code) : null;

  return (
    <div className="radar-hud absolute top-4 right-4 z-[440] w-72 rounded-2xl overflow-hidden">
      {/* Panama hub headline */}
      <div className="px-5 py-4 bg-gradient-to-b from-sky-500/15 to-transparent border-b border-[var(--border)]">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-sky-400 font-bold">
          <span className="text-lg">{panama.flag}</span> Panama Hub
        </div>
        <div className="mt-2 flex items-end justify-between">
          <span className="tabular-nums text-5xl font-extrabold text-[var(--foreground)] leading-none">
            {timeIn(panama.tz, now)}
          </span>
          {weather && wx && (
            <div className="flex items-center gap-1.5">
              <wx.Icon className="w-7 h-7 text-sky-400" />
              <span className="text-2xl font-bold tabular-nums text-[var(--foreground)]">{weather.temp}°</span>
            </div>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--muted-foreground)]">
          <span>GMT-5 · all cargo times</span>
          {weather && wx && <span>{wx.label}</span>}
        </div>
      </div>

      {/* Other timezones */}
      <div className="px-5 py-2 divide-y divide-[var(--border)]/60">
        {rest.map((z) => <ClockRow key={z.tz} zone={z} now={now} />)}
      </div>
    </div>
  );
}

/** Open-Meteo current weather for Panama (free, no key). */
function useWeather(): { temp: number; code: number } | null {
  const [data, setData] = useState<{ temp: number; code: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const fetchWx = () => {
      fetch("https://api.open-meteo.com/v1/forecast?latitude=8.98&longitude=-79.52&current=temperature_2m,weather_code")
        .then((r) => r.json())
        .then((j) => { if (alive && j.current) setData({ temp: Math.round(j.current.temperature_2m), code: j.current.weather_code }); })
        .catch(() => { /* best-effort */ });
    };
    fetchWx();
    const id = setInterval(fetchWx, 10 * 60 * 1000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return data;
}

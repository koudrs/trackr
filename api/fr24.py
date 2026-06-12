"""FlightRadar24 API integration (Explorer plan).

Provides live aircraft positions and the real flown track for a flight, used as
the PRIMARY source for the live cargo radar. Falls back to airplanes.live in
api/main.py when FR24 is unavailable / out of quota.

Auth: HTTP header `Authorization: Bearer <FR24_API_TOKEN>` + `Accept-Version: v1`
(confirmed by the API's own error message). Token format is `<id>|<secret>`.

We normalize FR24's response to the SAME dict shape the rest of the code already
expects from airplanes.live, so callers don't care which source produced it:
    {flight, hex, r, t, desc, lat, lon, track, gs, alt_baro, baro_rate, seen_pos}
"""

import logging
import os
import time

import httpx

logger = logging.getLogger(__name__)

FR24_BASE = "https://fr24api.flightradar24.com/api"
FR24_TOKEN = os.getenv("FR24_API_TOKEN", "")

_TTL = 8.0
_pos_cache: dict[str, tuple[float, list[dict]]] = {}
_track_cache: dict[str, tuple[float, list[list[float]]]] = {}


def fr24_enabled() -> bool:
    return bool(FR24_TOKEN)


def _headers() -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Accept-Version": "v1",
        "Authorization": f"Bearer {FR24_TOKEN}",
    }


def _normalize(item: dict) -> dict | None:
    """Map an FR24 flight-position object to the shared aircraft dict shape.

    FR24 'full' fields: fr24_id, flight, callsign, lat, lon, track, alt, gspeed,
    vspeed, squawk, timestamp, source, hex, type, reg, painted_as, operating_as,
    orig_iata, dest_iata, eta. We keep what the radar uses.
    """
    lat, lon = item.get("lat"), item.get("lon")
    if lat is None or lon is None:
        return None
    callsign = (item.get("callsign") or item.get("flight") or "").strip()
    return {
        "fr24_id": item.get("fr24_id"),
        "flight": callsign,
        "hex": item.get("hex"),
        "r": item.get("reg"),
        "t": item.get("type"),
        "desc": item.get("type"),  # FR24 gives ICAO type code; no long desc
        "lat": float(lat),
        "lon": float(lon),
        "track": item.get("track"),
        "gs": item.get("gspeed"),
        "alt_baro": item.get("alt"),
        "baro_rate": item.get("vspeed"),
        "seen_pos": 0.0,
        "orig_iata": item.get("orig_iata"),
        "dest_iata": item.get("dest_iata"),
        "eta": item.get("eta"),
    }


async def fetch_positions_by_callsigns(callsigns: list[str]) -> list[dict]:
    """Live positions for the given callsigns via FR24 'flight-positions/full'.

    FR24 supports filtering by `callsigns` (comma-separated). Returns the shared
    normalized aircraft-dict shape. Raises on HTTP error so the caller can fall
    back to another source.
    """
    if not callsigns or not FR24_TOKEN:
        return []
    key = ",".join(sorted(callsigns))
    now = time.monotonic()
    cached = _pos_cache.get(key)
    if cached and (now - cached[0]) < _TTL:
        return cached[1]

    url = f"{FR24_BASE}/live/flight-positions/full"
    params = {"callsigns": key}
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url, params=params, headers=_headers())
        resp.raise_for_status()
        body = resp.json()
    raw = body.get("data", []) if isinstance(body, dict) else []
    out = [n for n in (_normalize(it) for it in raw) if n]
    _pos_cache[key] = (now, out)
    return out


async def fetch_track(fr24_id: str) -> list[list[float]]:
    """Real flown track (path) of a flight as [[lng, lat], ...].

    FR24 'flight-tracks?flight_id=<fr24_id>' returns the recorded trajectory.
    Cached briefly. Returns [] on any failure (track is a nice-to-have).
    """
    if not fr24_id or not FR24_TOKEN:
        return []
    now = time.monotonic()
    cached = _track_cache.get(fr24_id)
    if cached and (now - cached[0]) < _TTL:
        return cached[1]
    try:
        url = f"{FR24_BASE}/flight-tracks"
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, params={"flight_id": fr24_id}, headers=_headers())
            resp.raise_for_status()
            body = resp.json()
        # Response is a list with a "tracks" array of points {lat, lon, ...}.
        tracks: list[dict] = []
        if isinstance(body, list) and body:
            tracks = body[0].get("tracks", []) or []
        elif isinstance(body, dict):
            tracks = body.get("tracks", []) or []
        path = [
            [float(p["lon"]), float(p["lat"])]
            for p in tracks
            if p.get("lat") is not None and p.get("lon") is not None
        ]
        _track_cache[fr24_id] = (now, path)
        return path
    except Exception as e:
        logger.warning(f"FR24 track fetch failed for {fr24_id}: {e}")
        return []

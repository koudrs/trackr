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

import asyncio
import logging
import os
import time
from datetime import datetime, timedelta

import httpx

logger = logging.getLogger(__name__)

FR24_BASE = "https://fr24api.flightradar24.com/api"
FR24_TOKEN = os.getenv("FR24_API_TOKEN", "")

# CREDIT BUDGET — flight-tracks costs ~40 credits/call, the expensive part. We
# cache aggressively: a position only needs re-fetching every few minutes since
# the frontend dead-reckons (interpolates) smoothly between updates for free.
_SUMMARY_TTL = 600.0   # 10 min — route/fr24_id/hex barely change mid-flight
_TRACK_TTL = 300.0     # 5 min — the costly flight-tracks; interpolation fills gaps
_summary_cache: dict[str, tuple[float, list[dict]]] = {}
_track_pts_cache: dict[str, tuple[float, list[dict]]] = {}
# Per-fr24_id lock so two concurrent callers (poll vs. click, or multiple kiosk
# viewers) don't BOTH miss the cache and each pay the ~40-credit flight-tracks
# call for the same flight. Mirrors the _guias_lock guard on the scraping path.
_track_locks: dict[str, asyncio.Lock] = {}


def fr24_enabled() -> bool:
    return bool(FR24_TOKEN)


def _headers() -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Accept-Version": "v1",
        "Authorization": f"Bearer {FR24_TOKEN}",
        # IMPORTANT: without a User-Agent, Cloudflare in front of fr24api returns
        # a 403 "planned maintenance" page (a disguised block), not real data.
        "User-Agent": "KoudrsTracking/0.1 (+https://koudrs.com)",
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


async def _flight_summaries(flight_numbers: list[str], day_iso: str) -> list[dict]:
    """Look up flights by IATA flight number via flight-summary (cheap, ~1 credit,
    one request for MANY flights). Cached 10 min — fr24_id/hex/route don't change
    mid-flight. Crucially this DOES return cargo flights (unlike live positions).

    Uses a 2-DAY window (yesterday 00:00 -> today 23:59 UTC) so long-haul cargo
    that departed yesterday and crosses UTC midnight (e.g. PVG->IST) is still
    found. `day_iso` is today's date (YYYY-MM-DD, UTC).
    """
    if not flight_numbers or not FR24_TOKEN:
        return []
    key = ",".join(sorted(set(flight_numbers))) + "|" + day_iso
    now = time.monotonic()
    cached = _summary_cache.get(key)
    if cached and (now - cached[0]) < _SUMMARY_TTL:
        return cached[1]

    today = datetime.strptime(day_iso, "%Y-%m-%d")
    yesterday = today - timedelta(days=1)
    params = {
        "flights": ",".join(sorted(set(flight_numbers))),
        "flight_datetime_from": f"{yesterday:%Y-%m-%d}T00:00:00Z",
        "flight_datetime_to": f"{today:%Y-%m-%d}T23:59:59Z",
    }
    url = f"{FR24_BASE}/flight-summary/light"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url, params=params, headers=_headers())
        resp.raise_for_status()
        body = resp.json()
    data = body.get("data", []) if isinstance(body, dict) else []
    _summary_cache[key] = (now, data)
    return data


async def _fetch_track_points(fr24_id: str) -> list[dict]:
    """Raw track points for a flight id. THIS IS THE EXPENSIVE CALL (~40 credits),
    so it's cached 5 min per flight — the frontend interpolates between updates.

    A per-fr24_id lock serializes concurrent misses so only ONE upstream call
    happens per flight per TTL window even if poll + click (or several viewers)
    race; the others await it and read the freshly-cached result for free.
    """
    cached = _track_pts_cache.get(fr24_id)
    if cached and (time.monotonic() - cached[0]) < _TRACK_TTL:
        return cached[1]

    lock = _track_locks.setdefault(fr24_id, asyncio.Lock())
    async with lock:
        # Double-check: a concurrent caller may have populated it while we waited.
        cached = _track_pts_cache.get(fr24_id)
        if cached and (time.monotonic() - cached[0]) < _TRACK_TTL:
            return cached[1]

        url = f"{FR24_BASE}/flight-tracks"
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, params={"flight_id": fr24_id}, headers=_headers())
            resp.raise_for_status()
            body = resp.json()
        if isinstance(body, list) and body:
            pts = body[0].get("tracks", []) or []
        elif isinstance(body, dict):
            pts = body.get("tracks", []) or []
        else:
            pts = []
        # Only cache a NON-empty result. A flight FR24 reports as airborne but
        # whose track hasn't populated yet returns []; caching that would hide it
        # for the full 5-min TTL. Skipping the store lets the next poll retry it
        # (still bounded: only confirmed-in-air flights reach this path).
        if pts:
            _track_pts_cache[fr24_id] = (time.monotonic(), pts)
        return pts


async def fetch_positions_by_flights(flight_numbers: list[str], day_iso: str) -> list[dict]:
    """Live positions for cargo flights via the 2-step FR24 flow:
    flight-summary (flight number -> fr24_id) -> flight-tracks (current pos + path).

    Returns the shared normalized aircraft-dict shape, with the latest track point
    as the live position and the full path as `trail` ([[lng,lat],...]). Only
    in-air flights (no landing time) are returned. Raises on HTTP error so the
    caller can fall back to another source.
    """
    if not flight_numbers or not FR24_TOKEN:
        return []
    # No outer cache needed: _flight_summaries (10 min) and _fetch_track_points
    # (5 min) each cache their expensive upstream calls, so re-running this within
    # those windows costs zero credits.

    summaries = await _flight_summaries(flight_numbers, day_iso)

    # DEDUP per IATA flight number before fetching tracks. The 2-day window means
    # a daily-cadence flight can return BOTH yesterday's and today's instance,
    # each with a distinct fr24_id. Without dedup, an ultra-long-haul still
    # airborne from yesterday could trigger TWO ~40-credit flight-tracks calls.
    # Prefer the single in-air instance (or the most recent by takeoff).
    by_flight: dict[str, list[dict]] = {}
    for s in summaries:
        if not s.get("fr24_id"):
            continue
        by_flight.setdefault(s.get("flight") or s["fr24_id"], []).append(s)
    deduped: list[dict] = []
    for rows in by_flight.values():
        in_air = [r for r in rows if not r.get("datetime_landed")]
        pool = in_air or rows
        deduped.append(max(pool, key=lambda r: r.get("datetime_takeoff") or ""))

    out: list[dict] = []
    for s in deduped:
        fr24_id = s.get("fr24_id")
        if not fr24_id:
            continue
        landed = bool(s.get("datetime_landed"))

        # CREDIT POLICY: only fetch the (expensive ~40-credit) flight-tracks
        # automatically for flights still IN THE AIR. Landed flights are returned
        # WITHOUT a trail — the frontend requests their historical track on demand
        # (click) via /api/flight-track/{fr24_id}, which is cached.
        trail: list[list[float]] = []
        last: dict = {}
        if not landed:
            try:
                tracks = await _fetch_track_points(fr24_id)
            except Exception as e:
                logger.warning(f"FR24 track fetch failed for {fr24_id}: {e}")
                tracks = []
            if tracks:
                trail = [
                    [float(p["lon"]), float(p["lat"])]
                    for p in tracks
                    if p.get("lat") is not None and p.get("lon") is not None
                ]
                if tracks[-1].get("lat") is not None and tracks[-1].get("lon") is not None:
                    last = tracks[-1]

        out.append({
            "fr24_id": fr24_id,
            "flight": s.get("flight"),               # IATA flight number (TK6593)
            "callsign": s.get("callsign") or s.get("flight"),
            "hex": s.get("hex"),
            "r": s.get("reg"),
            "t": s.get("type"),
            "desc": s.get("type"),
            "lat": float(last["lat"]) if last.get("lat") is not None else None,
            "lon": float(last["lon"]) if last.get("lon") is not None else None,
            "track": last.get("track"),
            "gs": last.get("gspeed"),
            "alt_baro": last.get("alt"),
            "baro_rate": last.get("vspeed"),
            "seen_pos": 0.0,
            "orig_iata": s.get("orig_iata"),
            "dest_iata": s.get("dest_iata"),
            "landed": landed,                        # frontend: pin at dest, track on click
            "trail": trail,                          # real flown path (empty if landed)
        })
    return out


async def fetch_track(fr24_id: str) -> list[list[float]]:
    """Real flown track of a flight as [[lng, lat], ...], for the on-click overlay.

    Reuses _fetch_track_points' 5-min cache: if the polling loop already pulled
    this flight's track recently, clicking it costs ZERO extra credits.
    """
    if not fr24_id or not FR24_TOKEN:
        return []
    try:
        pts = await _fetch_track_points(fr24_id)
    except Exception as e:
        logger.warning(f"FR24 track fetch failed for {fr24_id}: {e}")
        return []
    return [
        [float(p["lon"]), float(p["lat"])]
        for p in pts
        if p.get("lat") is not None and p.get("lon") is not None
    ]

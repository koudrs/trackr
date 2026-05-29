"""FastAPI backend for AWB tracking."""

import asyncio
import logging
import os
import re
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime, UTC
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from api.airlines import callsign_candidates
from api.airports import DEMO_ROUTES, get_airport, haversine_nm
from api.carriers import get_carrier, list_carriers
from api.models import FlightPosition, FlightPositionList, TrackingError, TrackingResult

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

# Static files directory (Vite build output)
STATIC_DIR = Path(__file__).parent.parent / "front-vite" / "dist"

# AWB format: XXX-XXXXXXXX (3 digits - 8 digits)
AWB_PATTERN = re.compile(r"^(\d{3})-?(\d{8})$")

# Version info
VERSION = "0.1.0"
START_TIME: datetime | None = None


class HealthStatus(BaseModel):
    """Health check response model."""

    status: str
    service: str
    version: str
    uptime_seconds: float
    carriers_loaded: int
    prefixes_supported: int


class CarrierHealth(BaseModel):
    """Individual carrier health status."""

    name: str
    prefix: str
    status: str
    response_time_ms: float | None = None
    error: str | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    global START_TIME
    START_TIME = datetime.now()

    # Startup
    carriers = list_carriers()
    total_prefixes = sum(len(c["prefixes"]) for c in carriers)
    print(f"KoudrsTracking API v{VERSION} starting...")
    print(f"Loaded {len(carriers)} carriers with {total_prefixes} prefixes:")
    for c in carriers:
        print(f"  - {c['name']} ({c['iata_code']}): {c['prefixes']}")
    yield
    # Shutdown
    print("KoudrsTracking API shutting down...")


app = FastAPI(
    title="KoudrsTracking API",
    description="Air cargo AWB tracking across multiple carriers",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS - allow all origins for now (open API)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Note: Static files are served by the catch-all route at the bottom


@app.get("/api", response_model=HealthStatus)
@app.get("/api/", response_model=HealthStatus)
async def root() -> HealthStatus:
    """Health check endpoint."""
    carriers = list_carriers()
    total_prefixes = sum(len(c["prefixes"]) for c in carriers)
    uptime = (datetime.now() - START_TIME).total_seconds() if START_TIME else 0

    return HealthStatus(
        status="ok",
        service="KoudrsTracking",
        version=VERSION,
        uptime_seconds=uptime,
        carriers_loaded=len(carriers),
        prefixes_supported=total_prefixes,
    )


@app.get("/api/health")
async def health_check():
    """Simple health check for load balancers/monitoring."""
    return {"status": "healthy"}


@app.get("/api/health/carriers")
async def carriers_health() -> dict:
    """
    Check health of all carrier integrations.

    Tests a sample AWB for each carrier to verify connectivity.
    """
    # Sample AWBs for testing (use known format, may return no data but shouldn't error)
    test_awbs = {
        "810": "00000001",  # Amerijet
        "235": "00000001",  # Turkish
        "369": "00000001",  # Atlas
        "112": "00000001",  # China Cargo
        "074": "00000001",  # AFKL
        "865": "00000001",  # SmartKargo/MAS
        "936": "00000001",  # DHL Aviation
        "125": "00000001",  # IAG
    }

    results = []

    async def check_carrier(prefix: str, serial: str) -> CarrierHealth:
        carrier = get_carrier(prefix)
        if not carrier:
            return CarrierHealth(
                name="Unknown",
                prefix=prefix,
                status="error",
                error="Carrier not found",
            )

        start = datetime.now()
        try:
            await asyncio.wait_for(carrier.track(prefix, serial), timeout=30)
            elapsed = (datetime.now() - start).total_seconds() * 1000
            return CarrierHealth(
                name=carrier.name,
                prefix=prefix,
                status="ok",
                response_time_ms=round(elapsed, 2),
            )
        except asyncio.TimeoutError:
            return CarrierHealth(
                name=carrier.name,
                prefix=prefix,
                status="timeout",
                error="Request timed out after 30s",
            )
        except Exception as e:
            elapsed = (datetime.now() - start).total_seconds() * 1000
            return CarrierHealth(
                name=carrier.name,
                prefix=prefix,
                status="error",
                response_time_ms=round(elapsed, 2),
                error=str(e)[:100],
            )

    # Run all health checks in parallel
    tasks = [check_carrier(prefix, serial) for prefix, serial in test_awbs.items()]
    results = await asyncio.gather(*tasks)

    healthy = sum(1 for r in results if r.status == "ok")
    total = len(results)

    return {
        "summary": {
            "healthy": healthy,
            "total": total,
            "status": "healthy" if healthy == total else "degraded" if healthy > 0 else "unhealthy",
        },
        "carriers": [r.model_dump() for r in results],
    }


@app.get("/api/carriers")
async def get_carriers():
    """List all supported carriers."""
    return {"carriers": list_carriers()}


@app.get(
    "/api/track/{awb}",
    response_model=TrackingResult,
    responses={
        400: {"model": TrackingError, "description": "Invalid AWB format"},
        404: {"model": TrackingError, "description": "Carrier not supported"},
        502: {"model": TrackingError, "description": "Carrier API error"},
    },
)
async def track_awb(awb: str) -> TrackingResult:
    """
    Track an air waybill.

    Args:
        awb: AWB number in format XXX-XXXXXXXX or XXXXXXXXXXX (11 digits)

    Returns:
        TrackingResult with shipment status and events
    """
    # Parse and validate AWB
    match = AWB_PATTERN.match(awb)
    if not match:
        raise HTTPException(
            status_code=400,
            detail={
                "awb": awb,
                "error": "Invalid AWB format. Expected XXX-XXXXXXXX (e.g., 810-50671456)",
            },
        )

    prefix, serial = match.groups()

    # Find carrier for this prefix
    carrier = get_carrier(prefix)
    if not carrier:
        raise HTTPException(
            status_code=404,
            detail={
                "awb": f"{prefix}-{serial}",
                "error": f"Carrier with prefix {prefix} not supported",
                "suggestion": "Check /carriers for supported airlines",
            },
        )

    # Call carrier API
    try:
        logger.info(f"Tracking AWB {prefix}-{serial} via {carrier.name}")
        result = await carrier.track(prefix, serial)
        logger.info(f"Tracking result for {prefix}-{serial}: origin={result.origin}, dest={result.destination}, events={len(result.events)}")
        return result
    except Exception as e:
        logger.error(f"Tracking error for {prefix}-{serial}: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=502,
            detail={
                "awb": f"{prefix}-{serial}",
                "error": f"Carrier API error: {str(e)}",
                "carrier": carrier.name,
            },
        )


# --- Live flight tracking (airplanes.live ADS-B proxy) ---------------------
# airplanes.live is free, no key, 1 req/sec. We batch all requested callsigns
# into ONE upstream request and cache it briefly so the radar can poll often
# without exhausting the rate limit (verified: /v2/callsign/CS1,CS2 returns both).
AIRPLANES_LIVE_BASE = "https://api.airplanes.live/v2/callsign/"
_FLIGHTS_TTL = 8.0  # seconds to cache an upstream response
_FLIGHTS_CACHE: dict[str, tuple[float, list[dict]]] = {}
_MAX_CALLSIGNS = 160  # keep the upstream URL bounded (airplanes.live allows long batched URLs)


def _to_float(value) -> float | None:
    """alt_baro/gs/track may be numbers, strings, or the literal 'ground'."""
    if value is None or isinstance(value, str):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


async def _fetch_airplanes_live(callsigns: list[str]) -> list[dict]:
    """Fetch raw aircraft state for a set of callsigns, with a short TTL cache."""
    if not callsigns:
        return []
    key = ",".join(sorted(callsigns))
    now = time.monotonic()
    cached = _FLIGHTS_CACHE.get(key)
    if cached and (now - cached[0]) < _FLIGHTS_TTL:
        return cached[1]

    url = AIRPLANES_LIVE_BASE + key
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        resp = await client.get(url, headers={"User-Agent": "KoudrsTracking/0.1 (+https://koudrs.com)"})
        resp.raise_for_status()
        data = resp.json()
    aircraft = data.get("ac", []) if isinstance(data, dict) else []
    _FLIGHTS_CACHE[key] = (now, aircraft)
    return aircraft


async def _demo_flights() -> FlightPositionList:
    """TEMPORARY demo: sample REAL airborne aircraft along this tool's cargo
    corridors (CGO->PTY, HKG->MIA, ...), so the radar shows planes on the kinds
    of routes the dashboard cares about. Remove when done.

    For each route we query a circle at the route midpoint and keep aircraft
    whose great-circle distance to the destination is shrinking (roughly headed
    that way). Each is enriched with that route's origin/destination + ETA.
    """
    positions: list[FlightPosition] = []
    seen_hex: set[str] = set()

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        for origin, dest in DEMO_ROUTES:
            o, d = get_airport(origin), get_airport(dest)
            if not o or not d:
                continue
            mid_lat, mid_lng = (o[0] + d[0]) / 2, (o[1] + d[1]) / 2
            url = f"https://api.airplanes.live/v2/point/{mid_lat:.3f}/{mid_lng:.3f}/250"
            try:
                resp = await client.get(url, headers={"User-Agent": "KoudrsTracking/0.1 (+https://koudrs.com)"})
                resp.raise_for_status()
                aircraft = resp.json().get("ac", [])
            except Exception as e:
                logger.warning(f"demo route {origin}->{dest} fetch failed: {e}")
                continue

            route_dist = haversine_nm(o[0], o[1], d[0], d[1])
            kept = 0
            for ac in aircraft:
                if kept >= 6:  # a few per route is plenty
                    break
                callsign = (ac.get("flight") or "").strip()
                lat, lng = ac.get("lat"), ac.get("lon")
                hx = ac.get("hex")
                if not callsign or lat is None or lng is None or hx in seen_hex:
                    continue
                # Keep aircraft that are closer to the destination than the full
                # route length (i.e. plausibly mid-route on this lane).
                if haversine_nm(float(lat), float(lng), d[0], d[1]) > route_dist:
                    continue
                seen_hex.add(hx)
                kept += 1
                alt_raw = ac.get("alt_baro")
                gs = _to_float(ac.get("gs"))
                route = _enrich_route(float(lat), float(lng), gs, {"origin": origin, "destination": dest, "dep": None})
                positions.append(
                    FlightPosition(
                        callsign=callsign, flight=callsign, awb=f"DEMO:{callsign}",
                        hex=hx, registration=(ac.get("r") or "").strip() or None,
                        aircraft_type=(ac.get("t") or "").strip() or None,
                        aircraft_desc=(ac.get("desc") or "").strip() or None,
                        lat=float(lat), lng=float(lng),
                        track=_to_float(ac.get("track")), ground_speed=gs,
                        altitude=_to_float(alt_raw), vertical_rate=_to_float(ac.get("baro_rate")),
                        on_ground=(alt_raw == "ground"), seen_pos=_to_float(ac.get("seen_pos")),
                        **route,
                    )
                )

    return FlightPositionList(flights=positions, requested=len(positions), matched=len(positions))


def _enrich_route(lat: float, lng: float, gs: float | None, meta: dict) -> dict:
    """Combine the live position with the shipment's route + DEP time to derive
    distance-to-go, % progress, ETA (estimate = remaining / speed), and time aloft.

    All fields are optional — if we don't know the airports we just skip them.
    """
    out: dict = {
        "origin": meta.get("origin"),
        "destination": meta.get("destination"),
    }
    o = get_airport(meta.get("origin"))
    d = get_airport(meta.get("destination"))

    if d:
        remaining = haversine_nm(lat, lng, d[0], d[1])
        out["distance_remaining_nm"] = round(remaining, 1)
        if o:
            total = haversine_nm(o[0], o[1], d[0], d[1])
            if total > 0:
                pct = max(0.0, min(100.0, (1 - remaining / total) * 100))
                out["distance_flown_pct"] = round(pct, 1)
        if gs and gs > 50:  # avoid divide-by-near-zero on the ground
            out["eta_minutes"] = round(remaining / gs * 60, 0)

    dep = meta.get("dep")
    if dep is not None:
        elapsed = (datetime.now(UTC) - dep).total_seconds() / 60
        if elapsed >= 0:
            out["flight_minutes"] = round(elapsed, 0)

    return out


@app.get("/api/flights", response_model=FlightPositionList)
async def get_flights(
    flights: str = Query(
        "",
        description="Comma-separated 'AWB:FLIGHT' tokens, e.g. 230-12345678:CM473,045-11112222:LA8074",
    ),
    demo: bool = Query(False, description="TEMPORARY: return real airborne aircraft for a live demo"),
) -> FlightPositionList:
    """
    Return live aircraft positions for the given tracked flights.

    The frontend derives in-transit flight numbers from the AWBs it already
    tracks (events[].flight) and passes them here as AWB:FLIGHT pairs. We map
    each IATA flight number to candidate ICAO callsigns, query airplanes.live
    once, and return the matched positions. Flights not currently airborne /
    in ADS-B coverage are simply omitted (no error).
    """
    if demo:
        return await _demo_flights()

    # Parse "AWB:FLIGHT[:ORIGIN:DEST:DEP_ISO]" tokens. The AWB has a hyphen, never
    # a colon, so colon is a safe field separator. Route + DEP time come from the
    # shipment's own tracking data (the frontend already has them) and let us
    # derive distance-to-go / ETA / time-aloft.
    pairs: list[tuple[str | None, str]] = []
    meta: dict[str, dict] = {}  # awb -> {origin, destination, dep}
    for token in flights.split(","):
        token = token.strip()
        if not token:
            continue
        parts = token.split(":")
        awb = parts[0].strip() or None
        flight = parts[1].strip() if len(parts) > 1 else parts[0].strip()
        if awb:
            origin = parts[2].strip().upper() if len(parts) > 2 and parts[2].strip() else None
            dest = parts[3].strip().upper() if len(parts) > 3 and parts[3].strip() else None
            dep_iso = parts[4].strip() if len(parts) > 4 and parts[4].strip() else None
            dep_dt = None
            if dep_iso:
                try:
                    dep_dt = datetime.fromisoformat(dep_iso.replace("Z", "+00:00"))
                    if dep_dt.tzinfo is None:
                        dep_dt = dep_dt.replace(tzinfo=UTC)
                except ValueError:
                    dep_dt = None
            meta[awb] = {"origin": origin, "destination": dest, "dep": dep_dt}
        pairs.append((awb, flight))

    # Build candidate ICAO callsign -> (awb, flight) so we can match the
    # upstream response back to the shipment that asked for it.
    # A callsign can be claimed by several AWBs (cargo consolidations ride the
    # same physical flight), so map each callsign to a list of claimants.
    candidate_map: dict[str, list[tuple[str | None, str]]] = {}
    for awb, flight in pairs:
        # Derive the airline IATA code from the AWB prefix so flight numbers
        # that come without a prefix (just digits) can still be resolved.
        iata = None
        if awb and len(awb) >= 3:
            carrier = get_carrier(awb[:3])
            iata = carrier.iata_code if carrier else None
        for cand in callsign_candidates(flight, iata):
            candidate_map.setdefault(cand.upper(), []).append((awb, flight))

    all_callsigns = list(candidate_map.keys())
    if len(all_callsigns) > _MAX_CALLSIGNS:
        logger.warning(
            "flights: %d candidate callsigns from %d flights exceed cap %d; trailing flights dropped",
            len(all_callsigns), len(pairs), _MAX_CALLSIGNS,
        )
    callsigns = all_callsigns[:_MAX_CALLSIGNS]
    if not callsigns:
        return FlightPositionList(requested=len(pairs), matched=0)

    try:
        aircraft = await _fetch_airplanes_live(callsigns)
    except Exception as e:  # network/upstream error -> empty, never break the map
        logger.warning(f"airplanes.live fetch failed: {type(e).__name__}: {e}")
        return FlightPositionList(requested=len(pairs), matched=0)

    positions: list[FlightPosition] = []
    seen_awbs: set[str] = set()
    for ac in aircraft:
        callsign = (ac.get("flight") or "").strip()
        lat, lng = ac.get("lat"), ac.get("lon")
        if not callsign or lat is None or lng is None:
            continue
        claimants = candidate_map.get(callsign.upper())
        if not claimants:
            continue
        alt_raw = ac.get("alt_baro")
        common = dict(
            callsign=callsign,
            hex=ac.get("hex"),
            registration=(ac.get("r") or "").strip() or None,
            aircraft_type=(ac.get("t") or "").strip() or None,
            lat=float(lat),
            lng=float(lng),
            track=_to_float(ac.get("track")),
            ground_speed=_to_float(ac.get("gs")),
            altitude=_to_float(alt_raw),
            vertical_rate=_to_float(ac.get("baro_rate")),
            aircraft_desc=(ac.get("desc") or "").strip() or None,
            on_ground=(alt_raw == "ground"),
            seen_pos=_to_float(ac.get("seen_pos")),
        )
        # Emit one position per distinct AWB riding this aircraft, enriching each
        # with route geometry + timing derived from THAT shipment's metadata.
        for awb, flight in claimants:
            if awb and awb in seen_awbs:
                continue
            if awb:
                seen_awbs.add(awb)
            route = _enrich_route(
                lat=float(lat), lng=float(lng),
                gs=common["ground_speed"],
                meta=meta.get(awb or "", {}),
            )
            positions.append(FlightPosition(awb=awb, flight=flight, **common, **route))

    return FlightPositionList(
        flights=positions,
        fetched_at=datetime.now(UTC),
        requested=len(pairs),
        matched=len(positions),
    )


@app.get("/api/airports")
async def airports(codes: str = Query("", description="Comma-separated IATA codes")) -> dict:
    """Return {IATA: [lat, lng]} for known airports, so the frontend can draw
    route lines and at-airport pins. Unknown codes are omitted."""
    out: dict[str, list[float]] = {}
    for code in codes.split(","):
        c = code.strip().upper()
        coord = get_airport(c)
        if coord:
            out[c] = [coord[0], coord[1]]
    return {"airports": out}


@app.get("/{full_path:path}")
async def serve_spa(request: Request, full_path: str):
    """Serve frontend SPA for all non-API routes."""
    # Skip if static dir doesn't exist (dev mode)
    if not STATIC_DIR.exists():
        raise HTTPException(status_code=404, detail="Frontend not built")

    # Try to serve the exact file first (assets, vite.svg, etc.)
    file_path = STATIC_DIR / full_path
    if file_path.is_file() and file_path.resolve().is_relative_to(STATIC_DIR.resolve()):
        # Determine content type for common static files
        suffix = file_path.suffix.lower()
        media_types = {
            ".js": "application/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".ico": "image/x-icon",
            ".json": "application/json",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
        }
        media_type = media_types.get(suffix)
        return FileResponse(file_path, media_type=media_type)

    # Otherwise serve index.html (SPA routing)
    index_path = STATIC_DIR / "index.html"
    if index_path.exists():
        return FileResponse(index_path, media_type="text/html")

    raise HTTPException(status_code=404, detail="Not found")


def run_server():
    """Run the API server (for use as console script)."""
    import uvicorn

    uvicorn.run("api.main:app", host="0.0.0.0", port=8000, reload=True)


if __name__ == "__main__":
    run_server()

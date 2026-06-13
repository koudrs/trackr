"""Synthetic demo flights for the live cargo radar.

The previous demo sampled real airborne traffic near route midpoints, so it was
usually empty or showed random non-cargo planes. This builds GUARANTEED, good-
looking cargo flights along realistic China -> Panama lanes WITH stops, each
positioned somewhere along its route with coherent telemetry (great-circle
position, heading to the next waypoint, altitude, speed, % flown, ETA, and an
already-flown track for the neon contrail).

Deterministic per minute (uses a time bucket) so positions advance smoothly as
the radar polls, without real randomness.
"""

import math

from api.airports import get_airport, haversine_nm
from api.models import FlightPosition, FlightPositionList

# Real-ish cargo lanes China/Asia -> Panama/Americas, with stops. Each leg is a
# pair of IATA codes; the whole list of stops defines the journey.
DEMO_FLIGHTS: list[dict] = [
    {"callsign": "CKK201", "flight": "CK201", "awb": "112-20013344",
     "type": "B77L", "desc": "BOEING 777F", "stops": ["PVG", "ANC", "MIA", "PTY"], "progress": 0.62},
    {"callsign": "GTI8101", "flight": "5Y8101", "awb": "369-44551122",
     "type": "B744", "desc": "BOEING 747-400F", "stops": ["HKG", "ANC", "MIA"], "progress": 0.38},
    {"callsign": "AZG4471", "flight": "7L4471", "awb": "498-77882211",
     "type": "B748", "desc": "BOEING 747-8F", "stops": ["GYD", "IST", "PTY"], "progress": 0.74},
    {"callsign": "CLX7782", "flight": "CV7782", "awb": "172-99001122",
     "type": "B748", "desc": "BOEING 747-8F", "stops": ["CAN", "LUX", "BOG", "PTY"], "progress": 0.21},
    {"callsign": "CES201", "flight": "MU201", "awb": "781-33445566",
     "type": "B77L", "desc": "BOEING 777F", "stops": ["CGO", "IST", "PTY"], "progress": 0.50},
    {"callsign": "KAL271", "flight": "KE271", "awb": "180-22113344",
     "type": "B77L", "desc": "BOEING 777F", "stops": ["ICN", "ANC", "LAX", "MEX"], "progress": 0.87},
    {"callsign": "GTI091", "flight": "5Y091", "awb": "369-55667788",
     "type": "B744", "desc": "BOEING 747-400F", "stops": ["NRT", "ANC", "MIA"], "progress": 0.15},
    {"callsign": "QR8112", "flight": "QR8112", "awb": "157-66778899",
     "type": "B77L", "desc": "BOEING 777F", "stops": ["DOH", "LUX", "MIA", "PTY"], "progress": 0.44},
    {"callsign": "THY6451", "flight": "TK6451", "awb": "235-88990011",
     "type": "B77L", "desc": "BOEING 777F", "stops": ["IST", "CMN", "MIA", "PTY"], "progress": 0.33},
    {"callsign": "CSN461", "flight": "CZ461", "awb": "461-11223300",
     "type": "B77L", "desc": "BOEING 777F", "stops": ["CAN", "SZX", "ANC", "MIA"], "progress": 0.68},
]


def _interp_great_circle(a: tuple[float, float], b: tuple[float, float], f: float) -> tuple[float, float]:
    """Point at fraction f along the great circle from a to b. Returns (lat, lng)."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    d = 2 * math.asin(math.sqrt(
        math.sin((lat2 - lat1) / 2) ** 2 +
        math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    ))
    if d == 0:
        return a
    A = math.sin((1 - f) * d) / math.sin(d)
    B = math.sin(f * d) / math.sin(d)
    x = A * math.cos(lat1) * math.cos(lon1) + B * math.cos(lat2) * math.cos(lon2)
    y = A * math.cos(lat1) * math.sin(lon1) + B * math.cos(lat2) * math.sin(lon2)
    z = A * math.sin(lat1) + B * math.sin(lat2)
    return (math.degrees(math.atan2(z, math.sqrt(x * x + y * y))),
            math.degrees(math.atan2(y, x)))


def _bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Initial bearing (deg) from a to b."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlon = math.radians(b[1] - a[1])
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _build_one(spec: dict, time_phase: float) -> FlightPosition | None:
    """Place one demo flight along its multi-stop route at its current progress."""
    coords = [get_airport(s) for s in spec["stops"]]
    if any(c is None for c in coords):
        return None
    coords = [c for c in coords if c]  # type: ignore

    # Per-leg great-circle distances; total route length.
    leg_d = [haversine_nm(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
             for i in range(len(coords) - 1)]
    total = sum(leg_d) or 1.0

    # Animate: progress drifts forward a little with the time phase, wrapping.
    prog = (spec["progress"] + time_phase * 0.04) % 0.98 + 0.01
    target_nm = prog * total

    # Find which leg we're on and the fraction within it.
    acc = 0.0
    leg_idx, leg_frac = 0, 0.0
    for i, dist in enumerate(leg_d):
        if acc + dist >= target_nm:
            leg_idx = i
            leg_frac = (target_nm - acc) / dist if dist else 0.0
            break
        acc += dist
    else:
        leg_idx = len(leg_d) - 1
        leg_frac = 1.0

    a, b = coords[leg_idx], coords[leg_idx + 1]
    lat, lng = _interp_great_circle(a, b, leg_frac)
    heading = _bearing((lat, lng), b)

    # Build the already-flown track: all completed stops + current position.
    flown_pts = 18
    track: list[list[float]] = []
    done_nm = 0.0
    for i in range(leg_idx):
        # sample each completed leg
        for k in range(0, 6):
            p = _interp_great_circle(coords[i], coords[i + 1], k / 5)
            track.append([p[1], p[0]])
        done_nm += leg_d[i]
    for k in range(0, flown_pts + 1):
        p = _interp_great_circle(a, b, leg_frac * k / flown_pts)
        track.append([p[1], p[0]])

    remaining_nm = total - target_nm
    speed = 470.0  # kt, typical freighter cruise
    eta_min = remaining_nm / speed * 60
    origin, dest = spec["stops"][0], spec["stops"][-1]

    return FlightPosition(
        callsign=spec["callsign"], flight=spec["flight"], awb=f"DEMO:{spec['awb']}",
        fr24_id=None, hex=None, registration=None,
        aircraft_type=spec["type"], aircraft_desc=spec["desc"],
        lat=round(lat, 4), lng=round(lng, 4),
        track=round(heading, 1), ground_speed=speed,
        altitude=35000.0, vertical_rate=0.0, on_ground=False, seen_pos=0.0,
        origin=origin, destination=dest,
        distance_remaining_nm=round(remaining_nm, 1),
        distance_flown_pct=round(prog * 100, 1),
        eta_minutes=round(eta_min, 0), flight_minutes=round(target_nm / speed * 60, 0),
        trail=track,
    )


def build_demo(time_bucket: int) -> FlightPositionList:
    """Build all synthetic demo flights. time_bucket advances them smoothly."""
    phase = (time_bucket % 600) / 600.0  # 0..1 over 10 min
    flights = [f for f in (_build_one(s, phase) for s in DEMO_FLIGHTS) if f]
    return FlightPositionList(flights=flights, source="demo",
                              requested=len(flights), matched=len(flights))

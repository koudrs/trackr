"""IATA airport coordinates for cargo-route geometry (great-circle distance/ETA).

Only the airports that appear on the carriers/routes this tool tracks. Extend as
needed. Coordinates are (lat, lon) in degrees.
"""

from math import asin, cos, radians, sin, sqrt

AIRPORTS: dict[str, tuple[float, float]] = {
    # Asia
    "HKG": (22.308, 113.915),   # Hong Kong
    "PVG": (31.143, 121.805),   # Shanghai Pudong
    "CGO": (34.520, 113.841),   # Zhengzhou
    "ICN": (37.469, 126.451),   # Seoul Incheon
    "CAN": (23.392, 113.299),   # Guangzhou
    "PEK": (40.080, 116.585),   # Beijing
    "SZX": (22.639, 113.811),   # Shenzhen
    "TPE": (25.078, 121.234),   # Taipei
    "NRT": (35.765, 140.386),   # Tokyo Narita
    # Middle East / Caucasus
    "GYD": (40.467, 50.047),    # Baku (Silk Way)
    "IST": (41.262, 28.728),    # Istanbul
    "DOH": (25.273, 51.608),    # Doha
    "DXB": (25.253, 55.364),    # Dubai
    # Europe
    "AMS": (52.309, 4.764),     # Amsterdam
    "CDG": (49.010, 2.548),     # Paris CDG
    "LUX": (49.627, 6.211),     # Luxembourg (Cargolux)
    "LHR": (51.470, -0.454),    # London Heathrow
    "FRA": (50.037, 8.562),     # Frankfurt
    # Americas
    "ANC": (61.174, -149.996),  # Anchorage (classic transpacific cargo stop)
    "CMN": (33.367, -7.590),    # Casablanca (Morocco)
    "MIA": (25.793, -80.290),   # Miami
    "PTY": (9.071, -79.383),    # Panama Tocumen
    "JFK": (40.640, -73.779),   # New York JFK
    "LAX": (33.942, -118.408),  # Los Angeles
    "MEX": (19.436, -99.072),   # Mexico City
    "GRU": (-23.435, -46.473),  # Sao Paulo
    "BOG": (4.702, -74.147),    # Bogota
}

# Demo corridors: real aircraft are sampled along these cargo lanes.
DEMO_ROUTES: list[tuple[str, str]] = [
    ("HKG", "MIA"),
    ("CGO", "PTY"),
    ("PVG", "MIA"),
    ("ICN", "MIA"),
    ("GYD", "MIA"),
]


def get_airport(iata: str | None) -> tuple[float, float] | None:
    """Return (lat, lon) for an IATA airport code, or None if unknown."""
    if not iata:
        return None
    return AIRPORTS.get(iata.strip().upper())


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points, in nautical miles."""
    r_nm = 3440.065
    p1, p2 = radians(lat1), radians(lat2)
    dphi = radians(lat2 - lat1)
    dlmb = radians(lon2 - lon1)
    a = sin(dphi / 2) ** 2 + cos(p1) * cos(p2) * sin(dlmb / 2) ** 2
    return 2 * r_nm * asin(sqrt(a))

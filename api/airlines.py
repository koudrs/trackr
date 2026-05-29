"""IATA -> ICAO airline code mapping for ADS-B callsign correlation.

Carrier tracking events expose flight numbers in IATA form (e.g. "CM473").
ADS-B feeds (airplanes.live) report the ICAO callsign instead (e.g. "CMP473").
This module converts an IATA flight number into the candidate ADS-B callsigns
so /api/flights can match a tracked shipment to a live aircraft.

Correlation is best-effort: not every cargo flight is airborne / in ADS-B
coverage, and some operators use a callsign unrelated to the flight number.
"""

import re

# IATA (2-char) -> ICAO (3-char) for the carriers in api/carriers + common
# cargo operators that show up on the prefixes we support. Extend as needed.
IATA_TO_ICAO: dict[str, str] = {
    # Carriers wired in registry.py
    "M6": "AJT",   # Amerijet International
    "5Y": "GTI",   # Atlas Air
    "CV": "CLX",   # Cargolux
    "CK": "CKK",   # China Cargo Airlines
    "CM": "CMP",   # Copa (Copa Cargo flies on Copa Airlines callsign)
    "KE": "KAL",   # Korean Air
    "LA": "LAN",   # LATAM
    "TK": "THY",   # Turkish (Turkish Cargo uses "THY" + number)
    "KL": "KLM",   # KLM
    "AF": "AFR",   # Air France
    "MP": "MPH",   # Martinair
    "MH": "MAS",   # MASkargo / Malaysia (SmartKargo prefix 865)
    "BA": "BAW",   # British Airways / IAG Cargo
    "IB": "IBE",   # Iberia / IAG Cargo
    "JL": "JAL",   # Japan Airlines (SmartKargo/IAG partners)
    "7L": "AZQ",   # Silk Way West Airlines
    "ZP": "AZL",   # Silk Way Airlines
    "XL": "LCO",   # LATAM Cargo (shows as "XL" on some LATAM AWBs)
    "UC": "LCO",   # LATAM Cargo Chile
    # Common cargo operators on shared SmartKargo/interline lanes
    "QR": "QTR",   # Qatar
    "EK": "UAE",   # Emirates
    "CX": "CPA",   # Cathay
    "CI": "CAL",   # China Airlines
    "BR": "EVA",   # EVA Air
    "SQ": "SIA",   # Singapore
    "LH": "GEC",   # Lufthansa Cargo (ICAO "GEC")
    "FX": "FDX",   # FedEx
    "5X": "UPS",   # UPS
    "5C": "ICL",   # CAL Cargo
    "QY": "BCS",   # European Air Transport (DHL)
}

# Pull apart "CM473" / "CM 0473" / "lan1234" into (airline_iata, number).
_FLIGHT_RE = re.compile(r"^\s*([A-Za-z0-9]{2,3}?)\s*0*([0-9]{1,5})\s*$")


def parse_flight(flight: str) -> tuple[str, str] | None:
    """Split an IATA flight string into (airline_code, number) without leading zeros.

    Returns None when the string doesn't look like a flight number.
    """
    if not flight:
        return None
    m = _FLIGHT_RE.match(flight.strip())
    if not m:
        return None
    return m.group(1).upper(), m.group(2)


def callsign_candidates(flight: str, iata_code: str | None = None) -> list[str]:
    """Build candidate ADS-B callsigns for an IATA flight number.

    ``iata_code`` is the airline code from the tracking result (used when the
    flight string itself carries no recognizable prefix, e.g. just "473").
    Returns padded and unpadded ICAO variants, most-likely first, de-duplicated.
    """
    cleaned = (flight or "").strip()
    if not cleaned:
        return []

    if cleaned.isdigit():
        # Bare flight number with no airline prefix: need the airline from context.
        if not iata_code:
            return []
        airline, number = iata_code.strip().upper(), cleaned.lstrip("0") or "0"
    else:
        parsed = parse_flight(cleaned)
        if not parsed:
            return []
        airline, number = parsed

    icao = IATA_TO_ICAO.get(airline)
    prefixes = [icao] if icao else []
    # Fall back to the raw airline token so 3-letter ICAO inputs still work.
    if airline not in prefixes:
        prefixes.append(airline)

    candidates: list[str] = []
    for prefix in prefixes:
        candidates.append(f"{prefix}{number}")          # CMP473
        candidates.append(f"{prefix}{number.zfill(4)}")  # CMP0473
    # De-dup, preserve order.
    seen: set[str] = set()
    out: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out

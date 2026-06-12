"""Pydantic models for AWB tracking responses."""

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class StatusCode(str, Enum):
    """IATA standard status codes for air cargo."""

    BKD = "BKD"  # Booked - Reserva confirmada
    RCS = "RCS"  # Received - Carga recibida por aerolínea
    MAN = "MAN"  # Manifested - En manifiesto de vuelo
    DEP = "DEP"  # Departed - Vuelo despegó
    ARR = "ARR"  # Arrived - Vuelo aterrizó
    RCF = "RCF"  # Received at Destination - En almacén destino
    NFD = "NFD"  # Ready for Pickup - Listo para retiro
    DLV = "DLV"  # Delivered - Entregado
    DDL = "DDL"  # Delayed - Retrasado
    UNK = "UNK"  # Unknown - No mapeado


class TrackingSource(str, Enum):
    """Source type for tracking data."""

    API = "api"  # Direct API call
    HTML = "html"  # HTML scraping
    LINK = "link"  # Only link available (no data)


class TrackingEvent(BaseModel):
    """Single tracking event in the shipment timeline."""

    timestamp: datetime | None = None
    status_code: StatusCode = StatusCode.UNK
    description: str
    location: str | None = None  # IATA airport code
    flight: str | None = None
    pieces: int | None = None

    model_config = {"use_enum_values": True}


class TrackingResult(BaseModel):
    """Unified tracking result from any carrier."""

    awb: str = Field(..., pattern=r"^\d{3}-\d{8}$", description="AWB in XXX-XXXXXXXX format")
    airline: str
    iata_code: str | None = None  # 2-letter IATA code
    origin: str | None = None  # IATA airport code
    destination: str | None = None  # IATA airport code
    pieces: int | None = None
    weight: float | None = None
    status: str | None = None  # Latest status description
    events: list[TrackingEvent] = Field(default_factory=list)
    tracked_at: datetime = Field(default_factory=datetime.utcnow)
    source: TrackingSource = TrackingSource.API

    model_config = {"use_enum_values": True}


class TrackingError(BaseModel):
    """Error response for tracking failures."""

    awb: str
    error: str
    carrier: str | None = None
    suggestion: str | None = None  # e.g., direct link to carrier portal


class FlightPosition(BaseModel):
    """Live aircraft position from an ADS-B feed (airplanes.live)."""

    callsign: str  # ADS-B callsign, e.g. "CMP473"
    flight: str | None = None  # IATA flight number we matched it to, e.g. "CM473"
    awb: str | None = None  # Tracked AWB this flight belongs to (XXX-XXXXXXXX)
    fr24_id: str | None = None  # FR24 flight id, used to fetch the real flown track
    hex: str | None = None  # ICAO24 transponder address
    registration: str | None = None  # Tail number
    aircraft_type: str | None = None  # ICAO type code, e.g. "B763"
    lat: float
    lng: float
    track: float | None = None  # True heading in degrees (0-359), for icon rotation
    ground_speed: float | None = None  # knots
    altitude: float | None = None  # baro altitude in feet (None when on ground)
    vertical_rate: float | None = None  # feet/min: + climbing, - descending, ~0 cruise
    aircraft_desc: str | None = None  # human description, e.g. "BOEING 767-300"
    on_ground: bool = False
    seen_pos: float | None = None  # seconds since last position update

    # Route + timing — derived from the tracked AWB (origin/dest/DEP time) and
    # current live position. ETA/remaining are ESTIMATES (distance / speed).
    origin: str | None = None  # IATA, from the shipment
    destination: str | None = None  # IATA, from the shipment
    distance_remaining_nm: float | None = None  # great-circle to destination
    distance_flown_pct: float | None = None  # 0-100, rough progress along the route
    eta_minutes: float | None = None  # estimated minutes to destination (~approx)
    flight_minutes: float | None = None  # minutes since DEP event (actual time aloft)

    # Real flown track [[lng, lat], ...] when the source provides one (FR24).
    trail: list[list[float]] = Field(default_factory=list)


class FlightPositionList(BaseModel):
    """Response for GET /api/flights."""

    flights: list[FlightPosition] = Field(default_factory=list)
    source: str = "airplanes.live"
    fetched_at: datetime = Field(default_factory=datetime.utcnow)
    requested: int = 0  # how many flight ids were requested
    matched: int = 0  # how many got a live position

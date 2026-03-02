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

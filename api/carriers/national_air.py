"""National Air Cargo tracking (prefix 416)."""

import logging
from datetime import datetime

import httpx

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker

logger = logging.getLogger(__name__)


class NationalAirCargoTracker(CarrierTracker):
    """
    National Air Cargo (N8) - prefix 416.

    API: POST https://www.nationalaircargo.com/wp-content/themes/national-cargo/assets/js/soap-logix.php
    Payload: query={awb11}&searchBy=MAWB
    Response: JSON with Shipment object containing Origin, Destination, Notes.NoteDto[]
    """

    name = "National Air Cargo"
    iata_code = "N8"
    prefixes = ["416"]

    API_URL = "https://www.nationalaircargo.com/wp-content/themes/national-cargo/assets/js/soap-logix.php"

    STATUS_MAP = {
        **CarrierTracker.STATUS_MAP,
        "bkd": StatusCode.BKD,
        "booked": StatusCode.BKD,
        "rcs": StatusCode.RCS,
        "received": StatusCode.RCS,
        "foh": StatusCode.RCS,
        "man": StatusCode.MAN,
        "manifested": StatusCode.MAN,
        "dep": StatusCode.DEP,
        "departed": StatusCode.DEP,
        "arr": StatusCode.ARR,
        "arrived": StatusCode.ARR,
        "rcf": StatusCode.RCF,
        "nfd": StatusCode.NFD,
        "dlv": StatusCode.DLV,
        "delivered": StatusCode.DLV,
        "pod": StatusCode.DLV,
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track National Air Cargo shipment via SOAP API."""
        result = self.empty_result(prefix, serial, TrackingSource.API)
        awb11 = self.awb_11(prefix, serial)

        logger.info(f"[NationalAir] Tracking {prefix}-{serial}")

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    self.API_URL,
                    data={"query": awb11, "searchBy": "MAWB"},
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        "Referer": "https://www.nationalaircargo.com/track/",
                    },
                )
                response.raise_for_status()
                data = response.json()

            if data.get("IsSuccess") != "true":
                result.status = "AWB not found"
                return result

            shipment = data.get("Shipment", {})
            return self._parse_shipment(result, shipment)

        except Exception as e:
            logger.error(f"[NationalAir] Error: {type(e).__name__}: {e}")
            result.status = f"Tracking error: {str(e)[:50]}"
            return result

    def _parse_shipment(self, result: TrackingResult, shipment: dict) -> TrackingResult:
        """Parse shipment data from API response."""
        # Extract basic info
        result.origin = shipment.get("Origin")
        result.destination = shipment.get("Destination")
        result.pieces = self._parse_int(shipment.get("NumberOfPieces"))

        # Extract weight
        actual_weight = shipment.get("ActualWeight", {})
        if actual_weight:
            result.weight = self._parse_float(actual_weight.get("KG"))

        # Parse events from Notes.NoteDto
        events = []
        notes = shipment.get("Notes", {})
        note_list = notes.get("NoteDto", [])

        # Handle single note (not array)
        if isinstance(note_list, dict):
            note_list = [note_list]

        for note in note_list:
            event = self._parse_note(note)
            if event:
                events.append(event)

        # Sort by timestamp (newest first)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)
        result.events = events

        if events:
            result.status = events[0].description

        # Check POD status
        if shipment.get("PODReceived") == "true":
            result.status = "Delivered (POD received)"

        return result

    def _parse_note(self, note: dict) -> TrackingEvent | None:
        """Parse a note into a TrackingEvent."""
        if not note:
            return None

        # Parse timestamp
        timestamp = None
        date_str = note.get("Date")
        if date_str:
            try:
                # Format: "2026-07-22T14:30:00"
                timestamp = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                pass

        # Get status code
        code = note.get("Code", "").upper()
        status_code = self.map_status(code)

        # Get description
        description = note.get("Description", code)

        # Get location (airport)
        location = note.get("Airport")

        return TrackingEvent(
            timestamp=timestamp,
            status_code=status_code,
            description=description[:100] if description else code,
            location=location,
        )

    def _parse_int(self, value) -> int | None:
        """Safely parse integer."""
        if value is None:
            return None
        try:
            return int(value)
        except (ValueError, TypeError):
            return None

    def _parse_float(self, value) -> float | None:
        """Safely parse float."""
        if value is None:
            return None
        try:
            return float(value)
        except (ValueError, TypeError):
            return None

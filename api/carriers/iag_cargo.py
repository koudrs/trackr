"""IAG Cargo tracking (British Airways, Iberia, Aer Lingus)."""

import re
from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import ScraplingTracker


class IAGCargoTracker(ScraplingTracker):
    """
    IAG Cargo tracking using Scrapling - British Airways, Iberia, Aer Lingus.

    Scrapes: https://www.iagcargo.com/iagcargo/portlet/en/html/601/main/search?awb.cia={prefix}&awb.cod={serial}
    Response: HTML page with tracking details.

    Prefixes:
    - 053 → Aer Lingus (EI)
    - 060 → Iberia Express (I2)
    - 075 → Iberia (IB)
    - 125 → British Airways (BA)
    """

    name = "IAG Cargo"
    iata_code = "BA"
    prefixes = ["053", "060", "075", "125"]

    BASE_URL = "https://www.iagcargo.com/iagcargo/portlet/en/html/601/main/search"

    # Use regular Fetcher (no heavy anti-bot detected)
    use_stealth = False

    # IAG status mapping
    STATUS_MAP = {
        **ScraplingTracker.STATUS_MAP,
        "booked": StatusCode.BKD,
        "received": StatusCode.RCS,
        "accepted": StatusCode.RCS,
        "manifested": StatusCode.MAN,
        "departed": StatusCode.DEP,
        "arrived": StatusCode.ARR,
        "transferred": StatusCode.RCF,
        "available": StatusCode.NFD,
        "delivered": StatusCode.DLV,
        "collected": StatusCode.DLV,
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track IAG Cargo shipment via Scrapling."""
        result = self.empty_result(prefix, serial, TrackingSource.HTML)

        url = f"{self.BASE_URL}?awb.cia={prefix}&awb.cod={serial}"
        page, html, text = await self.fetch_page(url)

        return self._parse_page(result, page, text)

    def _parse_page(self, result: TrackingResult, page, text: str) -> TrackingResult:
        """Parse IAG Cargo page using Scrapling."""
        # Check for no data message
        not_found = self.css_first(page, ".awbNotFound__text")
        if not_found:
            return result

        # Look for shipment info
        shipment_info = self.css_first(page, ".shipment-info-container")
        if not shipment_info:
            # Try to extract from text anyway
            pass

        # Extract from text content
        self._extract_summary(result, text)

        # Parse events
        events = self._parse_events_from_text(text)

        # Sort events by timestamp (newest first)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)

        result.events = events
        result.source = TrackingSource.HTML

        if events and not result.status:
            result.status = events[0].description

        return result

    def _extract_summary(self, result: TrackingResult, text: str) -> None:
        """Extract summary info from page text."""
        # Extract pieces
        pieces_match = re.search(r"(\d+)\s*(?:pcs|pieces)", text, re.I)
        if pieces_match:
            result.pieces = int(pieces_match.group(1))

        # Extract weight
        weight_match = re.search(r"([\d,.]+)\s*kg", text, re.I)
        if weight_match:
            weight_str = weight_match.group(1).replace(",", "")
            result.weight = float(weight_str)

        # Extract origin/destination - look for route pattern
        route_match = re.search(r"\b([A-Z]{3})\s*[-→>]\s*([A-Z]{3})\b", text)
        if route_match:
            result.origin = route_match.group(1)
            result.destination = route_match.group(2)

        # Extract status
        status_match = re.search(r"\b(Delivered|Arrived|Departed|Manifested|Received|Booked)\b", text, re.I)
        if status_match:
            result.status = status_match.group(1).title()

    def _parse_events_from_text(self, text: str) -> list[TrackingEvent]:
        """Parse events from page text."""
        events: list[TrackingEvent] = []
        lines = text.split("\n")

        for line in lines:
            line = line.strip()
            if not line:
                continue

            # Look for lines with status codes
            status_match = re.search(r"\b(BKD|RCS|MAN|DEP|ARR|RCF|NFD|DLV)\b", line, re.I)
            if not status_match:
                continue

            status = status_match.group(1).upper()
            status_code = self.map_status(status)

            # Extract location (3-letter code)
            location_match = re.search(r"\b([A-Z]{3})\b", line)
            location = location_match.group(1) if location_match else None
            # Don't use status code as location
            if location == status:
                location = None

            # Extract timestamp
            timestamp = self._extract_timestamp(line)

            # Extract flight number
            flight_match = re.search(r"\b([A-Z]{2}\d{3,4})\b", line)
            flight = flight_match.group(1) if flight_match else None

            events.append(TrackingEvent(
                timestamp=timestamp,
                status_code=status_code,
                description=status,
                location=location,
                flight=flight,
            ))

        return events

    def _extract_timestamp(self, line: str) -> datetime | None:
        """Extract timestamp from text line."""
        # Try various date patterns
        patterns = [
            r"(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s*(\d{1,2}:\d{2})?",
            r"(\d{1,2}\s+\w{3}\s+\d{4})\s*(\d{1,2}:\d{2})?",
        ]

        for pattern in patterns:
            match = re.search(pattern, line)
            if match:
                date_str = match.group(1)
                time_str = match.group(2) or "00:00"
                result = self._parse_datetime(f"{date_str} {time_str}")
                if result:
                    return result

        return None

    def _parse_datetime(self, dt_str: str) -> datetime | None:
        """Parse various datetime formats."""
        formats = [
            "%d/%m/%Y %H:%M",
            "%d-%m-%Y %H:%M",
            "%m/%d/%Y %H:%M",
            "%Y-%m-%d %H:%M",
            "%d/%m/%y %H:%M",
            "%d %b %Y %H:%M",
            "%d %B %Y %H:%M",
        ]

        for fmt in formats:
            try:
                return datetime.strptime(dt_str.strip(), fmt)
            except ValueError:
                continue

        return None

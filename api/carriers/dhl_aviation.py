"""DHL Aviation Cargo tracking (prefixes 155, 423, 615, 936, 947, 992)."""

import re
from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import ScraplingTracker


class DHLAviationTracker(ScraplingTracker):
    """
    DHL Aviation Cargo tracking using Scrapling.

    Scrapes: https://aviationcargo.dhl.com/track/{prefix}-{serial}
    Response: HTML page with tracking table.

    DHL Group prefixes:
    - 155 → DHL Express
    - 423 → DHL Airways
    - 615 → DHL Aviation / European Air Transport
    - 936 → DHL Aviation (TAT)
    - 947 → DHL de Guatemala
    - 992 → DHL Aero Expreso
    """

    name = "DHL Aviation"
    iata_code = "D0"
    prefixes = ["155", "423", "615", "936", "947", "992"]

    BASE_URL = "https://aviationcargo.dhl.com/track"

    # Use regular Fetcher (no heavy anti-bot on DHL)
    use_stealth = False

    # DHL status codes to IATA
    STATUS_MAP = {
        **ScraplingTracker.STATUS_MAP,
        "bkd": StatusCode.BKD,
        "rcs": StatusCode.RCS,
        "man": StatusCode.MAN,
        "dep": StatusCode.DEP,
        "arr": StatusCode.ARR,
        "rcf": StatusCode.RCF,
        "nfd": StatusCode.NFD,
        "dlv": StatusCode.DLV,
        "ffm": StatusCode.MAN,  # Flight manifest message
        "foh": StatusCode.RCS,  # Freight on hand
    }

    # Event code descriptions
    EVENT_DESCRIPTIONS = {
        "DLV": "Delivery",
        "ARR": "Arrival in Delivery Facility",
        "NFD": "Awaiting Consignee Collection",
        "FFM": "Manifested",
        "DEP": "Depart Facility",
        "RCS": "Facility Check In",
        "RCF": "Received from Flight",
        "MAN": "Manifested",
        "BKD": "Booked",
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track DHL Aviation shipment via Scrapling."""
        result = self.empty_result(prefix, serial, TrackingSource.HTML)

        if not self.is_available():
            result.status = "DHL Aviation temporarily unavailable"
            result.events = []
            return result

        try:
            url = f"{self.BASE_URL}/{prefix}-{serial}"
            page, html, text = await self.fetch_page(url)
            return self._parse_page(result, html, text)
        except Exception as e:
            result.status = f"Tracking error: {str(e)[:50]}"
            return result

    def _parse_page(self, result: TrackingResult, html: str, text: str) -> TrackingResult:
        """Parse DHL Aviation page."""
        # Check if tracking results exist
        if "tracking-results" not in html and "tracking results" not in text.lower():
            return result

        # Extract summary info
        self._extract_summary(result, text)

        # Parse events
        events = self._parse_events(text)

        # Sort events by timestamp (newest first)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)

        result.events = events
        result.source = TrackingSource.HTML

        # Set status from latest event if not already set
        if events and not result.status:
            result.status = events[0].description

        return result

    def _extract_summary(self, result: TrackingResult, text: str) -> None:
        """Extract summary info (pieces, weight, origin, destination, status)."""
        # Extract pieces - format: "1" followed by weight like "2858 KG"
        # Or look for "X pcs" pattern
        pcs_match = re.search(r"(\d+)\s*pcs", text, re.I)
        if pcs_match:
            result.pieces = int(pcs_match.group(1))

        # Extract weight - format: "2858 KG" (standalone number followed by KG)
        weight_match = re.search(r"(\d+(?:\.\d+)?)\s*KG\s*T", text, re.I)
        if not weight_match:
            weight_match = re.search(r"(\d{3,}(?:\.\d+)?)\s*KG", text, re.I)
        if weight_match:
            result.weight = float(weight_match.group(1))

        # Extract origin - "From DHL Org HKG" or "From PPWK Org HKG"
        # The first 3-letter code after "From" patterns
        org_match = re.search(r"From (?:DHL|PPWK) Org\s*\n?\s*([A-Z]{3})", text)
        if org_match:
            result.origin = org_match.group(1)

        # Extract destination - look for the airport code after origin on same line or next
        # Pattern: "HKG\nMIA" where MIA is destination
        if result.origin:
            # Find origin and then next 3-letter code is destination
            dest_match = re.search(
                rf"{result.origin}\s*\n?\s*([A-Z]{{3}})",
                text
            )
            if dest_match and dest_match.group(1) != result.origin:
                result.destination = dest_match.group(1)

        # Extract actual status - "Actual status: ... DLV"
        status_match = re.search(r"Actual status:.*?([A-Z]{3})\s*[-–]\s*(\w+)", text, re.DOTALL)
        if status_match:
            result.status = f"{status_match.group(1)} - {status_match.group(2)}"
        else:
            # Just get the status code
            status_match = re.search(r"DLV|ARR|DEP|NFD|RCS|FFM|MAN", text)
            if status_match:
                code = status_match.group(0)
                result.status = self.EVENT_DESCRIPTIONS.get(code, code)

    def _parse_events(self, text: str) -> list[TrackingEvent]:
        """Parse events from page text."""
        events: list[TrackingEvent] = []
        lines = text.split("\n")

        current_date = None
        i = 0

        while i < len(lines):
            line = lines[i].strip()
            i += 1

            if not line:
                continue

            # Check for date header (e.g., "Monday, February 16, 2026" or "Saturday, February 14, 2026")
            date_match = re.match(
                r"(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*(\w+\s+\d{1,2},?\s*\d{4})",
                line,
                re.IGNORECASE
            )
            if date_match:
                current_date = self._parse_date(date_match.group(1))
                continue

            # Look for status code line (DLV, ARR, NFD, etc.)
            status_match = re.match(r"^(DLV|ARR|DEP|NFD|RCS|RCF|FFM|MAN|BKD)\s*$", line)
            if status_match and current_date:
                status_code = status_match.group(1)

                # Look ahead for description, pieces, location, time
                description = self.EVENT_DESCRIPTIONS.get(status_code, status_code)
                pieces = None
                location = None
                time_str = None

                # Scan next few lines for event details (large range for whitespace + multi-stop routes)
                for j in range(i, min(i + 15, len(lines))):
                    next_line = lines[j].strip()

                    # Skip if it's a status code or date (new event)
                    if re.match(r"^(DLV|ARR|DEP|NFD|RCS|RCF|FFM|MAN|BKD)\s*$", next_line):
                        break
                    if re.match(r"(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)", next_line):
                        break

                    # Look for description
                    if not description or description == status_code:
                        if re.match(r"^[A-Z][a-z]", next_line) and len(next_line) > 5:
                            description = next_line[:50]

                    # Look for pieces: "1 pcs"
                    pcs_match = re.search(r"(\d+)\s*pcs", next_line, re.I)
                    if pcs_match:
                        pieces = int(pcs_match.group(1))

                    # Look for location (3-letter code) - keep first one (airport, not facility)
                    loc_match = re.match(r"^([A-Z]{3})$", next_line)
                    if loc_match and not location:
                        location = loc_match.group(1)

                    # Look for time: "18:41" or "21:08"
                    time_match = re.match(r"^(\d{1,2}:\d{2})$", next_line)
                    if time_match:
                        time_str = time_match.group(1)

                # Build timestamp
                timestamp = current_date
                if time_str and current_date:
                    timestamp = self._combine_datetime(current_date, time_str)

                events.append(TrackingEvent(
                    timestamp=timestamp,
                    status_code=self.map_status(status_code),
                    description=description,
                    location=location,
                    pieces=pieces,
                ))

        return events

    def _parse_date(self, date_str: str) -> datetime | None:
        """Parse date from header like 'February 16, 2026'."""
        if not date_str:
            return None

        # Clean up the string
        date_str = date_str.replace(",", "").strip()

        formats = [
            "%B %d %Y",   # February 16 2026
            "%B %d, %Y",  # February 16, 2026
            "%b %d %Y",   # Feb 16 2026
            "%d %B %Y",   # 16 February 2026
        ]

        for fmt in formats:
            try:
                return datetime.strptime(date_str, fmt)
            except ValueError:
                continue

        return None

    def _combine_datetime(self, date: datetime, time_str: str) -> datetime | None:
        """Combine date with time string."""
        if not date or not time_str:
            return date

        try:
            parts = time_str.split(":")
            return date.replace(hour=int(parts[0]), minute=int(parts[1]))
        except (ValueError, IndexError):
            return date

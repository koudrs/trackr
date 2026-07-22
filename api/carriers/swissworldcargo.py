"""Swiss WorldCargo tracking (prefix 724) - Lufthansa Group."""

import logging
import re
from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker

logger = logging.getLogger(__name__)


class SwissWorldCargoTracker(CarrierTracker):
    """
    Swiss WorldCargo (LX) - prefix 724.
    Part of Lufthansa Cargo Group.

    Tracking via offerandorder app:
    https://offerandorder.swissworldcargo.com/app/offerandorder/#/shipments/list?type=D&values={awb11}

    Uses Scrapling StealthyFetcher to load the SPA and extract rendered data.
    """

    name = "Swiss WorldCargo"
    iata_code = "LX"
    prefixes = ["724"]

    BASE_URL = "https://offerandorder.swissworldcargo.com/app/offerandorder"

    STATUS_MAP = {
        **CarrierTracker.STATUS_MAP,
        "departed": StatusCode.DEP,
        "arrived": StatusCode.ARR,
        "booked": StatusCode.BKD,
        "confirmed": StatusCode.BKD,
        "received": StatusCode.RCS,
        "accepted": StatusCode.RCS,
        "delivered": StatusCode.DLV,
        "notified": StatusCode.NFD,
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track Swiss WorldCargo shipment via Scrapling."""
        import asyncio
        from scrapling.fetchers import StealthyFetcher

        result = self.empty_result(prefix, serial, TrackingSource.HTML)
        awb11 = self.awb_11(prefix, serial)
        url = f"{self.BASE_URL}/#/shipments/list?type=D&values={awb11}"

        logger.info(f"[SwissWorldCargo] Tracking {prefix}-{serial}")

        try:
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(None, lambda: StealthyFetcher.fetch(
                url,
                headless=True,
                network_idle=True,
                timeout=90000,
                wait=5000,  # Wait for SPA to render
            ))

            html = response.html_content
            text = response.get_all_text()
            logger.info(f"[SwissWorldCargo] Got HTML: {len(html)} bytes")

            return self._parse_result(result, html, text)

        except Exception as e:
            logger.error(f"[SwissWorldCargo] Error: {type(e).__name__}: {e}")
            result.status = f"Tracking error: {str(e)[:50]}"
            return result

    def _parse_result(self, result: TrackingResult, html: str, text: str) -> TrackingResult:
        """Parse tracking result from rendered SPA."""
        lines = [l.strip() for l in text.split('\n') if l.strip()]

        # Check for no results
        if "no results" in text.lower() or "not found" in text.lower():
            result.status = "AWB not found"
            return result

        # Extract origin/destination from lines like "HONG KONG (HKG)" and "MIAMI (MIA)"
        airports = []
        for line in lines:
            match = re.search(r'\(([A-Z]{3})\)$', line)
            if match:
                airports.append(match.group(1))

        # First occurrence is origin, last unique is destination
        if airports:
            result.origin = airports[0]
            # Find final destination (skip intermediate/cancelled entries)
            for airport in airports:
                if airport != result.origin:
                    result.destination = airport
                    break

        # Extract status line: "Departed to MIA on Flight LX-0064, 22 Jul 2026, ZRH-MIA"
        events = []
        for line in lines:
            if any(status in line.lower() for status in ['departed', 'arrived', 'booked', 'received', 'delivered']):
                event = self._parse_status_line(line)
                if event:
                    events.append(event)

        # Also parse from HTML for more detailed milestone data
        html_events = self._parse_html_events(html)
        events.extend(html_events)

        # Deduplicate and sort
        seen = set()
        unique_events = []
        for e in events:
            key = (e.timestamp, e.description[:30] if e.description else "")
            if key not in seen:
                seen.add(key)
                unique_events.append(e)

        unique_events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)
        result.events = unique_events

        if unique_events:
            result.status = unique_events[0].description

        # Try to extract pieces/weight from HTML
        pieces_match = re.search(r'(\d+)\s*(?:piece|pcs|pieces)', html, re.IGNORECASE)
        weight_match = re.search(r'([\d,]+(?:\.\d+)?)\s*(?:kg|KG)', html)

        if pieces_match:
            result.pieces = int(pieces_match.group(1))
        if weight_match:
            result.weight = float(weight_match.group(1).replace(',', ''))

        return result

    def _parse_status_line(self, line: str) -> TrackingEvent | None:
        """Parse status line like 'Departed to MIA on Flight LX-0064, 22 Jul 2026, ZRH-MIA'"""
        # Extract status
        status_match = re.search(r'^(Departed|Arrived|Booked|Received|Delivered)', line, re.IGNORECASE)
        if not status_match:
            return None

        status_text = status_match.group(1)
        status_code = self._map_status(status_text)

        # Extract flight: "Flight LX-0064" or "LX-0064"
        flight_match = re.search(r'(?:Flight\s+)?([A-Z]{2})[-\s]?(\d{3,4})', line)
        flight = f"{flight_match.group(1)}{flight_match.group(2)}" if flight_match else None

        # Extract date: "22 Jul 2026"
        date_match = re.search(r'(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})', line, re.IGNORECASE)
        timestamp = None
        if date_match:
            try:
                timestamp = datetime.strptime(
                    f"{date_match.group(1)} {date_match.group(2)} {date_match.group(3)}",
                    "%d %b %Y"
                )
            except ValueError:
                pass

        # Extract route: "ZRH-MIA"
        route_match = re.search(r'([A-Z]{3})-([A-Z]{3})$', line)
        location = route_match.group(1) if route_match else None

        return TrackingEvent(
            timestamp=timestamp,
            status_code=status_code,
            description=line[:100],
            location=location,
            flight=flight,
        )

    def _parse_html_events(self, html: str) -> list[TrackingEvent]:
        """Extract events from HTML milestone data."""
        events = []

        # Pattern for milestone descriptions in the SPA
        # Look for status codes: DEP, ARR, RCS, DLV, etc.
        milestone_pattern = re.compile(
            r'"code":\s*"(DEP|ARR|RCS|DLV|BKD|NFD|RCF)".*?'
            r'"achieved":\s*"(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})"',
            re.DOTALL
        )

        for match in milestone_pattern.finditer(html):
            code = match.group(1)
            date_str = match.group(2)

            timestamp = None
            try:
                timestamp = datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                pass

            status_code = self._map_status(code)

            events.append(TrackingEvent(
                timestamp=timestamp,
                status_code=status_code,
                description=f"{code} - {date_str}",
            ))

        return events

    def _map_status(self, status: str) -> StatusCode:
        """Map status string to StatusCode."""
        status_lower = status.lower().strip()

        mapping = {
            "dep": StatusCode.DEP,
            "departed": StatusCode.DEP,
            "arr": StatusCode.ARR,
            "arrived": StatusCode.ARR,
            "rcs": StatusCode.RCS,
            "received": StatusCode.RCS,
            "dlv": StatusCode.DLV,
            "delivered": StatusCode.DLV,
            "bkd": StatusCode.BKD,
            "booked": StatusCode.BKD,
            "nfd": StatusCode.NFD,
            "rcf": StatusCode.RCF,
        }

        return mapping.get(status_lower, StatusCode.UNK)

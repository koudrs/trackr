"""Awesome Cargo tracking (prefix 480) - TM Aerolineas S.A. de C.V."""

import logging
import re
from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker

logger = logging.getLogger(__name__)


class AwesomeCargoTracker(CarrierTracker):
    """
    Awesome Cargo (A7) - prefix 480.
    TM Aerolineas S.A. de C.V., Mexico.

    Tracking portal: https://newtrack.awesome-cargo.net/tracking
    Uses Scrapling StealthyFetcher with page_action for form interaction.
    """

    name = "Awesome Cargo"
    iata_code = "A7"
    prefixes = ["480"]

    TRACKING_URL = "https://newtrack.awesome-cargo.net/tracking"

    STATUS_MAP = {
        **CarrierTracker.STATUS_MAP,
        "documented": StatusCode.BKD,
        "documented cargo": StatusCode.BKD,
        "accepted": StatusCode.RCS,
        "accepted in warehouse": StatusCode.RCS,
        "departed": StatusCode.DEP,
        "landed": StatusCode.ARR,
        "landed at destination": StatusCode.ARR,
        "arrived": StatusCode.ARR,
        "delivered": StatusCode.DLV,
        "in connection": StatusCode.ARR,
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track Awesome Cargo shipment via Scrapling with form interaction."""
        import asyncio
        from scrapling.fetchers import StealthyFetcher

        result = self.empty_result(prefix, serial, TrackingSource.HTML)
        awb11 = self.awb_11(prefix, serial)

        logger.info(f"[AwesomeCargo] Tracking {prefix}-{serial}")

        def fill_and_submit(page):
            page.locator('input[name="guia"]').fill(awb11)
            page.locator('button[type="submit"]').click()
            # Wait for result page elements
            page.wait_for_selector('.summary-panel, .monitoring-panel', timeout=120000)

        try:
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(None, lambda: StealthyFetcher.fetch(
                self.TRACKING_URL,
                headless=True,
                network_idle=True,
                page_action=fill_and_submit,
                timeout=120000,
                wait=3000,
            ))
            html = response.html_content
            logger.info(f"[AwesomeCargo] Got HTML: {len(html)} bytes")
            return self._parse_html(result, html)

        except Exception as e:
            logger.error(f"[AwesomeCargo] Error: {type(e).__name__}: {e}")
            result.status = f"Tracking error: {str(e)[:50]}"
            return result

    def _parse_html(self, result: TrackingResult, html: str) -> TrackingResult:
        """Parse tracking result HTML from Awesome Cargo."""
        # Check for no results
        if "no record" in html.lower() or "not found" in html.lower() or "no existe" in html.lower():
            result.status = "AWB not found"
            return result

        # Extract route from summary-panel
        # <div class="airport-code">EHU</div>...<div class="airport-desc">Flight origin</div>
        origin_match = re.search(
            r'<div class="airport-code">([A-Z]{3})</div>\s*(?:<div[^>]*>[^<]*</div>\s*)?<div class="airport-desc">Flight origin</div>',
            html, re.IGNORECASE | re.DOTALL
        )
        dest_match = re.search(
            r'<div class="airport-code">([A-Z]{3})</div>\s*(?:<div[^>]*>[^<]*</div>\s*)?<div class="airport-desc">[^<]*</div>\s*<div class="airport-desc">Flight destination</div>',
            html, re.IGNORECASE | re.DOTALL
        )

        if origin_match:
            result.origin = origin_match.group(1)
        if dest_match:
            result.destination = dest_match.group(1)

        # Extract flight number: <div class="flight-number">A7933</div>
        flight_match = re.search(r'<div class="flight-number">([A-Z0-9]+)</div>', html)
        flight_number = flight_match.group(1) if flight_match else None

        # Extract pieces and weight: 71 pz(s) | 1487.0 Kg
        weight_match = re.search(r'(\d+)\s*pz\(s\)\s*\|\s*([\d.]+)\s*Kg', html, re.IGNORECASE)
        if weight_match:
            result.pieces = int(weight_match.group(1))
            result.weight = float(weight_match.group(2))

        # Parse events from monitoring-panel
        events = self._parse_events(html, flight_number)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)
        result.events = events

        if events:
            result.status = events[0].description

        return result

    def _parse_events(self, html: str, flight_number: str | None) -> list[TrackingEvent]:
        """Extract tracking events from monitoring panel."""
        events: list[TrackingEvent] = []

        # Pattern for monitor rows:
        # <div class="monitor-time">02JUL26 16:32</div>
        # <div class="monitor-dot"></div>
        # <div class="monitor-text">Documented cargo (71 piece(s))</div>
        event_pattern = re.compile(
            r'<div class="monitor-time[^"]*">([^<]+)</div>\s*'
            r'<div class="monitor-dot"></div>\s*'
            r'<div class="monitor-text[^"]*">\s*([^<]+)\s*</div>',
            re.IGNORECASE | re.DOTALL
        )

        for match in event_pattern.finditer(html):
            time_str = match.group(1).strip()
            description = match.group(2).strip()

            # Parse timestamp: 02JUL26 16:32
            timestamp = self._parse_datetime(time_str)

            # Extract pieces from description: "Documented cargo (71 piece(s))"
            pieces_match = re.search(r'\((\d+)\s*piece', description, re.IGNORECASE)
            pieces = int(pieces_match.group(1)) if pieces_match else None

            # Extract location from description: "EHU - NLU / A7933 Landed..."
            loc_match = re.search(r'^([A-Z]{3})\s*-', description)
            location = loc_match.group(1) if loc_match else None

            # Extract flight from description if present
            flight = None
            flight_in_desc = re.search(r'/\s*([A-Z0-9]+)\s+', description)
            if flight_in_desc:
                flight = flight_in_desc.group(1)
            elif flight_number and ("landed" in description.lower() or "departed" in description.lower()):
                flight = flight_number

            # Map status
            status_code = self._map_event_status(description)

            events.append(TrackingEvent(
                timestamp=timestamp,
                status_code=status_code,
                description=description[:100],
                location=location,
                flight=flight,
                pieces=pieces,
            ))

        return events

    def _map_event_status(self, description: str) -> StatusCode:
        """Map event description to status code."""
        desc_lower = description.lower()

        if "documented" in desc_lower:
            return StatusCode.BKD
        elif "accepted" in desc_lower or "warehouse" in desc_lower:
            return StatusCode.RCS
        elif "departed" in desc_lower:
            return StatusCode.DEP
        elif "landed" in desc_lower or "arrived" in desc_lower:
            return StatusCode.ARR
        elif "delivered" in desc_lower:
            return StatusCode.DLV
        elif "connection" in desc_lower:
            return StatusCode.ARR

        return StatusCode.UNK

    def _parse_datetime(self, dt_str: str) -> datetime | None:
        """Parse datetime: 02JUL26 16:32"""
        # Format: DDMMMYY HH:MM
        formats = [
            "%d%b%y %H:%M",  # 02JUL26 16:32
            "%d%b%Y %H:%M",  # 02JUL2026 16:32
            "%d/%m/%Y %H:%M",
            "%Y-%m-%d %H:%M",
        ]

        dt_str = dt_str.strip().upper()

        for fmt in formats:
            try:
                return datetime.strptime(dt_str, fmt)
            except ValueError:
                continue

        return None

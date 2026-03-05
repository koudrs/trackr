"""LATAM Cargo tracking (LA - prefix 045)."""

import asyncio
import logging
import re
from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker, IS_CONTAINER

logger = logging.getLogger(__name__)


class LatamCargoTracker(CarrierTracker):
    """
    LATAM Cargo tracking using Scrapling.

    URL: https://www.latamcargo.com/en/trackshipment?docNumber={serial}&docPrefix={prefix}&soType=MAWB

    Prefix: 045 → LATAM Cargo (LA)
    """

    name = "LATAM Cargo"
    iata_code = "LA"
    prefixes = ["045"]

    BASE_URL = "https://www.latamcargo.com/en/trackshipment"

    # LATAM status mapping
    STATUS_MAP = {
        **CarrierTracker.STATUS_MAP,
        "bkd": StatusCode.BKD,
        "booked": StatusCode.BKD,
        "booking confirmed": StatusCode.BKD,
        "rcs": StatusCode.RCS,
        "received": StatusCode.RCS,
        "shipment received": StatusCode.RCS,
        "foh": StatusCode.RCS,  # Freight on Hand
        "freight on hand": StatusCode.RCS,
        "man": StatusCode.MAN,
        "manifested": StatusCode.MAN,
        "dep": StatusCode.DEP,
        "departed": StatusCode.DEP,
        "arr": StatusCode.ARR,
        "arrived": StatusCode.ARR,
        "rcf": StatusCode.RCF,
        "received from flight": StatusCode.RCF,
        "nfd": StatusCode.NFD,
        "notified": StatusCode.NFD,
        "dlv": StatusCode.DLV,
        "delivered": StatusCode.DLV,
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track LATAM Cargo shipment via Scrapling."""
        result = self.empty_result(prefix, serial, TrackingSource.HTML)

        url = f"{self.BASE_URL}?docNumber={serial}&docPrefix={prefix}&soType=MAWB"

        try:
            # Run Scrapling in thread pool (synchronous)
            loop = asyncio.get_event_loop()
            html, text = await loop.run_in_executor(None, self._fetch_with_scrapling, url)

            if not text:
                result.status = "No tracking data found"
                return result

            return self._parse_page(result, html, text)
        except Exception as e:
            result.status = f"Tracking error: {str(e)[:50]}"
            return result

    def _fetch_with_scrapling(self, url: str) -> tuple[str, str]:
        """Fetch page using Scrapling StealthyFetcher."""
        from scrapling.fetchers import StealthyFetcher

        logger.info(f"[LATAM] Fetching URL: {url}")
        logger.info(f"[LATAM] IS_CONTAINER: {IS_CONTAINER}")

        fetch_kwargs = {
            "headless": True,
            "network_idle": True,
            "timeout": 60000,  # 60 seconds for Cloudflare challenges
            "wait_selector": "table, .tracking-events, [class*='event'], [class*='status']",
            "wait_selector_state": "attached",
        }

        # Docker/container fixes for shared memory issues
        if IS_CONTAINER:
            fetch_kwargs["chromium_sandbox"] = False
            fetch_kwargs["extra_flags"] = [
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-zygote",
                "--single-process",
            ]
            logger.info(f"[LATAM] Container mode enabled with flags: {fetch_kwargs['extra_flags']}")

        try:
            page = StealthyFetcher.fetch(url, **fetch_kwargs)
            html = page.html_content
            text = page.get_all_text()

            logger.info(f"[LATAM] Fetch success - HTML length: {len(html)}, Text length: {len(text)}")
            logger.debug(f"[LATAM] Text preview: {text[:500]}...")

            return html, text
        except Exception as e:
            logger.error(f"[LATAM] Fetch error: {type(e).__name__}: {e}")
            raise

    def _parse_page(self, result: TrackingResult, html: str, text: str) -> TrackingResult:
        """Parse LATAM Cargo tracking page."""
        # Check for no data
        if "no encontr" in text.lower() or "not found" in text.lower():
            return result

        # Extract shipment summary
        self._extract_summary(result, text)

        # Parse events table
        events = self._parse_events(text)

        # Sort events by timestamp (newest first)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)

        result.events = events
        result.source = TrackingSource.HTML

        if events and not result.status:
            result.status = events[0].description

        return result

    def _extract_summary(self, result: TrackingResult, text: str) -> None:
        """Extract summary info from page text."""
        # Pattern for summary table row:
        # MIA PTY STD BASIC GENERAL CARGO 42 876.00
        summary_match = re.search(
            r"([A-Z]{3})\s+([A-Z]{3})\s+(?:STD|NEXT|PRIME|OVERNIGHT|STANDARD)[^\d]*(\d+)\s+([\d.]+)",
            text
        )
        if summary_match:
            result.origin = summary_match.group(1)
            result.destination = summary_match.group(2)
            result.pieces = int(summary_match.group(3))
            result.weight = float(summary_match.group(4))
            return

        # Fallback: look for route pattern like "MIA-PTY"
        route_match = re.search(r"\b([A-Z]{3})-([A-Z]{3})\b", text)
        if route_match:
            result.origin = route_match.group(1)
            result.destination = route_match.group(2)

        # Fallback: pieces and weight from event lines
        # Pattern: "42 / 879.00KGS"
        pw_match = re.search(r"(\d+)\s*/\s*([\d.]+)\s*KGS", text, re.I)
        if pw_match:
            result.pieces = int(pw_match.group(1))
            result.weight = float(pw_match.group(2))

    def _parse_events(self, text: str) -> list[TrackingEvent]:
        """Parse tracking events from page text.

        Format in text:
        RCS Shipment Received MIA 42 / 879.00KGS 04-Mar-2026 16:44
        FOH Freight on Hand MIA 42 / 879.00KGS 04-Mar-2026 16:37
        BKD Booking Confirmed MIA XL 0425 42 / 876.00KGS 04-Mar-2026 15:19
        """
        events: list[TrackingEvent] = []

        # Pattern for event lines
        # Status | Description | Station | [Flight] | Pieces/Weight | Date Time
        event_pattern = re.compile(
            r"(RCS|FOH|BKD|MAN|DEP|ARR|RCF|NFD|DLV)\s+"  # Status code
            r"([A-Za-z\s]+?)\s+"  # Description
            r"([A-Z]{3})\s+"  # Station
            r"(?:([A-Z]{2}\s*\d{3,4})\s+)?"  # Optional flight
            r"(\d+)\s*/\s*([\d.]+)\s*KGS\s+"  # Pieces / Weight
            r"(\d{1,2}-[A-Z][a-z]{2}-\d{4})\s+(\d{1,2}:\d{2})",  # Date Time
            re.I
        )

        for match in event_pattern.finditer(text):
            status_code_str = match.group(1).upper()
            description = match.group(2).strip()
            station = match.group(3)
            flight = match.group(4).replace(" ", "") if match.group(4) else None
            pieces = int(match.group(5))
            weight = float(match.group(6))
            date_str = match.group(7)
            time_str = match.group(8)

            # Parse datetime
            timestamp = self._parse_datetime(f"{date_str} {time_str}")

            # Map status
            status_code = self.map_status(status_code_str)

            events.append(TrackingEvent(
                timestamp=timestamp,
                status_code=status_code,
                description=description,
                location=station,
                flight=flight,
                pieces=pieces,
            ))

        # If regex didn't match, try line-by-line
        if not events:
            events = self._parse_events_fallback(text)

        return events

    def _parse_events_fallback(self, text: str) -> list[TrackingEvent]:
        """Fallback event parser - line by line."""
        events: list[TrackingEvent] = []
        lines = text.split("\n")

        for line in lines:
            line = line.strip()
            if not line:
                continue

            # Look for IATA status codes at start of line
            status_match = re.match(r"^(RCS|FOH|BKD|MAN|DEP|ARR|RCF|NFD|DLV)\b", line, re.I)
            if not status_match:
                continue

            status_code_str = status_match.group(1).upper()
            status_code = self.map_status(status_code_str)

            # Extract station (3-letter code after description)
            station_match = re.search(r"\b([A-Z]{3})\b", line[4:])
            station = station_match.group(1) if station_match else None

            # Extract pieces/weight
            pw_match = re.search(r"(\d+)\s*/\s*([\d.]+)", line)
            pieces = int(pw_match.group(1)) if pw_match else None

            # Extract datetime
            dt_match = re.search(r"(\d{1,2}-[A-Z][a-z]{2}-\d{4})\s+(\d{1,2}:\d{2})", line)
            timestamp = None
            if dt_match:
                timestamp = self._parse_datetime(f"{dt_match.group(1)} {dt_match.group(2)}")

            # Extract flight
            flight_match = re.search(r"\b([A-Z]{2}\s*\d{3,4})\b", line)
            flight = flight_match.group(1).replace(" ", "") if flight_match else None

            # Get description (text between status and station)
            desc_match = re.search(rf"{status_code_str}\s+(.+?)\s+[A-Z]{{3}}", line, re.I)
            description = desc_match.group(1).strip() if desc_match else status_code_str

            events.append(TrackingEvent(
                timestamp=timestamp,
                status_code=status_code,
                description=description,
                location=station,
                flight=flight,
                pieces=pieces,
            ))

        return events

    def _parse_datetime(self, dt_str: str) -> datetime | None:
        """Parse LATAM datetime format: 04-Mar-2026 16:44"""
        formats = [
            "%d-%b-%Y %H:%M",
            "%d-%B-%Y %H:%M",
            "%d/%m/%Y %H:%M",
            "%Y-%m-%d %H:%M",
        ]

        for fmt in formats:
            try:
                return datetime.strptime(dt_str.strip(), fmt)
            except ValueError:
                continue

        return None

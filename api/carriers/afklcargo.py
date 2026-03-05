"""KLM / Air France Cargo tracking (prefixes 074, 057, 129)."""

import asyncio
import logging
import re
from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker, IS_CONTAINER

logger = logging.getLogger(__name__)


class AFKLCargoTracker(CarrierTracker):
    """
    KLM / Air France Cargo - prefixes 074 (KLM), 057 (Air France), 129 (Martinair).

    Scrapes: https://www.afklcargo.com/mycargo/shipment/detail/{prefix}-{serial}
    Uses Scrapling StealthyFetcher to bypass Akamai WAF.
    """

    name = "KLM / Air France Cargo"
    iata_code = "KL"
    prefixes = ["057", "074", "129"]

    BASE_URL = "https://www.afklcargo.com/mycargo/shipment/detail"

    # AFKL event codes to IATA status
    STATUS_MAP = {
        **CarrierTracker.STATUS_MAP,
        "booked": StatusCode.BKD,
        "checked-in": StatusCode.RCS,
        "received": StatusCode.RCS,
        "departed": StatusCode.DEP,
        "arrived": StatusCode.ARR,
        "delivered": StatusCode.DLV,
        "delivery": StatusCode.DLV,
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track KLM/Air France shipment using Scrapling."""
        result = self.empty_result(prefix, serial, TrackingSource.HTML)

        awb = self.format_awb(prefix, serial)
        url = f"{self.BASE_URL}/{awb}"

        try:
            # Run Scrapling in thread pool (it's synchronous)
            loop = asyncio.get_event_loop()
            html, text = await loop.run_in_executor(None, self._fetch_with_scrapling, url)

            if not text:
                result.status = "No tracking data found"
                return result

            return self._parse_text(result, text, html)
        except Exception as e:
            result.status = f"Tracking error: {str(e)[:50]}"
            return result

    def _fetch_with_scrapling(self, url: str) -> tuple[str, str]:
        """Fetch page using Scrapling StealthyFetcher."""
        from scrapling.fetchers import StealthyFetcher

        logger.info(f"[AFKL] Fetching URL: {url}")
        logger.info(f"[AFKL] IS_CONTAINER: {IS_CONTAINER}")

        fetch_kwargs = {
            "headless": True,
            "network_idle": True,
            "timeout": 60000,  # 60 seconds for Akamai WAF challenges
            "wait_selector": ".timeline, [class*='shipment'], [class*='event'], table",
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
            logger.info(f"[AFKL] Container mode enabled with flags: {fetch_kwargs['extra_flags']}")

        try:
            page = StealthyFetcher.fetch(url, **fetch_kwargs)
            html = page.html_content
            text = page.get_all_text()

            logger.info(f"[AFKL] Fetch success - HTML length: {len(html)}, Text length: {len(text)}")
            logger.debug(f"[AFKL] Text preview: {text[:500]}...")

            return html, text
        except Exception as e:
            logger.error(f"[AFKL] Fetch error: {type(e).__name__}: {e}")
            raise

    def _parse_text(self, result: TrackingResult, text: str, html: str) -> TrackingResult:
        """Parse tracking data from page text content."""
        lines = [line.strip() for line in text.split("\n") if line.strip()]

        # Find AWB line with pieces/weight info
        # Format: "074-71939976 - 91 pcs, 1,641 kg, 7,16 m³ - Watch..."
        for line in lines:
            if re.search(r"\d{3}-\d{8}\s*-\s*\d+\s*pcs", line):
                match = re.search(r"(\d+)\s*pcs,\s*([\d,\.]+)\s*kg", line)
                if match:
                    result.pieces = int(match.group(1))
                    weight_str = match.group(2).replace(",", "")
                    result.weight = float(weight_str)
                break

        # Find origin/destination from route section
        route_section = ""
        for i, line in enumerate(lines):
            if "Checked-in" in line or "checked-in" in line.lower():
                route_section = " ".join(lines[i:i+5])
                break

        # Extract airports from route section (3-letter codes)
        if route_section:
            airports = re.findall(r"\b([A-Z]{3})\b", route_section)
        else:
            route_match = re.search(r"([A-Z]{3})\s*-\s*([A-Z]{3})", text)
            if route_match:
                airports = [route_match.group(1), route_match.group(2)]
            else:
                airports = []

        if len(airports) >= 2:
            result.origin = airports[0]
            result.destination = airports[-1]

        # Find status
        status_keywords = ["DELIVERY", "delivered", "Delivered", "arrived", "departed"]
        for kw in status_keywords:
            if kw in text:
                result.status = kw.title()
                break

        # Parse events from text
        events: list[TrackingEvent] = []

        event_pattern = re.compile(
            r"(\d{1,2}\s+[A-Z]{3}\s+\d{2}:\d{2})\s*-\s*(\d+)\s*pieces?\s+([a-z]+(?:\s+(?:at|from|to)\s+[A-Z]{2,4})?(?:\s+from\s+[A-Z]{2}\d{3,4})?)",
            re.IGNORECASE
        )

        for match in event_pattern.finditer(text):
            timestamp_str = match.group(1)
            pieces = int(match.group(2))
            description = match.group(3).strip()

            timestamp = self._parse_datetime(timestamp_str)
            location = self._extract_location(description)
            flight = self._extract_flight(description)
            status_code = self._map_description_to_status(description)

            events.append(TrackingEvent(
                timestamp=timestamp,
                status_code=status_code,
                description=description[:100],
                location=location,
                flight=flight,
                pieces=pieces,
            ))

        # Also parse flight schedule
        flight_pattern = re.compile(
            r"([A-Z]{2}\d{3,4})\s+(\d{1,2}\s+[A-Z]{3}\s+\d{2}:\d{2})",
            re.IGNORECASE
        )

        for match in flight_pattern.finditer(text):
            flight_num = match.group(1)
            dep_time_str = match.group(2)
            timestamp = self._parse_datetime(dep_time_str)

            exists = any(e.flight == flight_num for e in events)
            if not exists:
                events.append(TrackingEvent(
                    timestamp=timestamp,
                    status_code=StatusCode.DEP,
                    description=f"Flight {flight_num}",
                    flight=flight_num,
                ))

        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)
        result.events = events

        if events and not result.status:
            result.status = events[0].description

        return result

    def _parse_datetime(self, dt_str: str) -> datetime | None:
        """Parse datetime like '14 FEB 18:19'."""
        try:
            year = datetime.now().year
            full_str = f"{dt_str} {year}"
            return datetime.strptime(full_str, "%d %b %H:%M %Y")
        except ValueError:
            return None

    def _extract_location(self, description: str) -> str | None:
        """Extract airport code from description like 'delivered at PTY'."""
        match = re.search(r"(?:at|from|to)\s+([A-Z]{3})", description, re.IGNORECASE)
        if match:
            return match.group(1).upper()
        return None

    def _extract_flight(self, description: str) -> str | None:
        """Extract flight number from description like 'from KL0757'."""
        match = re.search(r"([A-Z]{2}\d{3,4})", description)
        if match:
            return match.group(1)
        return None

    def _map_description_to_status(self, description: str) -> StatusCode:
        """Map event description to status code."""
        desc_lower = description.lower()

        if "delivered" in desc_lower:
            return StatusCode.DLV
        elif "received" in desc_lower and "from" in desc_lower:
            return StatusCode.RCF
        elif "received" in desc_lower:
            return StatusCode.RCS
        elif "departed" in desc_lower:
            return StatusCode.DEP
        elif "arrived" in desc_lower:
            return StatusCode.ARR
        elif "ready" in desc_lower or "pickup" in desc_lower:
            return StatusCode.NFD
        elif "booked" in desc_lower:
            return StatusCode.BKD
        elif "manifested" in desc_lower:
            return StatusCode.MAN

        return StatusCode.UNK

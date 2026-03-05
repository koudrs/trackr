"""LATAM Cargo tracking (LA - prefix 045)."""

import logging
import re
from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker

logger = logging.getLogger(__name__)


class LatamCargoTracker(CarrierTracker):
    """
    LATAM Cargo tracking via direct API.

    API: POST https://www.latamcargo.com/en/doTrackShipmentsAction
    Payload: {"cargoTrackingRequestSOs":[{"documentPrefix":"045","documentNumber":"XXXXXXXX","documentType":"MAWB"}]}

    Prefix: 045 → LATAM Cargo (LA)
    """

    name = "LATAM Cargo"
    iata_code = "LA"
    prefixes = ["045"]

    API_URL = "https://www.latamcargo.com/en/doTrackShipmentsAction"

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
        """Track LATAM Cargo shipment via direct API (with Scrapling fallback)."""
        result = self.empty_result(prefix, serial, TrackingSource.API)

        payload = {
            "cargoTrackingRequestSOs": [{
                "documentPrefix": prefix,
                "documentNumber": serial,
                "documentType": "MAWB"
            }]
        }

        # Try direct API first (fast)
        try:
            async with self.create_http_client() as client:
                logger.info(f"[LATAM] Calling API for {prefix}-{serial}")
                response = await client.post(
                    self.API_URL,
                    json=payload,
                    headers={
                        "Content-Type": "application/json",
                        "Accept": "text/html, */*",
                        "Referer": "https://www.latamcargo.com/en/trackshipment",
                    }
                )
                response.raise_for_status()
                html = response.text

                # Check if we got blocked (captcha, empty response, etc.)
                if len(html) < 500 or "captcha" in html.lower() or "blocked" in html.lower():
                    logger.warning(f"[LATAM] API returned suspicious response, falling back to Scrapling")
                    raise Exception("Blocked or captcha detected")

                logger.info(f"[LATAM] API success - HTML length: {len(html)}")
                return self._parse_html(result, html)

        except Exception as e:
            logger.warning(f"[LATAM] API failed ({e}), trying Scrapling fallback...")

        # Fallback to Scrapling if API fails
        return await self._track_with_scrapling(prefix, serial, result)

    async def _track_with_scrapling(self, prefix: str, serial: str, result: TrackingResult) -> TrackingResult:
        """Fallback tracking using Scrapling."""
        import asyncio
        from scrapling.fetchers import StealthyFetcher

        url = f"https://www.latamcargo.com/en/trackshipment?docNumber={serial}&docPrefix={prefix}&soType=MAWB"
        logger.info(f"[LATAM] Scrapling fallback for {url}")

        try:
            loop = asyncio.get_event_loop()
            page = await loop.run_in_executor(None, lambda: StealthyFetcher.fetch(
                url,
                headless=True,
                load_dom=True,
                timeout=30000,
                disable_resources=True,
            ))
            html = page.html_content
            logger.info(f"[LATAM] Scrapling success - HTML length: {len(html)}")
            result.source = TrackingSource.HTML
            return self._parse_html(result, html)
        except Exception as e:
            logger.error(f"[LATAM] Scrapling error: {type(e).__name__}: {e}")
            result.status = f"Tracking error: {str(e)[:50]}"
            return result

    def _parse_html(self, result: TrackingResult, html: str) -> TrackingResult:
        """Parse LATAM Cargo API response HTML."""
        # Extract route from header: "045-21930510 MIA-PTY"
        route_match = re.search(r"\d{3}-\d{8}\s+([A-Z]{3})-([A-Z]{3})", html)
        if route_match:
            result.origin = route_match.group(1)
            result.destination = route_match.group(2)

        # Extract shipment summary from table
        # <td id="shipment_origin">MIA</td>
        # <td id="shipment_destination">PTY</td>
        # <td id="totalPieces">42</td>
        # <td>876.00</td>
        origin_match = re.search(r'id="shipment_origin"[^>]*>([A-Z]{3})<', html)
        dest_match = re.search(r'id="shipment_destination"[^>]*>([A-Z]{3})<', html)
        pieces_match = re.search(r'id="totalPieces"[^>]*>(\d+)<', html)
        weight_match = re.search(r'id="totalPieces"[^>]*>\d+</td>\s*<td>([\d.]+)<', html)

        if origin_match:
            result.origin = origin_match.group(1)
        if dest_match:
            result.destination = dest_match.group(1)
        if pieces_match:
            result.pieces = int(pieces_match.group(1))
        if weight_match:
            result.weight = float(weight_match.group(1))

        # Parse events from statusTable
        events = self._parse_events_html(html)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)
        result.events = events

        if events:
            result.status = events[0].description

        return result

    def _parse_events_html(self, html: str) -> list[TrackingEvent]:
        """Parse events from HTML table rows."""
        events: list[TrackingEvent] = []

        # Pattern for event rows in statusTable
        # <td class="movementStatus">RCS</td>
        # <td class="mvtDesc">Shipment Received</td>
        # <td class="eventAirport">MIA</td>
        # <td class="flightNumber_eventTable">XL 0425<br />MIA-PTY</td>
        # <td class="actualpk">42 / 879.00KGS</td>
        # <td>04-Mar-2026 16:44</td>
        event_pattern = re.compile(
            r'class="movementStatus">([A-Z]{3})</td>\s*'
            r'<td[^>]*class="mvtDesc"[^>]*>([^<]+)</td>\s*'
            r'<td[^>]*class="eventAirport"[^>]*>([A-Z]{3})</td>\s*'
            r'<td[^>]*class="flightNumber_eventTable"[^>]*>\s*([^<]*?)(?:<br\s*/?>.*?)?</td>\s*'
            r'<td[^>]*class="actualpk"[^>]*>(\d+)\s*/\s*([\d.]+)KGS</td>\s*'
            r'<td[^>]*>(\d{1,2}-[A-Z][a-z]{2}-\d{4})\s+(\d{1,2}:\d{2})</td>',
            re.IGNORECASE | re.DOTALL
        )

        for match in event_pattern.finditer(html):
            status_code_str = match.group(1).upper()
            description = match.group(2).strip()
            station = match.group(3)
            flight_raw = match.group(4).strip()
            pieces = int(match.group(5))
            date_str = match.group(7)
            time_str = match.group(8)

            # Extract flight number (e.g., "XL 0425" -> "XL0425")
            flight = None
            if flight_raw:
                flight_match = re.search(r"([A-Z]{2})\s*(\d{3,4})", flight_raw)
                if flight_match:
                    flight = f"{flight_match.group(1)}{flight_match.group(2)}"

            timestamp = self._parse_datetime(f"{date_str} {time_str}")
            status_code = self.map_status(status_code_str)

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

"""Copa Cargo tracking (prefix 230) - SmartKargo based."""

import re
from datetime import datetime

import httpx

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker


class CopaCargoTracker(CarrierTracker):
    """
    Copa Cargo (CM) - prefix 230.

    Uses SmartKargo platform: https://copa.smartkargo.com/
    Copa redirects to encrypted URL - we use httpx with follow_redirects.
    """

    name = "Copa Cargo"
    iata_code = "CM"
    prefixes = ["230"]

    BASE_URL = "https://copa.smartkargo.com/FrmAWBTracking.aspx"

    STATUS_MAP = {
        **CarrierTracker.STATUS_MAP,
        "booked": StatusCode.BKD,
        "received": StatusCode.RCS,
        "accepted": StatusCode.RCS,
        "manifested": StatusCode.MAN,
        "departed": StatusCode.DEP,
        "arrived": StatusCode.ARR,
        "transferred": StatusCode.RCF,
        "notified": StatusCode.NFD,
        "delivered": StatusCode.DLV,
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track Copa shipment via httpx (follows redirects automatically)."""
        result = self.empty_result(prefix, serial, TrackingSource.HTML)

        url = f"{self.BASE_URL}?AWBPrefix={prefix}&AWBNo={serial}"

        try:
            async with httpx.AsyncClient(
                timeout=30.0,
                follow_redirects=True,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
            ) as client:
                response = await client.get(url)
                response.raise_for_status()
                html = response.text

            # Extract text from HTML
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html, "html.parser")
            text = soup.get_text(separator="\n", strip=True)

            return self._parse_page(result, None, html, text)

        except Exception as e:
            result.status = f"Tracking error: {str(e)[:50]}"
            return result

    def _parse_page(self, result: TrackingResult, page, html: str, text: str) -> TrackingResult:
        """Parse Copa SmartKargo page - different structure than MAS Air."""
        # Check for no data
        if "no record" in text.lower() or "invalid" in text.lower():
            return result

        # Extract from HTML labels (more reliable than text parsing)
        origin_match = re.search(r'lblOrigin[^>]*>([A-Z]{3})<', html)
        dest_match = re.search(r'lblDestination[^>]*>([A-Z]{3})<', html)
        pcs_match = re.search(r'lblPcs[^>]*>(\d+)', html)
        weight_match = re.search(r'lblGrossWt[^>]*>([\d.]+)', html)

        if origin_match:
            result.origin = origin_match.group(1)
        if dest_match:
            result.destination = dest_match.group(1)
        if pcs_match:
            result.pieces = int(pcs_match.group(1))
        if weight_match:
            result.weight = float(weight_match.group(1))

        # Extract status
        status_match = re.search(r'Last Activity\s*\n?\s*([^\n]+)', text)
        if status_match:
            result.status = status_match.group(1).strip()

        # Parse "Booking and Acceptance Information" table
        events = self._parse_booking_table(text)

        # Sort events by timestamp (newest first)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)

        result.events = events
        result.source = TrackingSource.HTML

        if events and not result.status:
            result.status = events[0].description

        return result

    def _parse_booking_table(self, text: str) -> list[TrackingEvent]:
        """Parse booking info from text content."""
        events: list[TrackingEvent] = []

        # Pattern: Status Station Dest Pcs Weight Flight# Date
        # Example: Booked ICN LAX 77 1602.00 Kgs YP101 ICN -LAX 14/04/2026 13:44
        lines = text.split('\n')

        for i, line in enumerate(lines):
            line = line.strip()

            # Look for status keywords
            if line in ['Booked', 'Received', 'Departed', 'Arrived', 'Delivered', 'Manifested']:
                # Try to extract data from following lines
                try:
                    # Collect next few lines for context
                    context = ' '.join(lines[i:i+6])

                    # Extract station and destination
                    station_match = re.search(r'(Booked|Received|Departed|Arrived|Delivered|Manifested)\s+([A-Z]{3})\s+([A-Z]{3})', context)
                    if not station_match:
                        continue

                    status_text = station_match.group(1)
                    station = station_match.group(2)
                    dest = station_match.group(3)

                    # Extract pieces and weight
                    pcs_match = re.search(r'(\d+)\s+([\d.]+)\s*Kgs', context)
                    pieces = int(pcs_match.group(1)) if pcs_match else None
                    weight = float(pcs_match.group(2)) if pcs_match else None

                    # Extract flight number (e.g., YP101, CM473)
                    flight_match = re.search(r'([A-Z]{2}\d{2,4})', context)
                    flight = flight_match.group(1) if flight_match else None

                    # Extract date (DD/MM/YYYY HH:MM)
                    date_match = re.search(r'(\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2})', context)
                    timestamp = None
                    if date_match:
                        try:
                            timestamp = datetime.strptime(date_match.group(1), "%d/%m/%Y %H:%M")
                        except ValueError:
                            pass

                    # Map status
                    status_code = self.map_status(status_text)

                    events.append(TrackingEvent(
                        timestamp=timestamp,
                        status_code=status_code,
                        description=f"{status_text} at {station}",
                        location=f"{station}→{dest}",
                        flight=flight,
                        pieces=pieces,
                        weight=weight,
                    ))
                except (IndexError, ValueError):
                    continue

        return events

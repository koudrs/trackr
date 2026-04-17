"""Copa Cargo tracking (prefix 230) - SmartKargo based."""

import re
from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .smartkargo import SmartKargoTracker


class CopaCargoTracker(SmartKargoTracker):
    """
    Copa Cargo (CM) - prefix 230.

    Uses SmartKargo platform: https://copa.smartkargo.com/
    Copa requires encrypted URLs and redirects, so we use StealthyFetcher.
    Copa has different table structure than MAS Air SmartKargo.
    """

    name = "Copa Cargo"
    iata_code = "CM"
    prefixes = ["230"]

    BASE_URL = "https://copa.smartkargo.com/FrmAWBTracking.aspx"

    # Copa requires browser to handle encrypted redirect
    use_stealth = True

    def _parse_page(self, result: TrackingResult, page, html: str, text: str) -> TrackingResult:
        """Parse Copa SmartKargo page - different structure than MAS Air."""
        # Check for no data
        if "no record" in text.lower() or "invalid" in text.lower():
            return result

        # Extract origin/destination from text (ICN → PTY format)
        # Text contains: "230-67675193 ( ICN PTY 77 P 1602.00 Kgs"
        route_match = re.search(r'\(\s*([A-Z]{3})\s+([A-Z]{3})\s+(\d+)\s*P\s+([\d.]+)\s*Kgs', text)
        if route_match:
            result.origin = route_match.group(1)
            result.destination = route_match.group(2)
            result.pieces = int(route_match.group(3))
            result.weight = float(route_match.group(4))

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

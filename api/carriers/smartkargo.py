"""SmartKargo-based carrier tracking (MAS Air - prefixes 865, 870)."""

import re
from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import ScraplingTracker


class SmartKargoTracker(ScraplingTracker):
    """
    SmartKargo tracking using Scrapling - used by MAS Air and other carriers.

    Scrapes: https://{subdomain}.smartkargo.com/FrmAWBTracking.aspx?AWBPrefix={prefix}&AWBNo={serial}
    Response: HTML page with tracking table.

    Table structure (GridViewAwbTracking):
    Station | Milestone | Pcs | Weight | Flight# | Flight Date | Org | Dest | ULD
    """

    name = "MAS Air"
    iata_code = "M7"
    prefixes = ["865", "870"]

    BASE_URL = "https://masair.smartkargo.com/FrmAWBTracking.aspx"

    # Use regular Fetcher (no heavy anti-bot detected)
    use_stealth = False

    # SmartKargo milestone text to IATA status
    STATUS_MAP = {
        **ScraplingTracker.STATUS_MAP,
        "booked": StatusCode.BKD,
        "received": StatusCode.RCS,
        "accepted": StatusCode.RCS,
        "planned": StatusCode.BKD,
        "manifested": StatusCode.MAN,
        "departed": StatusCode.DEP,
        "arrived": StatusCode.ARR,
        "transferred": StatusCode.RCF,
        "received from flight": StatusCode.RCF,
        "notified": StatusCode.NFD,
        "ready for pickup": StatusCode.NFD,
        "delivered": StatusCode.DLV,
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track SmartKargo shipment via Scrapling."""
        result = self.empty_result(prefix, serial, TrackingSource.HTML)

        url = f"{self.BASE_URL}?AWBPrefix={prefix}&AWBNo={serial}"
        page, html, text = await self.fetch_page(url)

        return self._parse_page(result, page, html, text)

    def _parse_page(self, result: TrackingResult, page, html: str, text: str) -> TrackingResult:
        """Parse SmartKargo page."""
        # Check for no data
        if "no record" in text.lower():
            return result

        # Extract origin/destination from labels
        origin_match = re.search(r'id="lblOrigin"[^>]*>([A-Z]{3})<', html)
        dest_match = re.search(r'id="lblDestination"[^>]*>([A-Z]{3})<', html)

        if origin_match:
            result.origin = origin_match.group(1)
        if dest_match:
            result.destination = dest_match.group(1)

        # Extract pieces and weight
        pcs_match = re.search(r'id="lblPcs"[^>]*>(\d+)', html)
        weight_match = re.search(r'id="lblGrossWt"[^>]*>([\d.]+)', html)

        if pcs_match:
            result.pieces = int(pcs_match.group(1))
        if weight_match:
            result.weight = float(weight_match.group(1))

        # Extract last activity for status
        activity_match = re.search(r'Delivered at ([A-Z]{3})|Last Activity\s*([A-Za-z\s]+)', text)
        if activity_match:
            if activity_match.group(1):
                result.status = f"Delivered at {activity_match.group(1)}"
            elif activity_match.group(2):
                result.status = activity_match.group(2).strip()

        # Parse Status History table (GridViewAwbTracking)
        events = self._parse_status_history_table(html)

        # Sort events by timestamp (newest first)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)

        result.events = events
        result.source = TrackingSource.HTML

        # Set status from latest event if not set
        if events and not result.status:
            result.status = events[0].description

        return result

    def _parse_status_history_table(self, html: str) -> list[TrackingEvent]:
        """Parse the Status History table (GridViewAwbTracking) only."""
        events: list[TrackingEvent] = []

        # Find only the GridViewAwbTracking table
        table_match = re.search(
            r'id="GridViewAwbTracking"[^>]*>(.*?)</table>',
            html,
            re.DOTALL | re.IGNORECASE
        )

        if not table_match:
            return events

        table_html = table_match.group(1)

        # Extract all data rows (class="newstyle-tr") from this table only
        row_pattern = re.compile(
            r'<tr class="newstyle-tr"[^>]*>(.*?)</tr>',
            re.DOTALL | re.IGNORECASE
        )

        for row_match in row_pattern.finditer(table_html):
            row_html = row_match.group(1)
            event = self._parse_table_row(row_html)
            if event:
                events.append(event)

        return events

    def _parse_table_row(self, row_html: str) -> TrackingEvent | None:
        """
        Parse a single table row from Status History.

        Columns: Station | Milestone | Pcs | Weight | Flight# | Flight Date | Org | Dest | ULD
        """
        # Extract all cell contents
        cell_pattern = re.compile(r'<td[^>]*>(.*?)</td>', re.DOTALL | re.IGNORECASE)
        cells = cell_pattern.findall(row_html)

        if len(cells) < 6:
            return None

        try:
            # Station (column 0) - may be in a span
            station = self._extract_cell_text(cells[0])

            # Milestone (column 1)
            milestone = self._extract_cell_text(cells[1])

            # Pieces (column 2)
            pieces_text = self._extract_cell_text(cells[2])
            pieces = int(pieces_text) if pieces_text.isdigit() else None

            # Weight (column 3) - skip, we have total weight

            # Flight# (column 4)
            flight = self._extract_cell_text(cells[4])

            # Flight Date (column 5) - this is our timestamp
            date_text = self._extract_cell_text(cells[5])
            timestamp = self._parse_datetime(date_text)

            # Origin (column 6)
            origin = self._extract_cell_text(cells[6]) if len(cells) > 6 else None

            # Destination (column 7)
            dest = self._extract_cell_text(cells[7]) if len(cells) > 7 else None

            # Map milestone to status code
            status_code = self._map_milestone(milestone)

            # Build location string
            location = station
            if origin and dest and origin != dest:
                location = f"{origin}→{dest}"

            return TrackingEvent(
                timestamp=timestamp,
                status_code=status_code,
                description=milestone,
                location=location,
                flight=flight if flight else None,
                pieces=pieces,
            )

        except (IndexError, ValueError) as e:
            return None

    def _extract_cell_text(self, cell_html: str) -> str:
        """Extract text from table cell, handling nested spans."""
        # Remove HTML tags and get text
        # First try to get text from span
        span_match = re.search(r'<span[^>]*>([^<]*)</span>', cell_html)
        if span_match:
            return span_match.group(1).strip()

        # Otherwise strip all tags
        text = re.sub(r'<[^>]+>', '', cell_html)
        return text.strip()

    def _parse_datetime(self, dt_str: str) -> datetime | None:
        """Parse SmartKargo datetime format (DD/MM/YYYY HH:MM)."""
        if not dt_str:
            return None

        formats = [
            "%d/%m/%Y %H:%M",
            "%d/%m/%Y %H:%M:%S",
            "%m/%d/%Y %H:%M",
            "%m/%d/%Y %H:%M:%S",
        ]

        for fmt in formats:
            try:
                return datetime.strptime(dt_str.strip(), fmt)
            except ValueError:
                continue

        return None

    def _map_milestone(self, milestone: str) -> StatusCode:
        """Map SmartKargo milestone text to IATA status code."""
        if not milestone:
            return StatusCode.UNK

        milestone_lower = milestone.lower().strip()

        # Check exact matches first
        if milestone_lower in self.STATUS_MAP:
            return self.STATUS_MAP[milestone_lower]

        # Check partial matches
        for key, code in self.STATUS_MAP.items():
            if key in milestone_lower:
                return code

        return StatusCode.UNK

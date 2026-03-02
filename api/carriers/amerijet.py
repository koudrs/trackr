"""Amerijet International tracking (prefix 810)."""

from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker


class AmerijetTracker(CarrierTracker):
    """
    Amerijet International (5Y) - prefix 810.

    API: GET https://amerijetprod.wpenginepowered.com/api/index.php/tracking/getTrackingInfo?awbNo={awb11}
    Response: Array of tracking events with status codes, descriptions, locations, flights.
    """

    name = "Amerijet International"
    iata_code = "5Y"
    prefixes = ["810"]

    API_URL = "https://amerijetprod.wpenginepowered.com/api/index.php/tracking/getTrackingInfo"

    # Amerijet-specific status mapping
    STATUS_MAP = {
        **CarrierTracker.STATUS_MAP,
        "bkd": StatusCode.BKD,
        "foh": StatusCode.RCS,  # Freight on hand
        "rcs": StatusCode.RCS,
        "man": StatusCode.MAN,
        "dep": StatusCode.DEP,
        "arr": StatusCode.ARR,
        "rcf": StatusCode.RCF,
        "nfd": StatusCode.NFD,
        "dlv": StatusCode.DLV,
        "ddl": StatusCode.DDL,
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track Amerijet shipment."""
        result = self.empty_result(prefix, serial)
        awb11 = self.awb_11(prefix, serial)

        async with self.create_http_client() as client:
            response = await client.get(self.API_URL, params={"awbNo": awb11})
            response.raise_for_status()
            data = response.json()

        if not data or not isinstance(data, list):
            return result

        events: list[TrackingEvent] = []

        for item in data:
            # Parse timestamp
            timestamp = None
            if date_str := item.get("TMEVENTDATE"):
                try:
                    timestamp = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    pass

            # Map status code
            raw_status = item.get("TMEVENTSTATUSCODE", "")
            status_code = self.map_status(raw_status)

            event = TrackingEvent(
                timestamp=timestamp,
                status_code=status_code,
                description=item.get("TMEVENTDESC", ""),
                location=item.get("TMORIGIN") or item.get("TMDESTINATION"),
                flight=item.get("TMFLIGHTNUMBER"),
                pieces=self._parse_int(item.get("TMNUMBEROFPIECES")),
            )
            events.append(event)

        # Sort by timestamp (newest first for display, oldest first for processing)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)

        # Extract shipment info from first event (usually has origin/dest)
        if data:
            first = data[0]
            result.origin = first.get("TMORIGIN")
            result.destination = first.get("TMDESTINATION")
            result.pieces = self._parse_int(first.get("TMNUMBEROFPIECES"))

        result.events = events
        result.status = events[0].description if events else None
        result.source = TrackingSource.API

        return result

    def _parse_int(self, value) -> int | None:
        """Safely parse integer from various types."""
        if value is None:
            return None
        try:
            return int(value)
        except (ValueError, TypeError):
            return None

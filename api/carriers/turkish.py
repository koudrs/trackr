"""Turkish Cargo tracking (prefix 235)."""

from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker


class TurkishCargoTracker(CarrierTracker):
    """
    Turkish Cargo (TK) - prefix 235.

    API: POST https://www.turkishcargo.com/api/proxy/onlineServices/shipmentTracking
    Body: {"trackingFilters":[{"shipmentPrefix":"235","masterDocumentNumber":"XXXXXXXX"}]}
    Response: JSON with shipmentTrackings array containing origin, destination, events.
    """

    name = "Turkish Cargo"
    iata_code = "TK"
    prefixes = ["235"]

    API_URL = "https://www.turkishcargo.com/api/proxy/onlineServices/shipmentTracking"

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track Turkish Cargo shipment."""
        result = self.empty_result(prefix, serial)

        payload = {
            "trackingFilters": [
                {
                    "shipmentPrefix": prefix,
                    "masterDocumentNumber": serial,
                }
            ]
        }

        async with self.create_http_client() as client:
            response = await client.post(
                self.API_URL,
                json=payload,
                headers={
                    **self.headers,
                    "Content-Type": "application/json",
                },
            )
            response.raise_for_status()
            data = response.json()

        # Navigate to shipment data
        shipments = data.get("result", {}).get("shipmentTrackings", [])
        if not shipments:
            return result

        shipment = shipments[0]

        # Extract basic info - use IATA codes
        result.origin = shipment.get("originCode") or shipment.get("origin")
        result.destination = shipment.get("destinationCode") or shipment.get("destination")
        result.pieces = self._parse_int(shipment.get("pieces"))
        result.weight = self._parse_float(shipment.get("weight"))
        result.status = shipment.get("actualStatus")

        # Parse events from trackingHistoryDetails (more complete than trackingDiagramDetails)
        events: list[TrackingEvent] = []
        history_details = shipment.get("trackingHistoryDetails", [])

        for item in history_details:
            timestamp = self._parse_timestamp(item.get("actualDatetime"))
            raw_status = item.get("status", "")
            status_code = self.map_status(raw_status)

            event = TrackingEvent(
                timestamp=timestamp,
                status_code=status_code,
                description=item.get("description", ""),
                location=item.get("station"),
                flight=item.get("flightNo") or None,
                pieces=self._parse_int(item.get("actualPieces") or item.get("plannedPieces")),
            )
            events.append(event)

        # Sort events by timestamp (newest first)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)

        result.events = events
        result.source = TrackingSource.API

        return result

    def _parse_int(self, value) -> int | None:
        """Safely parse integer."""
        if value is None:
            return None
        try:
            return int(value)
        except (ValueError, TypeError):
            return None

    def _parse_float(self, value) -> float | None:
        """Safely parse float."""
        if value is None:
            return None
        try:
            return float(value)
        except (ValueError, TypeError):
            return None

    def _parse_timestamp(self, date_str: str | None) -> datetime | None:
        """Parse Turkish Cargo date format: 07-Feb-2026 21:53:55"""
        if not date_str:
            return None
        # Remove milliseconds if present
        date_str = date_str.split(".")[0]
        try:
            return datetime.strptime(date_str, "%d-%b-%Y %H:%M:%S")
        except (ValueError, TypeError):
            pass
        try:
            return datetime.strptime(date_str, "%d-%b-%Y %H:%M")
        except (ValueError, TypeError):
            return None

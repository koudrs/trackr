"""Cargolux tracking (prefix 172)."""

from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker


class CargoluxTracker(CarrierTracker):
    """
    Cargolux (CV) - prefix 172.

    API: GET https://cargolux-icargo-api-app-prod.politesmoke-46f514de.westeurope.azurecontainerapps.io/api/track/awbs/?numbers={awb}
    Response: JSON with trackings array containing shipmentSummary and airportEvents.
    """

    name = "Cargolux"
    iata_code = "CV"
    prefixes = ["172"]

    API_URL = "https://cargolux-icargo-api-app-prod.politesmoke-46f514de.westeurope.azurecontainerapps.io/api/track/awbs/"

    # Cargolux event type mapping
    STATUS_MAP = {
        **CarrierTracker.STATUS_MAP,
        "bkd": StatusCode.BKD,
        "cpt": StatusCode.RCS,  # Cargo preparation time / accepted
        "foh": StatusCode.RCS,  # Freight on hand
        "rcs": StatusCode.RCS,
        "man": StatusCode.MAN,
        "dep": StatusCode.DEP,
        "arr": StatusCode.ARR,
        "rcf": StatusCode.RCF,
        "nfd": StatusCode.NFD,
        "awd": StatusCode.NFD,  # Awaiting delivery
        "dlv": StatusCode.DLV,
        "ddl": StatusCode.DDL,
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track Cargolux shipment."""
        result = self.empty_result(prefix, serial)
        awb = f"{prefix}-{serial}"

        async with self.create_http_client() as client:
            response = await client.get(
                self.API_URL,
                params={"numbers": awb},
                headers={
                    "Referer": "https://www.cargolux.com/",
                    "Origin": "https://www.cargolux.com",
                },
            )
            response.raise_for_status()
            data = response.json()

        # Check for valid tracking data
        trackings = data.get("trackings", [])
        if not trackings:
            return result

        tracking = trackings[0]
        summary = tracking.get("shipmentSummary", {})
        airport_events = tracking.get("airportEvents", [])

        # Extract shipment info
        result.origin = summary.get("origin")
        result.destination = summary.get("destination")
        result.pieces = summary.get("statedPieces")
        result.weight = summary.get("statedWeight")

        # Flatten all events from all airports
        events: list[TrackingEvent] = []

        for airport in airport_events:
            airport_code = airport.get("airportCode", "")

            for item in airport.get("events", []):
                # Parse timestamp (use UTC time)
                timestamp = None
                if time_str := item.get("timeUtc"):
                    try:
                        timestamp = datetime.fromisoformat(time_str.replace("Z", "+00:00"))
                    except (ValueError, TypeError):
                        pass

                # Map event type to status code
                event_type = item.get("eventType", "").lower()
                status_code = self.map_status(event_type)

                # Build description
                description = item.get("eventType", "")
                if item.get("isProcessed"):
                    description += " (Processed)"

                event = TrackingEvent(
                    timestamp=timestamp,
                    status_code=status_code,
                    description=description,
                    location=airport_code,
                    flight=item.get("flightNumber"),
                    pieces=item.get("pieces"),
                    weight=item.get("weight"),
                )
                events.append(event)

        # Sort by timestamp (newest first)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)

        result.events = events
        result.status = events[0].description if events else None
        result.source = TrackingSource.API

        return result

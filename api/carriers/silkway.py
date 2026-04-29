"""Silk Way West Airlines tracking (prefix 501)."""

from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker


class SilkWayTracker(CarrierTracker):
    """
    Silk Way West Airlines (7L) - prefix 501.

    API: GET https://sww.enxt.solutions/api/TrackAndTrace/{prefix}-{serial}
    Response: JSON with routes array and airports lookup.
    """

    name = "Silk Way West Airlines"
    iata_code = "7L"
    prefixes = ["501"]

    API_URL = "https://sww.enxt.solutions/api/TrackAndTrace"

    STATUS_MAP = {
        **CarrierTracker.STATUS_MAP,
        "bkd": StatusCode.BKD,
        "rcs": StatusCode.RCS,
        "man": StatusCode.MAN,
        "dep": StatusCode.DEP,
        "arr": StatusCode.ARR,
        "rcf": StatusCode.RCF,
        "nfd": StatusCode.NFD,
        "dlv": StatusCode.DLV,
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track Silk Way shipment."""
        result = self.empty_result(prefix, serial)

        url = f"{self.API_URL}/{prefix}-{serial}"

        async with self.create_http_client() as client:
            response = await client.get(url)
            response.raise_for_status()
            data = response.json()

        if not data or not data.get("routes"):
            return result

        # Build airport lookup: id -> iataCode
        airports = {int(a["id"]): a["iataCode"] for a in data.get("airports", [])}

        # Build carrier lookup: id -> airlineCode
        carriers = {int(c["id"]): c["airlineCode"] for c in data.get("carriers", [])}

        # Get shipment info
        result.pieces = data.get("pieces")
        result.weight = data.get("actualWeight")

        routes = data.get("routes", [])
        events: list[TrackingEvent] = []

        # Extract origin from first route, destination from last route
        if routes:
            first_route = routes[0]
            last_route = routes[-1]

            origin_id = int(first_route.get("origin", 0))
            dest_id = int(last_route.get("destination", 0))

            result.origin = airports.get(origin_id)
            result.destination = airports.get(dest_id)

            # Debug: the route order might be different, use actual last destination
            # Routes: HKG->GYD, GYD->HHN, HHN->MIA means final dest is MIA
            for route in routes:
                final_dest_id = int(route.get("destination", 0))
                result.destination = airports.get(final_dest_id)

        # Convert routes to events
        for route in routes:
            # Parse flight date
            timestamp = None
            if flight_date := route.get("flightDate"):
                try:
                    timestamp = datetime.fromisoformat(flight_date.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    pass

            # Map status
            flight_status = route.get("flightStatus", "").lower()
            status_code = self.map_status(flight_status)

            # Get airport codes
            origin_id = int(route.get("origin", 0))
            dest_id = int(route.get("destination", 0))
            origin_code = airports.get(origin_id, "???")
            dest_code = airports.get(dest_id, "???")

            # Get carrier and flight number
            carrier_id = int(route.get("carrier", 0))
            carrier_code = carriers.get(carrier_id, "7L")
            flight_nr = route.get("flightNr", "")
            flight = f"{carrier_code}{flight_nr}" if flight_nr else None

            # Build description
            status_upper = flight_status.upper() if flight_status else "UNK"
            description = f"{status_upper} {origin_code}→{dest_code}"

            event = TrackingEvent(
                timestamp=timestamp,
                status_code=status_code,
                description=description,
                location=origin_code,
                flight=flight,
                pieces=route.get("pieces"),
                weight=route.get("actualWeight"),
            )
            events.append(event)

        # Sort by timestamp (newest first)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)

        result.events = events
        result.status = events[0].description if events else None
        result.source = TrackingSource.API

        return result

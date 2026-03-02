"""Atlas Air tracking (prefix 369)."""

from datetime import datetime

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker

# Status descriptions for Atlas Air
STATUS_DESCRIPTIONS = {
    "BKD": "Booked",
    "ULD": "ULD Built",
    "DEP": "Departed",
    "ARR": "Arrived",
    "RCF": "Received from Flight",
    "NFD": "Ready for Pickup",
    "DLV": "Delivered",
    "RCS": "Received from Shipper",
    "MAN": "Manifested",
}


class AtlasAirTracker(CarrierTracker):
    """
    Atlas Air (5Y/GTI) - prefixes 369, 403.

    API: GET https://jumpseat.atlasair.com/tracktraceapi/api/FreightContProvdr/GetFrieghtDtlByAwbNo
    Params: prfx={prefix}&serial={awb8}
    Response: JSON with LstFrieghtDtlEnhanced array of events + root level shipment info.
    """

    name = "Atlas Air"
    iata_code = "5Y"
    prefixes = ["369", "403"]

    API_URL = "https://jumpseat.atlasair.com/tracktraceapi/api/FreightContProvdr/GetFrieghtDtlByAwbNo"

    # Atlas Air status mapping
    STATUS_MAP = {
        **CarrierTracker.STATUS_MAP,
        "bkd": StatusCode.BKD,
        "rcs": StatusCode.RCS,
        "foh": StatusCode.RCS,
        "man": StatusCode.MAN,
        "dep": StatusCode.DEP,
        "arr": StatusCode.ARR,
        "rcf": StatusCode.RCF,
        "dlv": StatusCode.DLV,
        "nfd": StatusCode.NFD,
        "uld": StatusCode.MAN,  # ULD built = manifested
        "pre": StatusCode.RCS,
        "tfd": StatusCode.RCF,
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track Atlas Air shipment."""
        result = self.empty_result(prefix, serial)

        async with self.create_http_client() as client:
            response = await client.get(
                self.API_URL,
                params={
                    "prfx": prefix,
                    "serial": serial,
                },
            )
            response.raise_for_status()
            data = response.json()

        # Get shipment info from root level
        result.origin = data.get("Origin")
        result.destination = data.get("Destination")
        result.pieces = self._parse_int(data.get("Pieces"))
        result.weight = self._parse_float(data.get("Weight"))

        # Get events from LstFrieghtDtlEnhanced
        freight_list = data.get("LstFrieghtDtlEnhanced", [])
        if not freight_list:
            return result

        events: list[TrackingEvent] = []

        for item in freight_list:
            timestamp = self._parse_timestamp(item.get("DtTime"))
            raw_status = item.get("Status", "")
            status_code = self.map_status(raw_status)

            # Get description from our mapping
            description = STATUS_DESCRIPTIONS.get(raw_status.upper(), raw_status)

            # Location is destination for arrival events, origin otherwise
            location = item.get("Destination") if raw_status.upper() in ("ARR", "RCF", "NFD", "DLV") else item.get("Origin")

            event = TrackingEvent(
                timestamp=timestamp,
                status_code=status_code,
                description=description,
                location=location,
                flight=self._build_flight(item.get("Carrier"), item.get("FlightNo")),
                pieces=self._parse_int(item.get("Pieces")),
            )
            events.append(event)

        # Sort events by timestamp (newest first)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)

        result.events = events
        result.status = events[0].description if events else None
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
        """Parse Atlas Air date formats: 2026-02-16T17:01:11.437Z or 2026-02-15T00:00:00"""
        if not date_str:
            return None
        # Remove timezone suffix and milliseconds for consistent naive datetime
        date_str = date_str.replace("Z", "").split(".")[0]
        try:
            return datetime.strptime(date_str, "%Y-%m-%dT%H:%M:%S")
        except (ValueError, TypeError):
            return None

    def _build_flight(self, carrier: str | None, flight_no: str | None) -> str | None:
        """Build flight number from carrier code and number."""
        if not flight_no:
            return None
        if carrier:
            return f"{carrier}{flight_no}"
        return flight_no

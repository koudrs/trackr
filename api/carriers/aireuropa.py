"""Air Europa Cargo tracking (prefix 996) - Requires agent credentials."""

import logging
from datetime import datetime, UTC

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker

logger = logging.getLogger(__name__)


class AirEuropaCargoTracker(CarrierTracker):
    """
    Air Europa Cargo (UX) - prefix 996.
    Spanish airline based in Palma de Mallorca.

    NOTE: Air Europa Cargo tracking is managed by CRS Airlines Representatives
    through their Cargospot platform. Public tracking is not available -
    it requires registered agent credentials.
    """

    name = "Air Europa Cargo"
    iata_code = "UX"
    prefixes = ["996"]

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Return carrier info with no-tracking-available status."""
        result = self.empty_result(prefix, serial, TrackingSource.API)

        logger.info(f"[AirEuropa] AWB {prefix}-{serial} - requires agent credentials")

        result.status = "Tracking not available - Air Europa Cargo requires agent login"
        result.events = [
            TrackingEvent(
                timestamp=datetime.now(UTC),
                status_code=StatusCode.UNK,
                description="Air Europa Cargo (UX) tracking is managed by CRS Airlines "
                           "through their Cargospot platform and requires registered agent "
                           "credentials. Please track through your freight forwarder.",
            )
        ]

        return result

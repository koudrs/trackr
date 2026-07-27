"""AeroLogic tracking (prefix 550) - No public tracking available."""

import logging
from datetime import datetime, UTC

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker

logger = logging.getLogger(__name__)


class AeroLogicTracker(CarrierTracker):
    """
    AeroLogic (3S) - prefix 550.
    Joint venture between DHL Express and Lufthansa Cargo.
    Based in Leipzig/Halle, Germany. Fleet: 28 Boeing 777F.

    NOTE: AeroLogic does not have a public tracking portal.
    They operate aircraft for DHL and Lufthansa Cargo only.
    Tracking must be done through the original shipper (DHL or Lufthansa).
    """

    name = "AeroLogic"
    iata_code = "3S"
    prefixes = ["550"]

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Return carrier info with no-tracking-available status."""
        result = self.empty_result(prefix, serial, TrackingSource.API)

        logger.info(f"[AeroLogic] AWB {prefix}-{serial} - no public tracking available")

        result.status = "Tracking not available - AeroLogic has no public tracking portal"
        result.events = [
            TrackingEvent(
                timestamp=datetime.now(UTC),
                status_code=StatusCode.UNK,
                description="AeroLogic (3S) is a cargo operator for DHL Express and Lufthansa Cargo. "
                           "Please track this shipment through your freight forwarder or the original booking party.",
            )
        ]

        return result

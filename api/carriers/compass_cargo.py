"""Compass Air Cargo tracking (prefix 715) - No public tracking available."""

import logging
from datetime import datetime, UTC

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker

logger = logging.getLogger(__name__)


class CompassCargoTracker(CarrierTracker):
    """
    Compass Air Cargo - prefix 715.
    Bulgarian cargo airline based in Sofia, operating Boeing 737F/747F.

    NOTE: Compass Air Cargo has no public tracking portal. Their site
    (compasscargo.eu) is a corporate WordPress site with no AWB lookup form
    and no third-party tracking platform behind it.
    Tracking must be done through the freight forwarder or booking party.
    """

    name = "Compass Air Cargo"
    iata_code = None
    prefixes = ["715"]

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Return carrier info with no-tracking-available status."""
        result = self.empty_result(prefix, serial, TrackingSource.API)

        logger.info(f"[CompassCargo] AWB {prefix}-{serial} - no public tracking available")

        result.status = "Tracking not available - Compass Air Cargo has no public tracking portal"
        result.events = [
            TrackingEvent(
                timestamp=datetime.now(UTC),
                status_code=StatusCode.UNK,
                description="Compass Air Cargo is a Bulgarian cargo operator without a public "
                           "tracking portal. Please track this shipment through your freight "
                           "forwarder or the original booking party.",
            )
        ]

        return result

"""MSC Air Cargo tracking (prefix 233)."""

import json
import logging
import os
from datetime import datetime

import httpx

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker

logger = logging.getLogger(__name__)

# ScraperAPI for Akamai bypass
SCRAPER_API_KEY = os.getenv("SCRAPPER_API_KEY", "")


class MSCAirCargoTracker(CarrierTracker):
    """
    MSC Air Cargo (8M) - prefix 233.

    API: GET https://www.mscaircargo.com/api/aircargo/tracking/{prefix}-{serial}
    Protected by Akamai WAF - requires ScraperAPI proxy for datacenter IPs.
    """

    name = "MSC Air Cargo"
    iata_code = "8M"
    prefixes = ["233"]

    API_URL = "https://www.mscaircargo.com/api/aircargo/tracking"

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
        """Track MSC Air Cargo shipment."""
        result = self.empty_result(prefix, serial)

        url = f"{self.API_URL}/{prefix}-{serial}"

        try:
            if SCRAPER_API_KEY:
                # Use ScraperAPI to bypass Akamai WAF
                logger.info(f"[MSC] Using ScraperAPI for {prefix}-{serial}")
                async with httpx.AsyncClient(timeout=90.0) as client:
                    response = await client.get(
                        "http://api.scraperapi.com",
                        params={
                            "api_key": SCRAPER_API_KEY,
                            "url": url,
                        },
                    )
                    response.raise_for_status()
                    data = response.json()
            else:
                # Direct call (works from residential IPs)
                logger.info(f"[MSC] Direct call for {prefix}-{serial}")
                async with self.create_http_client() as client:
                    response = await client.get(
                        url,
                        headers={
                            "Accept": "application/json",
                            "Referer": "https://www.mscaircargo.com/",
                        },
                    )
                    response.raise_for_status()
                    data = response.json()

        except Exception as e:
            logger.error(f"[MSC] Error: {e}")
            result.status = f"Tracking error: {str(e)[:50]}"
            return result

        if not data or not data.get("airway_bill"):
            return result

        awb_data = data["airway_bill"]

        # Extract shipment info
        result.origin = awb_data.get("origin")
        result.destination = awb_data.get("destination")
        result.pieces = awb_data.get("stated_pieces")
        result.weight = awb_data.get("stated_weight")

        # Parse events (deduplicate by timestamp + event_type)
        seen_events = set()
        events: list[TrackingEvent] = []

        for item in data.get("events", []):
            # Parse timestamp
            timestamp = None
            if utc_time := item.get("utc_event_time"):
                try:
                    timestamp = datetime.fromisoformat(utc_time.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    pass

            # Map event type
            event_type = item.get("event_type", "").lower()
            status_code = self.map_status(event_type)

            # Get flight info
            flight = None
            if flight_data := item.get("flight"):
                flight = flight_data.get("flight_number")

            # Dedupe key
            event_key = (timestamp, event_type, item.get("airport_code"))
            if event_key in seen_events:
                continue
            seen_events.add(event_key)

            event = TrackingEvent(
                timestamp=timestamp,
                status_code=status_code,
                description=event_type.upper(),
                location=item.get("airport_code"),
                flight=flight,
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

"""Korean Air Cargo tracking (prefix 180)."""

import logging
import random
import string
import time
import urllib.parse
from datetime import datetime, timedelta, timezone

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker

logger = logging.getLogger(__name__)

# Module-level token cache (shared across requests)
_token_cache: dict[str, any] = {
    "auth_token": None,
    "session_id": None,
    "expires_at": None,
}
_TOKEN_TTL_MINUTES = 30  # Refresh token every 30 minutes


class KoreanAirTracker(CarrierTracker):
    """
    Korean Air Cargo (KE) - prefix 180.

    API: POST https://cargo.koreanair.com/cargoportal/services/trackawb
    Requires sessionId and txnId in payload.
    """

    name = "Korean Air Cargo"
    iata_code = "KE"
    prefixes = ["180"]

    API_URL = "https://cargo.koreanair.com/cargoportal/services/trackawb"

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
        "awd": StatusCode.NFD,
        "dlv": StatusCode.DLV,
        "ddl": StatusCode.DDL,
    }

    def _generate_session_id(self) -> str:
        """Generate a random session ID similar to Korean Air's format."""
        part1 = ''.join(random.choices(string.ascii_letters + string.digits, k=14))
        part2 = ''.join(random.choices(string.ascii_letters + string.digits, k=30))
        return f"{part1},{part2}"

    def _generate_txn_id(self) -> str:
        """Generate transaction ID: random prefix + timestamp."""
        prefix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))
        return f"{prefix}{int(time.time() * 1000)}"

    def _format_time(self) -> str:
        """Format current time for API."""
        return datetime.utcnow().strftime("%d %b %Y %H:%M")

    async def _get_auth_token(self, client) -> tuple[str, str] | None:
        """Get cached auth token or fetch new one if expired."""
        global _token_cache

        now = datetime.now(timezone.utc)

        # Check if cached token is still valid
        if (
            _token_cache["auth_token"]
            and _token_cache["expires_at"]
            and now < _token_cache["expires_at"]
        ):
            logger.debug("[KoreanAir] Using cached auth token")
            return _token_cache["auth_token"], _token_cache["session_id"]

        # Fetch new token
        logger.info("[KoreanAir] Fetching new auth token")
        auth_response = await client.get(
            "https://cargo.koreanair.com/tracking",
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
        )

        # Extract Authorization cookie
        auth_token = None
        session_id = self._generate_session_id()

        for cookie in auth_response.cookies.jar:
            if cookie.name == "Authorization":
                auth_token = cookie.value
            elif cookie.name.startswith("SSESS"):
                session_id = urllib.parse.unquote(cookie.value)

        if not auth_token:
            logger.error("[KoreanAir] Failed to get auth token")
            return None

        # Cache the token
        _token_cache["auth_token"] = auth_token
        _token_cache["session_id"] = session_id
        _token_cache["expires_at"] = now + timedelta(minutes=_TOKEN_TTL_MINUTES)

        logger.info(f"[KoreanAir] Cached new token, expires at {_token_cache['expires_at']}")
        return auth_token, session_id

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track Korean Air shipment."""
        result = self.empty_result(prefix, serial)

        async with self.create_http_client() as client:
            # Get auth token (cached or fresh)
            auth_data = await self._get_auth_token(client)
            if not auth_data:
                result.status = "Failed to get auth token"
                return result

            auth_token, session_id = auth_data

            payload = {
                "payLoad": [
                    {
                        "awbPrefix": prefix,
                        "awbDocNo": serial
                    }
                ],
                "generalInfo": {
                    "sessionId": session_id,
                    "lang": "EN",
                    "time": self._format_time(),
                    "txnId": self._generate_txn_id()
                },
                "userInfo": {
                    "userId": "",
                    "agentCode": "",
                    "region": "America",
                    "branch": "",
                    "userType": "GUEST"
                }
            }

            response = await client.post(
                self.API_URL,
                json=payload,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/plain, */*",
                    "Authorization": auth_token,
                    "Referer": "https://cargo.koreanair.com/tracking",
                    "Origin": "https://cargo.koreanair.com",
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                },
            )

            # If 401, token expired - clear cache and retry once
            if response.status_code == 401:
                logger.warning("[KoreanAir] Token expired, refreshing...")
                _token_cache["auth_token"] = None
                _token_cache["expires_at"] = None

                auth_data = await self._get_auth_token(client)
                if not auth_data:
                    result.status = "Failed to refresh auth token"
                    return result

                auth_token, session_id = auth_data
                payload["generalInfo"]["sessionId"] = session_id

                response = await client.post(
                    self.API_URL,
                    json=payload,
                    headers={
                        "Content-Type": "application/json",
                        "Accept": "application/json, text/plain, */*",
                        "Authorization": auth_token,
                        "Referer": "https://cargo.koreanair.com/tracking",
                        "Origin": "https://cargo.koreanair.com",
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    },
                )

            response.raise_for_status()
            data = response.json()

        # Check for valid tracking data
        payload_data = data.get("payLoad", [])
        if not payload_data:
            return result

        tracking = payload_data[0]

        # Extract shipment info
        result.origin = tracking.get("origin")
        result.destination = tracking.get("destination")
        result.pieces = tracking.get("pieces")
        result.status = tracking.get("shipmentStatus")

        # Get weight
        wgt_detail = tracking.get("wgtDetail", {})
        if wgt_detail:
            result.weight = wgt_detail.get("quantity")

        # Parse events
        events: list[TrackingEvent] = []
        event_details = tracking.get("eventDetails", [])

        for item in event_details:
            # Parse timestamp (use UTC)
            timestamp = None
            if date_str := item.get("eventDateTimeUTC"):
                try:
                    timestamp = datetime.strptime(date_str, "%d %b %Y %H:%M:%S")
                except (ValueError, TypeError):
                    pass

            # Map event code
            event_code = item.get("eventCode", "").lower()
            status_code = self.map_status(event_code)

            # Build flight number
            flight = None
            flt_detail = item.get("fltDetail", {})
            if flt_detail:
                carrier = flt_detail.get("carCode", "")
                flt_no = flt_detail.get("fltNo", "")
                if carrier and flt_no:
                    flight = f"{carrier}{flt_no}"

            event = TrackingEvent(
                timestamp=timestamp,
                status_code=status_code,
                description=item.get("eventDesc", ""),
                location=item.get("arpCode"),
                flight=flight,
                pieces=item.get("pieces"),
                weight=item.get("weight"),
            )
            events.append(event)

        # Sort by timestamp (newest first)
        events.sort(key=lambda e: e.timestamp or datetime.min, reverse=True)

        result.events = events
        result.source = TrackingSource.API

        return result

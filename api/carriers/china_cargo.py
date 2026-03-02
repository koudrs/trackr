"""China Cargo Airlines tracking (prefix 112) - requires captcha OCR."""

import io
from datetime import datetime

import httpx
import pytesseract
from PIL import Image, ImageFilter

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource

from .base import CarrierTracker


class ChinaCargoTracker(CarrierTracker):
    """
    China Cargo Airlines (CK) - prefix 112.

    Requires captcha OCR:
    1. GET https://www.ckair.com/api/verifyCode → captcha image + JSESSIONID cookie
    2. OCR the 6-digit captcha with tesseract
    3. GET https://www.ckair.com/awb/queryInfo?no={awb11}&verifyCode={code} with cookie

    Retries up to 3 times if OCR fails.
    """

    name = "China Cargo Airlines"
    iata_code = "CK"
    prefixes = ["112", "781"]

    CAPTCHA_URL = "https://www.ckair.com/api/verifyCode"
    QUERY_URL = "https://www.ckair.com/awb/queryInfo"

    MAX_RETRIES = 3

    # Map Chinese status types to IATA codes
    CHINESE_STATUS_MAP = {
        "运单接收": StatusCode.RCS,
        "航班关闭": StatusCode.MAN,
        "出港装机": StatusCode.DEP,
        "航班起飞": StatusCode.DEP,
        "航班到达": StatusCode.ARR,
        "进港卸机": StatusCode.RCF,
        "提货通知": StatusCode.NFD,
        "提货完成": StatusCode.DLV,
    }

    # Translate Chinese status to English
    CHINESE_TRANSLATIONS = {
        "运单接收": "Shipment Received",
        "航班关闭": "Flight Closed / ULD Built",
        "出港装机": "Loaded on Aircraft",
        "航班起飞": "Flight Departed",
        "航班到达": "Flight Arrived",
        "进港卸机": "Unloaded from Aircraft",
        "提货通知": "Ready for Pickup",
        "提货完成": "Delivered",
    }

    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """Track China Cargo shipment with captcha solving."""
        result = self.empty_result(prefix, serial)
        awb11 = self.awb_11(prefix, serial)

        for attempt in range(self.MAX_RETRIES):
            try:
                data = await self._fetch_with_captcha(awb11)
                if data is not None and isinstance(data, dict) and data.get("data"):
                    return self._parse_response(result, data)
            except Exception:
                if attempt == self.MAX_RETRIES - 1:
                    raise
                continue

        return result

    async def _fetch_with_captcha(self, awb11: str) -> dict | None:
        """Fetch captcha, solve it, and query tracking info."""
        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            # Step 1: Get captcha image and session cookie
            captcha_response = await client.get(self.CAPTCHA_URL)
            captcha_response.raise_for_status()

            # Step 2: OCR the captcha
            captcha_code = self._solve_captcha(captcha_response.content)
            if not captcha_code or len(captcha_code) != 6:
                return None

            # Step 3: Query with captcha code (pass cookies from captcha request)
            query_response = await client.get(
                self.QUERY_URL,
                params={"no": awb11, "verifyCode": captcha_code},
                cookies=captcha_response.cookies,
            )
            query_response.raise_for_status()

            data = query_response.json()

            # Check if request was successful
            if data.get("result") != "SUCCESS":
                return None

            return data

    def _solve_captcha(self, image_bytes: bytes) -> str | None:
        """OCR the captcha image to extract 6-digit code."""
        try:
            image = Image.open(io.BytesIO(image_bytes))
            image = image.convert("L")
            image = image.point(lambda x: 255 if x > 120 else 0)
            image = image.filter(ImageFilter.MedianFilter(size=3))

            code = pytesseract.image_to_string(
                image,
                config="--psm 7 -c tessedit_char_whitelist=0123456789",
            )

            code = "".join(c for c in code if c.isdigit())
            return code if len(code) == 6 else None

        except Exception:
            return None

    def _parse_response(self, result: TrackingResult, data: dict) -> TrackingResult:
        """Parse China Cargo API response."""
        shipments = data.get("data", [])
        if not shipments:
            return result

        shipment = shipments[0]

        # Basic info
        result.pieces = self._parse_int(shipment.get("pieces"))
        result.weight = self._parse_float(shipment.get("weight"))

        # Get origin/destination from cargoSegmentInfoDTOList
        segments = shipment.get("cargoSegmentInfoDTOList", [])
        if segments:
            result.origin = segments[0].get("airportStation")
            result.destination = segments[-1].get("airportStation")

        # Parse events from nodeTrailOuterInfoDTOList
        events: list[TrackingEvent] = []
        nodes = shipment.get("nodeTrailOuterInfoDTOList", [])

        for node in nodes:
            flight_no = node.get("flightNo")
            ori_airport = node.get("oriAirport")

            # Each node has trailNodeDTOList with detailed events
            trails = node.get("trailNodeDTOList", [])

            for trail in trails:
                timestamp = self._parse_timestamp(trail.get("operateTime"))
                status_type = trail.get("statusType", "")

                # Map Chinese status to IATA code
                status_code = self.CHINESE_STATUS_MAP.get(status_type, StatusCode.UNK)

                # Translate Chinese status to English
                description = self.CHINESE_TRANSLATIONS.get(status_type, status_type)

                # Get flight from trail or parent node
                trail_flight = trail.get("flightNo") or flight_no

                # Location from trail or parent node
                location = trail.get("operateAirportStation") or ori_airport

                event = TrackingEvent(
                    timestamp=timestamp,
                    status_code=status_code,
                    description=description,
                    location=location,
                    flight=trail_flight if trail_flight else None,
                    pieces=self._parse_int(node.get("pieces")),
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
            if isinstance(value, str):
                value = value.replace(",", "")
            return float(value)
        except (ValueError, TypeError):
            return None

    def _parse_timestamp(self, date_str: str | None) -> datetime | None:
        """Parse China Cargo date formats."""
        if not date_str:
            return None
        try:
            return datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S")
        except (ValueError, TypeError):
            return None

"""Base class for all carrier trackers."""

import asyncio
import os
from abc import ABC, abstractmethod
from datetime import datetime, UTC

import httpx

from api.models import StatusCode, TrackingResult, TrackingSource

# Detect if running in container (Docker/Render/DigitalOcean/k8s)
def _is_container() -> bool:
    """Detect container environment."""
    # Docker
    if os.path.exists("/.dockerenv"):
        return True
    # Kubernetes (DigitalOcean, etc.)
    if os.environ.get("KUBERNETES_SERVICE_HOST"):
        return True
    # Render
    if os.environ.get("RENDER"):
        return True
    # DigitalOcean App Platform
    if os.environ.get("DIGITALOCEAN_APP_PLATFORM"):
        return True
    # Check cgroup for docker/k8s
    try:
        with open("/proc/1/cgroup", "r") as f:
            return "docker" in f.read() or "kubepods" in f.read()
    except Exception:
        pass
    return False

IS_CONTAINER = _is_container()


class CarrierTracker(ABC):
    """Abstract base class for carrier-specific tracking implementations."""

    # Subclasses must define these
    name: str = "Unknown Carrier"
    iata_code: str | None = None
    prefixes: list[str] = []  # AWB prefixes this carrier handles

    # Shared HTTP client settings
    timeout: float = 30.0
    headers: dict[str, str] = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }

    # Status code mapping - subclasses can override
    STATUS_MAP: dict[str, StatusCode] = {
        # Common variations
        "booked": StatusCode.BKD,
        "bkd": StatusCode.BKD,
        "received": StatusCode.RCS,
        "rcs": StatusCode.RCS,
        "acceptance": StatusCode.RCS,
        "manifested": StatusCode.MAN,
        "man": StatusCode.MAN,
        "departed": StatusCode.DEP,
        "dep": StatusCode.DEP,
        "departure": StatusCode.DEP,
        "arrived": StatusCode.ARR,
        "arr": StatusCode.ARR,
        "arrival": StatusCode.ARR,
        "rcf": StatusCode.RCF,
        "delivered": StatusCode.DLV,
        "dlv": StatusCode.DLV,
        "delivery": StatusCode.DLV,
        "nfd": StatusCode.NFD,
        "notify": StatusCode.NFD,
        "delayed": StatusCode.DDL,
        "ddl": StatusCode.DDL,
    }

    @abstractmethod
    async def track(self, prefix: str, serial: str) -> TrackingResult:
        """
        Track a shipment by AWB components.

        Args:
            prefix: 3-digit airline prefix (e.g., "810")
            serial: 8-digit AWB serial number (e.g., "50671456")

        Returns:
            TrackingResult with normalized shipment data
        """
        pass

    def format_awb(self, prefix: str, serial: str) -> str:
        """Format AWB as XXX-XXXXXXXX."""
        return f"{prefix}-{serial}"

    def awb_11(self, prefix: str, serial: str) -> str:
        """Format AWB as 11 digits without hyphen."""
        return f"{prefix}{serial}"

    def map_status(self, raw_status: str) -> StatusCode:
        """Map carrier-specific status to IATA standard code."""
        normalized = raw_status.lower().strip()
        return self.STATUS_MAP.get(normalized, StatusCode.UNK)

    def create_http_client(self) -> httpx.AsyncClient:
        """Create configured async HTTP client."""
        return httpx.AsyncClient(
            timeout=self.timeout,
            headers=self.headers,
            follow_redirects=True,
        )

    def empty_result(
        self, prefix: str, serial: str, source: TrackingSource = TrackingSource.API
    ) -> TrackingResult:
        """Create empty result template."""
        return TrackingResult(
            awb=self.format_awb(prefix, serial),
            airline=self.name,
            iata_code=self.iata_code,
            source=source,
            tracked_at=datetime.now(UTC),
        )


class ScraplingTracker(CarrierTracker):
    """
    Base class for carriers that use Scrapling for anti-bot bypass.

    Provides unified methods for fetching and parsing HTML with:
    - StealthyFetcher for Cloudflare/Akamai bypass
    - Adaptive CSS selectors that survive layout changes
    - Built-in retry logic

    Configured with Docker-compatible Chrome args for container environments.
    """

    # Scrapling settings
    use_stealth: bool = True  # Use StealthyFetcher vs regular Fetcher
    wait_for_network: bool = True  # Wait for network idle
    headless: bool = True

    def _get_fetcher(self):
        """Get appropriate Scrapling fetcher."""
        if self.use_stealth:
            from scrapling.fetchers import StealthyFetcher
            return StealthyFetcher
        else:
            from scrapling.fetchers import Fetcher
            return Fetcher

    def _fetch_sync(self, url: str) -> tuple:
        """
        Synchronous fetch using Scrapling.

        Returns:
            Tuple of (page_object, html_content, text_content)
        """
        if self.use_stealth:
            from scrapling.fetchers import StealthyFetcher

            # Container-specific options (Docker/Render/DigitalOcean)
            fetch_kwargs = {
                "headless": self.headless,
                "network_idle": self.wait_for_network,
            }
            if IS_CONTAINER:
                # Fix for Docker shared memory issues
                # extra_flags must be a tuple (Scrapling concatenates with DEFAULT_ARGS tuple)
                fetch_kwargs["extra_flags"] = (
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--no-zygote",
                    "--single-process",
                )

            page = StealthyFetcher.fetch(url, **fetch_kwargs)
        else:
            # Regular Fetcher uses .get() method
            from scrapling.fetchers import Fetcher
            page = Fetcher.get(url)

        return page, page.html_content, page.get_all_text()

    async def fetch_page(self, url: str) -> tuple:
        """
        Async wrapper for Scrapling fetch.

        Returns:
            Tuple of (page_object, html_content, text_content)
        """
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._fetch_sync, url)

    def css(self, page, selector: str, adaptive: bool = True):
        """
        Query elements with optional adaptive mode.

        Adaptive mode helps selectors survive minor HTML changes.
        """
        return page.css(selector, adaptive=adaptive)

    def css_first(self, page, selector: str, adaptive: bool = True):
        """Get first matching element."""
        elements = self.css(page, selector, adaptive)
        return elements[0] if elements else None

    def extract_text(self, element, default: str = "") -> str:
        """Safely extract text from element."""
        if element is None:
            return default
        try:
            return element.text.strip() if hasattr(element, 'text') else str(element).strip()
        except Exception:
            return default

    def extract_attr(self, element, attr: str, default: str = "") -> str:
        """Safely extract attribute from element."""
        if element is None:
            return default
        try:
            return element.attrib.get(attr, default)
        except Exception:
            return default

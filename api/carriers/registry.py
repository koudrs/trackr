"""Carrier registry - maps AWB prefixes to tracker implementations."""

from .afklcargo import AFKLCargoTracker
from .amerijet import AmerijetTracker
from .atlas import AtlasAirTracker
from .base import CarrierTracker
from .china_cargo import ChinaCargoTracker
from .dhl_aviation import DHLAviationTracker
from .iag_cargo import IAGCargoTracker
from .smartkargo import SmartKargoTracker
from .turkish import TurkishCargoTracker

# Instantiate all trackers
_TRACKERS: list[CarrierTracker] = [
    AmerijetTracker(),
    TurkishCargoTracker(),
    AtlasAirTracker(),
    ChinaCargoTracker(),
    AFKLCargoTracker(),
    SmartKargoTracker(),
    DHLAviationTracker(),
    IAGCargoTracker(),
]

# Build prefix -> tracker mapping
_PREFIX_MAP: dict[str, CarrierTracker] = {}
for tracker in _TRACKERS:
    for prefix in tracker.prefixes:
        _PREFIX_MAP[prefix] = tracker


def get_carrier(prefix: str) -> CarrierTracker | None:
    """
    Get tracker for given AWB prefix.

    Args:
        prefix: 3-digit AWB prefix (e.g., "810")

    Returns:
        CarrierTracker instance or None if prefix not supported
    """
    return _PREFIX_MAP.get(prefix)


def list_carriers() -> list[dict]:
    """
    List all registered carriers.

    Returns:
        List of carrier info dicts with name, iata_code, prefixes
    """
    return [
        {
            "name": tracker.name,
            "iata_code": tracker.iata_code,
            "prefixes": tracker.prefixes,
        }
        for tracker in _TRACKERS
    ]


def is_prefix_supported(prefix: str) -> bool:
    """Check if AWB prefix is supported."""
    return prefix in _PREFIX_MAP

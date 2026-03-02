"""Tests for carrier registry and base functionality."""

import pytest

from api.carriers.registry import get_carrier, is_prefix_supported, list_carriers
from api.models import StatusCode


class TestCarrierRegistry:
    """Tests for carrier registry functions."""

    def test_list_carriers_returns_all(self):
        """Test list_carriers returns all registered carriers."""
        carriers = list_carriers()
        assert len(carriers) >= 8  # We have at least 8 carriers

        # Check each carrier has required fields
        for carrier in carriers:
            assert "name" in carrier
            assert "iata_code" in carrier
            assert "prefixes" in carrier
            assert len(carrier["prefixes"]) > 0

    def test_get_carrier_valid_prefix(self):
        """Test get_carrier returns tracker for valid prefix."""
        # Test a few known prefixes
        known_prefixes = ["810", "235", "074", "125", "936"]

        for prefix in known_prefixes:
            tracker = get_carrier(prefix)
            assert tracker is not None, f"Prefix {prefix} should have a tracker"
            assert prefix in tracker.prefixes

    def test_get_carrier_invalid_prefix(self):
        """Test get_carrier returns None for invalid prefix."""
        tracker = get_carrier("999")
        assert tracker is None

    def test_is_prefix_supported(self):
        """Test is_prefix_supported function."""
        assert is_prefix_supported("810") is True
        assert is_prefix_supported("999") is False

    def test_all_prefixes_unique(self):
        """Test that no prefix is registered to multiple carriers."""
        carriers = list_carriers()
        all_prefixes = []

        for carrier in carriers:
            all_prefixes.extend(carrier["prefixes"])

        # Check for duplicates
        assert len(all_prefixes) == len(set(all_prefixes)), "Duplicate prefixes found"


class TestCarrierBase:
    """Tests for base carrier functionality."""

    def test_format_awb(self):
        """Test AWB formatting."""
        tracker = get_carrier("810")
        assert tracker.format_awb("810", "12345678") == "810-12345678"

    def test_map_status_known_codes(self):
        """Test status code mapping for known codes."""
        tracker = get_carrier("810")

        # Test common IATA codes
        assert tracker.map_status("BKD") == StatusCode.BKD
        assert tracker.map_status("RCS") == StatusCode.RCS
        assert tracker.map_status("DEP") == StatusCode.DEP
        assert tracker.map_status("ARR") == StatusCode.ARR
        assert tracker.map_status("DLV") == StatusCode.DLV

    def test_map_status_unknown_code(self):
        """Test status code mapping for unknown codes returns UNK."""
        tracker = get_carrier("810")
        assert tracker.map_status("UNKNOWN") == StatusCode.UNK

    def test_map_status_case_insensitive(self):
        """Test status code mapping is case insensitive."""
        tracker = get_carrier("810")
        assert tracker.map_status("bkd") == StatusCode.BKD
        assert tracker.map_status("BKD") == StatusCode.BKD
        assert tracker.map_status("Bkd") == StatusCode.BKD

    def test_empty_result_structure(self):
        """Test empty_result creates proper structure."""
        tracker = get_carrier("810")
        result = tracker.empty_result("810", "12345678")

        assert result.awb == "810-12345678"
        assert result.events == []
        assert result.origin is None
        assert result.destination is None
        assert result.pieces is None
        assert result.weight is None


class TestCarrierPrefixes:
    """Tests for specific carrier prefix mappings."""

    def test_amerijet_prefix(self):
        """Test Amerijet carrier prefix."""
        tracker = get_carrier("810")
        assert "Amerijet" in tracker.name
        assert "810" in tracker.prefixes

    def test_turkish_prefix(self):
        """Test Turkish Cargo prefix."""
        tracker = get_carrier("235")
        assert tracker.name == "Turkish Cargo"
        assert "235" in tracker.prefixes

    def test_afkl_prefixes(self):
        """Test Air France/KLM prefixes."""
        for prefix in ["057", "074", "129"]:
            tracker = get_carrier(prefix)
            assert tracker is not None
            assert "KLM" in tracker.name or "Air France" in tracker.name

    def test_iag_prefixes(self):
        """Test IAG Cargo prefixes."""
        for prefix in ["053", "060", "075", "125"]:
            tracker = get_carrier(prefix)
            assert tracker is not None
            assert tracker.name == "IAG Cargo"

    def test_dhl_aviation_prefixes(self):
        """Test DHL Aviation prefixes."""
        for prefix in ["155", "423", "615", "936", "947", "992"]:
            tracker = get_carrier(prefix)
            assert tracker is not None
            assert "DHL" in tracker.name

    def test_atlas_air_prefixes(self):
        """Test Atlas Air prefixes."""
        for prefix in ["369", "403"]:
            tracker = get_carrier(prefix)
            assert tracker is not None
            assert "Atlas" in tracker.name

    def test_china_cargo_prefixes(self):
        """Test China Cargo prefixes."""
        for prefix in ["112", "781"]:
            tracker = get_carrier(prefix)
            assert tracker is not None
            assert "China" in tracker.name

    def test_smartkargo_prefixes(self):
        """Test SmartKargo/MAS Air prefixes."""
        for prefix in ["865", "870"]:
            tracker = get_carrier(prefix)
            assert tracker is not None

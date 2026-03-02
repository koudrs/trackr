"""Tests for data models."""

from datetime import datetime

import pytest

from api.models import StatusCode, TrackingEvent, TrackingResult, TrackingSource


class TestStatusCode:
    """Tests for StatusCode enum."""

    def test_all_iata_codes_present(self):
        """Test all standard IATA status codes are defined."""
        expected_codes = [
            "BKD", "RCS", "MAN", "DEP", "ARR", "RCF",
            "NFD", "DLV", "DDL", "UNK"
        ]

        for code in expected_codes:
            assert hasattr(StatusCode, code), f"StatusCode.{code} should exist"

    def test_status_code_values(self):
        """Test status code enum values."""
        assert StatusCode.BKD.value == "BKD"
        assert StatusCode.DLV.value == "DLV"
        assert StatusCode.UNK.value == "UNK"


class TestTrackingSource:
    """Tests for TrackingSource enum."""

    def test_tracking_sources(self):
        """Test tracking source options."""
        assert TrackingSource.API.value == "api"
        assert TrackingSource.HTML.value == "html"


class TestTrackingEvent:
    """Tests for TrackingEvent model."""

    def test_event_creation_minimal(self):
        """Test creating event with minimal fields."""
        event = TrackingEvent(
            status_code=StatusCode.DEP,
            description="Departed",
        )

        assert event.status_code == StatusCode.DEP
        assert event.description == "Departed"
        assert event.timestamp is None
        assert event.location is None
        assert event.flight is None
        assert event.pieces is None

    def test_event_creation_full(self):
        """Test creating event with all fields."""
        ts = datetime(2024, 1, 15, 10, 30, 0)
        event = TrackingEvent(
            timestamp=ts,
            status_code=StatusCode.DEP,
            description="Departed on flight",
            location="MIA",
            flight="AA123",
            pieces=10,
        )

        assert event.timestamp == ts
        assert event.status_code == StatusCode.DEP
        assert event.description == "Departed on flight"
        assert event.location == "MIA"
        assert event.flight == "AA123"
        assert event.pieces == 10


class TestTrackingResult:
    """Tests for TrackingResult model."""

    def test_result_creation_minimal(self):
        """Test creating result with minimal required fields."""
        result = TrackingResult(awb="810-12345678", airline="Amerijet")

        assert result.awb == "810-12345678"
        assert result.airline == "Amerijet"
        assert result.events == []
        assert result.origin is None
        assert result.destination is None
        assert result.pieces is None
        assert result.weight is None
        assert result.status is None
        assert result.source == TrackingSource.API

    def test_result_creation_full(self):
        """Test creating result with all fields."""
        event = TrackingEvent(
            status_code=StatusCode.DLV,
            description="Delivered",
        )

        result = TrackingResult(
            awb="810-12345678",
            airline="Amerijet",
            iata_code="M6",
            origin="MIA",
            destination="BOG",
            pieces=5,
            weight=150.5,
            status="Delivered",
            events=[event],
            source=TrackingSource.HTML,
        )

        assert result.awb == "810-12345678"
        assert result.airline == "Amerijet"
        assert result.iata_code == "M6"
        assert result.origin == "MIA"
        assert result.destination == "BOG"
        assert result.pieces == 5
        assert result.weight == 150.5
        assert result.status == "Delivered"
        assert len(result.events) == 1
        assert result.events[0].status_code == StatusCode.DLV
        assert result.source == TrackingSource.HTML

    def test_result_json_serialization(self):
        """Test result can be serialized to JSON."""
        result = TrackingResult(
            awb="810-12345678",
            airline="Test Airline",
            origin="MIA",
            destination="BOG",
            pieces=5,
            weight=150.5,
        )

        json_str = result.model_dump_json()
        assert "810-12345678" in json_str
        assert "Test Airline" in json_str
        assert "MIA" in json_str
        assert "BOG" in json_str

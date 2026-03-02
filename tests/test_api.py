"""Tests for the main API endpoints."""

import pytest


@pytest.mark.asyncio
async def test_root_health(client):
    """Test root endpoint returns health status."""
    response = await client.get("/")
    assert response.status_code == 200

    data = response.json()
    assert data["status"] == "ok"
    assert data["service"] == "KoudrsTracking"
    assert "version" in data
    assert "carriers_loaded" in data
    assert data["carriers_loaded"] > 0


@pytest.mark.asyncio
async def test_health_endpoint(client):
    """Test /health endpoint."""
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


@pytest.mark.asyncio
async def test_list_carriers(client):
    """Test /carriers endpoint returns all carriers."""
    response = await client.get("/carriers")
    assert response.status_code == 200

    data = response.json()
    assert "carriers" in data
    assert len(data["carriers"]) > 0

    # Check carrier structure
    carrier = data["carriers"][0]
    assert "name" in carrier
    assert "iata_code" in carrier
    assert "prefixes" in carrier
    assert isinstance(carrier["prefixes"], list)


@pytest.mark.asyncio
async def test_track_invalid_awb_format(client):
    """Test tracking with invalid AWB format returns 400."""
    response = await client.get("/track/invalid")
    assert response.status_code == 400

    data = response.json()
    assert "Invalid AWB format" in data["detail"]["error"]


@pytest.mark.asyncio
async def test_track_unsupported_prefix(client):
    """Test tracking with unsupported prefix returns 404."""
    response = await client.get("/track/999-00000000")
    assert response.status_code == 404

    data = response.json()
    assert "not supported" in data["detail"]["error"]


@pytest.mark.asyncio
async def test_track_valid_format_without_dash(client):
    """Test tracking accepts AWB without dash."""
    # This should either work or return 404 (unsupported), not 400
    response = await client.get("/track/99900000000")
    # 404 = prefix not supported (which is fine)
    # 502 = carrier error (also acceptable for this test)
    assert response.status_code in [200, 404, 502]

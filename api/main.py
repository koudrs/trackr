"""FastAPI backend for AWB tracking."""

import asyncio
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from api.carriers import get_carrier, list_carriers
from api.models import TrackingError, TrackingResult

# Static files directory (Vite build output)
STATIC_DIR = Path(__file__).parent.parent / "front-vite" / "dist"

# AWB format: XXX-XXXXXXXX (3 digits - 8 digits)
AWB_PATTERN = re.compile(r"^(\d{3})-?(\d{8})$")

# Version info
VERSION = "0.1.0"
START_TIME: datetime | None = None


class HealthStatus(BaseModel):
    """Health check response model."""

    status: str
    service: str
    version: str
    uptime_seconds: float
    carriers_loaded: int
    prefixes_supported: int


class CarrierHealth(BaseModel):
    """Individual carrier health status."""

    name: str
    prefix: str
    status: str
    response_time_ms: float | None = None
    error: str | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    global START_TIME
    START_TIME = datetime.now()

    # Startup
    carriers = list_carriers()
    total_prefixes = sum(len(c["prefixes"]) for c in carriers)
    print(f"KoudrsTracking API v{VERSION} starting...")
    print(f"Loaded {len(carriers)} carriers with {total_prefixes} prefixes:")
    for c in carriers:
        print(f"  - {c['name']} ({c['iata_code']}): {c['prefixes']}")
    yield
    # Shutdown
    print("KoudrsTracking API shutting down...")


app = FastAPI(
    title="KoudrsTracking API",
    description="Air cargo AWB tracking across multiple carriers",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS - allow all origins for now (open API)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files if dist directory exists (production)
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")


@app.get("/api", response_model=HealthStatus)
@app.get("/api/", response_model=HealthStatus)
async def root() -> HealthStatus:
    """Health check endpoint."""
    carriers = list_carriers()
    total_prefixes = sum(len(c["prefixes"]) for c in carriers)
    uptime = (datetime.now() - START_TIME).total_seconds() if START_TIME else 0

    return HealthStatus(
        status="ok",
        service="KoudrsTracking",
        version=VERSION,
        uptime_seconds=uptime,
        carriers_loaded=len(carriers),
        prefixes_supported=total_prefixes,
    )


@app.get("/api/health")
async def health_check():
    """Simple health check for load balancers/monitoring."""
    return {"status": "healthy"}


@app.get("/api/health/carriers")
async def carriers_health() -> dict:
    """
    Check health of all carrier integrations.

    Tests a sample AWB for each carrier to verify connectivity.
    """
    # Sample AWBs for testing (use known format, may return no data but shouldn't error)
    test_awbs = {
        "810": "00000001",  # Amerijet
        "235": "00000001",  # Turkish
        "369": "00000001",  # Atlas
        "112": "00000001",  # China Cargo
        "074": "00000001",  # AFKL
        "865": "00000001",  # SmartKargo/MAS
        "936": "00000001",  # DHL Aviation
        "125": "00000001",  # IAG
    }

    results = []

    async def check_carrier(prefix: str, serial: str) -> CarrierHealth:
        carrier = get_carrier(prefix)
        if not carrier:
            return CarrierHealth(
                name="Unknown",
                prefix=prefix,
                status="error",
                error="Carrier not found",
            )

        start = datetime.now()
        try:
            await asyncio.wait_for(carrier.track(prefix, serial), timeout=30)
            elapsed = (datetime.now() - start).total_seconds() * 1000
            return CarrierHealth(
                name=carrier.name,
                prefix=prefix,
                status="ok",
                response_time_ms=round(elapsed, 2),
            )
        except asyncio.TimeoutError:
            return CarrierHealth(
                name=carrier.name,
                prefix=prefix,
                status="timeout",
                error="Request timed out after 30s",
            )
        except Exception as e:
            elapsed = (datetime.now() - start).total_seconds() * 1000
            return CarrierHealth(
                name=carrier.name,
                prefix=prefix,
                status="error",
                response_time_ms=round(elapsed, 2),
                error=str(e)[:100],
            )

    # Run all health checks in parallel
    tasks = [check_carrier(prefix, serial) for prefix, serial in test_awbs.items()]
    results = await asyncio.gather(*tasks)

    healthy = sum(1 for r in results if r.status == "ok")
    total = len(results)

    return {
        "summary": {
            "healthy": healthy,
            "total": total,
            "status": "healthy" if healthy == total else "degraded" if healthy > 0 else "unhealthy",
        },
        "carriers": [r.model_dump() for r in results],
    }


@app.get("/api/carriers")
async def get_carriers():
    """List all supported carriers."""
    return {"carriers": list_carriers()}


@app.get(
    "/api/track/{awb}",
    response_model=TrackingResult,
    responses={
        400: {"model": TrackingError, "description": "Invalid AWB format"},
        404: {"model": TrackingError, "description": "Carrier not supported"},
        502: {"model": TrackingError, "description": "Carrier API error"},
    },
)
async def track_awb(awb: str) -> TrackingResult:
    """
    Track an air waybill.

    Args:
        awb: AWB number in format XXX-XXXXXXXX or XXXXXXXXXXX (11 digits)

    Returns:
        TrackingResult with shipment status and events
    """
    # Parse and validate AWB
    match = AWB_PATTERN.match(awb)
    if not match:
        raise HTTPException(
            status_code=400,
            detail={
                "awb": awb,
                "error": "Invalid AWB format. Expected XXX-XXXXXXXX (e.g., 810-50671456)",
            },
        )

    prefix, serial = match.groups()

    # Find carrier for this prefix
    carrier = get_carrier(prefix)
    if not carrier:
        raise HTTPException(
            status_code=404,
            detail={
                "awb": f"{prefix}-{serial}",
                "error": f"Carrier with prefix {prefix} not supported",
                "suggestion": "Check /carriers for supported airlines",
            },
        )

    # Call carrier API
    try:
        result = await carrier.track(prefix, serial)
        return result
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail={
                "awb": f"{prefix}-{serial}",
                "error": f"Carrier API error: {str(e)}",
                "carrier": carrier.name,
            },
        )


@app.get("/{full_path:path}")
async def serve_spa(request: Request, full_path: str):
    """Serve frontend SPA for all non-API routes."""
    # Skip if static dir doesn't exist (dev mode)
    if not STATIC_DIR.exists():
        raise HTTPException(status_code=404, detail="Frontend not built")

    # Try to serve the exact file first
    file_path = STATIC_DIR / full_path
    if file_path.is_file():
        return FileResponse(file_path)

    # Otherwise serve index.html (SPA routing)
    index_path = STATIC_DIR / "index.html"
    if index_path.exists():
        return FileResponse(index_path)

    raise HTTPException(status_code=404, detail="Not found")


def run_server():
    """Run the API server (for use as console script)."""
    import uvicorn

    uvicorn.run("api.main:app", host="0.0.0.0", port=8000, reload=True)


if __name__ == "__main__":
    run_server()

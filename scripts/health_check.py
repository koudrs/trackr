#!/usr/bin/env python3
"""
Health check script for KoudrsTracking API.

Run periodically via cron to monitor service health and carrier availability.

Usage:
    python scripts/health_check.py [--url URL] [--verbose] [--notify]

Cron example (every 5 minutes):
    */5 * * * * cd /path/to/cargotkr && .venv/bin/python scripts/health_check.py >> /var/log/koudrs-health.log 2>&1
"""

import argparse
import json
import sys
from datetime import datetime
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

# Configuration
DEFAULT_API_URL = "http://localhost:8000"
TIMEOUT_SECONDS = 30


def check_health(api_url: str, verbose: bool = False) -> dict:
    """Check API health and carrier status."""
    results = {
        "timestamp": datetime.now().isoformat(),
        "api_url": api_url,
        "api_healthy": False,
        "carriers_status": None,
        "errors": [],
    }

    # Check basic health
    try:
        req = Request(f"{api_url}/health", headers={"Accept": "application/json"})
        with urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            data = json.loads(response.read().decode())
            results["api_healthy"] = data.get("status") == "healthy"
            if verbose:
                print(f"[OK] API health check passed")
    except (URLError, HTTPError) as e:
        results["errors"].append(f"API health check failed: {e}")
        if verbose:
            print(f"[ERROR] API health check failed: {e}")
        return results

    # Check API info
    try:
        req = Request(f"{api_url}/", headers={"Accept": "application/json"})
        with urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            data = json.loads(response.read().decode())
            results["version"] = data.get("version")
            results["uptime_seconds"] = data.get("uptime_seconds")
            results["carriers_loaded"] = data.get("carriers_loaded")
            results["prefixes_supported"] = data.get("prefixes_supported")
            if verbose:
                print(f"[OK] Version: {data.get('version')}")
                print(f"[OK] Uptime: {data.get('uptime_seconds', 0):.0f}s")
                print(f"[OK] Carriers: {data.get('carriers_loaded')}, Prefixes: {data.get('prefixes_supported')}")
    except (URLError, HTTPError) as e:
        results["errors"].append(f"API info check failed: {e}")

    # Check carriers health (optional, takes longer)
    if verbose:
        print("\nChecking carriers health (this may take a while)...")
        try:
            req = Request(f"{api_url}/health/carriers", headers={"Accept": "application/json"})
            with urlopen(req, timeout=120) as response:  # Longer timeout for carrier checks
                data = json.loads(response.read().decode())
                results["carriers_status"] = data

                summary = data.get("summary", {})
                print(f"\n[{'OK' if summary.get('status') == 'healthy' else 'WARN'}] Carriers: {summary.get('healthy')}/{summary.get('total')} healthy")

                for carrier in data.get("carriers", []):
                    status_icon = "OK" if carrier["status"] == "ok" else "ERROR"
                    time_ms = carrier.get("response_time_ms", "N/A")
                    print(f"  [{status_icon}] {carrier['name']} ({carrier['prefix']}): {carrier['status']} - {time_ms}ms")
                    if carrier.get("error"):
                        print(f"       Error: {carrier['error']}")

        except (URLError, HTTPError) as e:
            results["errors"].append(f"Carriers health check failed: {e}")
            print(f"[ERROR] Carriers health check failed: {e}")

    return results


def main():
    parser = argparse.ArgumentParser(description="KoudrsTracking API health check")
    parser.add_argument("--url", default=DEFAULT_API_URL, help=f"API URL (default: {DEFAULT_API_URL})")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument("--notify", action="store_true", help="Send notification on failure (requires setup)")

    args = parser.parse_args()

    results = check_health(args.url, verbose=args.verbose)

    if args.json:
        print(json.dumps(results, indent=2))
    elif not args.verbose:
        # Simple output for cron logs
        status = "OK" if results["api_healthy"] and not results["errors"] else "FAIL"
        print(f"[{results['timestamp']}] {status} - API: {'UP' if results['api_healthy'] else 'DOWN'}")
        for error in results["errors"]:
            print(f"  ERROR: {error}")

    # Exit code: 0 = healthy, 1 = unhealthy
    if not results["api_healthy"] or results["errors"]:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()

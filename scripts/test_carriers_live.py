#!/usr/bin/env python3
"""
Live integration tests for all carriers.

Tests real AWBs against each carrier to verify connectivity.
Run this periodically to ensure all integrations are working.

Usage:
    python scripts/test_carriers_live.py [--carrier PREFIX] [--verbose]
"""

import argparse
import asyncio
import sys
from datetime import datetime

# Add parent to path for imports
sys.path.insert(0, ".")

from api.carriers.registry import get_carrier, list_carriers


# Test AWBs - these should return data (or at least not error)
# Format: {prefix: serial}
TEST_AWBS = {
    # Real AWBs that returned data in testing
    "074": "71939976",  # AFKL - delivered
    # Add more test AWBs as they become available
}

# Fallback test serials (may return empty but shouldn't error)
FALLBACK_SERIAL = "00000001"


async def test_carrier(prefix: str, serial: str | None = None, verbose: bool = False) -> dict:
    """Test a single carrier with given AWB."""
    tracker = get_carrier(prefix)
    if not tracker:
        return {
            "prefix": prefix,
            "carrier": "Unknown",
            "status": "error",
            "error": "Prefix not registered",
        }

    test_serial = serial or TEST_AWBS.get(prefix) or FALLBACK_SERIAL
    awb = f"{prefix}-{test_serial}"

    result = {
        "prefix": prefix,
        "carrier": tracker.name,
        "awb": awb,
        "status": "unknown",
        "has_data": False,
        "events_count": 0,
        "response_time_ms": 0,
        "error": None,
    }

    start = datetime.now()
    try:
        tracking = await asyncio.wait_for(
            tracker.track(prefix, test_serial),
            timeout=60  # 60s timeout for slow carriers
        )
        elapsed = (datetime.now() - start).total_seconds() * 1000

        result["status"] = "ok"
        result["response_time_ms"] = round(elapsed, 2)
        result["has_data"] = bool(tracking.events or tracking.origin or tracking.status)
        result["events_count"] = len(tracking.events)

        if verbose:
            print(f"\n  AWB: {tracking.awb}")
            print(f"  Route: {tracking.origin} -> {tracking.destination}")
            print(f"  Status: {tracking.status}")
            print(f"  Events: {len(tracking.events)}")

    except asyncio.TimeoutError:
        result["status"] = "timeout"
        result["error"] = "Request timed out after 60s"
    except Exception as e:
        elapsed = (datetime.now() - start).total_seconds() * 1000
        result["status"] = "error"
        result["response_time_ms"] = round(elapsed, 2)
        result["error"] = str(e)[:200]

    return result


async def test_all_carriers(verbose: bool = False) -> list[dict]:
    """Test all registered carriers."""
    carriers = list_carriers()
    results = []

    print(f"\nTesting {len(carriers)} carriers...\n")
    print("-" * 70)

    for carrier in carriers:
        prefix = carrier["prefixes"][0]  # Test first prefix of each carrier
        print(f"Testing {carrier['name']} ({prefix})...", end=" ", flush=True)

        result = await test_carrier(prefix, verbose=verbose)
        results.append(result)

        if result["status"] == "ok":
            data_status = "with data" if result["has_data"] else "no data"
            print(f"OK ({result['response_time_ms']}ms, {data_status})")
        else:
            print(f"FAILED: {result['error'][:50]}")

    return results


def print_summary(results: list[dict]):
    """Print test summary."""
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)

    ok_count = sum(1 for r in results if r["status"] == "ok")
    with_data = sum(1 for r in results if r["has_data"])
    total = len(results)

    print(f"\nCarriers responding: {ok_count}/{total}")
    print(f"Carriers with data:  {with_data}/{total}")

    failed = [r for r in results if r["status"] != "ok"]
    if failed:
        print(f"\nFailed carriers:")
        for r in failed:
            print(f"  - {r['carrier']} ({r['prefix']}): {r['error']}")

    avg_time = sum(r["response_time_ms"] for r in results if r["status"] == "ok") / max(ok_count, 1)
    print(f"\nAverage response time: {avg_time:.0f}ms")


async def main():
    parser = argparse.ArgumentParser(description="Test carriers live")
    parser.add_argument("--carrier", "-c", help="Test specific carrier prefix")
    parser.add_argument("--awb", "-a", help="Test specific AWB (format: XXX-XXXXXXXX)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")

    args = parser.parse_args()

    if args.awb:
        # Parse AWB
        if "-" in args.awb:
            prefix, serial = args.awb.split("-")
        else:
            prefix, serial = args.awb[:3], args.awb[3:]

        result = await test_carrier(prefix, serial, verbose=True)
        print(f"\nResult: {result['status']}")
        if result["error"]:
            print(f"Error: {result['error']}")
        return 0 if result["status"] == "ok" else 1

    elif args.carrier:
        result = await test_carrier(args.carrier, verbose=True)
        print(f"\nResult: {result['status']}")
        if result["error"]:
            print(f"Error: {result['error']}")
        return 0 if result["status"] == "ok" else 1

    else:
        results = await test_all_carriers(verbose=args.verbose)
        print_summary(results)

        # Exit 1 if any carrier failed
        failed_count = sum(1 for r in results if r["status"] != "ok")
        return 1 if failed_count > 0 else 0


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)

#!/usr/bin/env python3
"""
Daily health report for KoudrsTracking.

Runs tests against all carriers with known AWBs and sends email report via Resend.

Usage:
    python scripts/daily_health_report.py [--test] [--no-email]

Cron (12:00 PM Panama / GMT-5):
    0 12 * * * cd /path/to/cargotkr && .venv/bin/python scripts/daily_health_report.py >> /var/log/koudrs-daily.log 2>&1
"""

import asyncio
import os
import sys
from datetime import datetime
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv

# Load environment variables
load_dotenv(Path(__file__).parent.parent / "api" / ".env")

import resend

from api.carriers.registry import get_carrier

# Configuration
RESEND_API_KEY = os.getenv("RESEND_API_KEY")
NOTIFY_FROM = os.getenv("NOTIFY_FROM", "tracking@koudrs.com")
NOTIFY_TO = os.getenv("NOTIFY_TO", "eduardo@koudrs.com")

# Test AWBs for each carrier
TEST_AWBS = {
    "369": "98470363",  # Atlas Air
    "810": "50671456",  # Amerijet
    "112": "02979760",  # China Cargo
    "074": "71939976",  # AFKL (KLM)
    "936": "02195992",  # DHL Aviation
    "235": "95115705",  # Turkish Cargo
    "865": "14710113",  # MAS Air (SmartKargo)
}


async def test_carrier(prefix: str, serial: str) -> dict:
    """Test a single carrier and return results."""
    tracker = get_carrier(prefix)
    if not tracker:
        return {
            "prefix": prefix,
            "serial": serial,
            "carrier": "Unknown",
            "status": "error",
            "error": "Carrier not found",
            "has_data": False,
            "events": 0,
            "response_ms": 0,
        }

    awb = f"{prefix}-{serial}"
    start = datetime.now()

    try:
        result = await asyncio.wait_for(
            tracker.track(prefix, serial),
            timeout=90  # 90s timeout
        )
        elapsed = (datetime.now() - start).total_seconds() * 1000

        has_data = bool(result.events or result.origin or result.status)

        return {
            "prefix": prefix,
            "serial": serial,
            "carrier": tracker.name,
            "awb": awb,
            "status": "ok",
            "has_data": has_data,
            "origin": result.origin,
            "destination": result.destination,
            "shipment_status": result.status,
            "events": len(result.events),
            "response_ms": round(elapsed, 0),
            "error": None,
        }

    except asyncio.TimeoutError:
        return {
            "prefix": prefix,
            "serial": serial,
            "carrier": tracker.name,
            "awb": awb,
            "status": "timeout",
            "has_data": False,
            "events": 0,
            "response_ms": 90000,
            "error": "Request timed out after 90s",
        }
    except Exception as e:
        elapsed = (datetime.now() - start).total_seconds() * 1000
        return {
            "prefix": prefix,
            "serial": serial,
            "carrier": tracker.name,
            "awb": awb,
            "status": "error",
            "has_data": False,
            "events": 0,
            "response_ms": round(elapsed, 0),
            "error": str(e)[:100],
        }


async def run_all_tests() -> list[dict]:
    """Run tests for all carriers sequentially to avoid curl_cffi deadlocks."""
    results = []
    for prefix, serial in TEST_AWBS.items():
        result = await test_carrier(prefix, serial)
        results.append(result)
        print(f"  Tested {result['carrier']}: {result['status']}")
    return results


def generate_html_report(results: list[dict], timestamp: datetime) -> str:
    """Generate HTML email report."""
    ok_count = sum(1 for r in results if r["status"] == "ok")
    with_data = sum(1 for r in results if r.get("has_data"))
    total = len(results)

    # Determine overall status
    if ok_count == total:
        overall_status = "✅ HEALTHY"
        status_color = "#22c55e"
    elif ok_count > total // 2:
        overall_status = "⚠️ DEGRADED"
        status_color = "#f59e0b"
    else:
        overall_status = "🔴 UNHEALTHY"
        status_color = "#ef4444"

    # Build carrier rows
    rows = ""
    for r in sorted(results, key=lambda x: x["carrier"]):
        if r["status"] == "ok":
            status_icon = "✅"
            row_bg = "#f0fdf4"
        elif r["status"] == "timeout":
            status_icon = "⏱️"
            row_bg = "#fef3c7"
        else:
            status_icon = "❌"
            row_bg = "#fef2f2"

        data_status = "✓ Data" if r.get("has_data") else "No data"
        route = f"{r.get('origin', '?')} → {r.get('destination', '?')}" if r.get("origin") else "-"

        rows += f"""
        <tr style="background-color: {row_bg};">
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">{status_icon}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;"><strong>{r['carrier']}</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; font-family: monospace;">{r.get('awb', r['prefix'])}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">{route}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">{r.get('shipment_status', '-')}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">{data_status}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">{r['events']} events</td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">{r['response_ms']:.0f}ms</td>
        </tr>
        """

        if r.get("error"):
            rows += f"""
            <tr style="background-color: {row_bg};">
                <td colspan="8" style="padding: 8px 12px; color: #dc2626; font-size: 12px;">
                    Error: {r['error']}
                </td>
            </tr>
            """

    avg_response = sum(r["response_ms"] for r in results) / len(results) if results else 0

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>KoudrsTracking Daily Report</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background-color: #f9fafb;">
        <div style="background-color: white; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
            <h1 style="margin: 0 0 8px 0; color: #111827;">📦 KoudrsTracking Daily Report</h1>
            <p style="color: #6b7280; margin: 0 0 24px 0;">{timestamp.strftime('%A, %B %d, %Y at %I:%M %p')} (Panama Time)</p>

            <div style="background-color: {status_color}; color: white; padding: 16px 24px; border-radius: 8px; margin-bottom: 24px;">
                <h2 style="margin: 0; font-size: 24px;">{overall_status}</h2>
                <p style="margin: 8px 0 0 0; opacity: 0.9;">
                    {ok_count}/{total} carriers responding • {with_data}/{total} with data • Avg response: {avg_response:.0f}ms
                </p>
            </div>

            <h3 style="color: #374151; margin-bottom: 16px;">Carrier Status</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <thead>
                    <tr style="background-color: #f3f4f6;">
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb;"></th>
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Carrier</th>
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">AWB</th>
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Route</th>
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Status</th>
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Data</th>
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Events</th>
                        <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Response</th>
                    </tr>
                </thead>
                <tbody>
                    {rows}
                </tbody>
            </table>

            <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 12px;">
                <p>Generated by KoudrsTracking Health Monitor</p>
                <p>Test AWBs: {', '.join(f"{p}-{s}" for p, s in TEST_AWBS.items())}</p>
            </div>
        </div>
    </body>
    </html>
    """

    return html


def send_email(subject: str, html_content: str, test_mode: bool = False) -> bool:
    """Send email via Resend."""
    if not RESEND_API_KEY:
        print("ERROR: RESEND_API_KEY not configured")
        return False

    if test_mode:
        print(f"\n[TEST MODE] Would send email:")
        print(f"  From: {NOTIFY_FROM}")
        print(f"  To: {NOTIFY_TO}")
        print(f"  Subject: {subject}")
        return True

    resend.api_key = RESEND_API_KEY

    try:
        params = {
            "from": f"KoudrsTracking <{NOTIFY_FROM}>",
            "to": [NOTIFY_TO],
            "subject": subject,
            "html": html_content,
        }

        response = resend.Emails.send(params)
        print(f"Email sent successfully: {response}")
        return True

    except Exception as e:
        print(f"ERROR sending email: {e}")
        return False


async def main():
    import argparse

    parser = argparse.ArgumentParser(description="KoudrsTracking Daily Health Report")
    parser.add_argument("--test", action="store_true", help="Test mode - don't send email")
    parser.add_argument("--no-email", action="store_true", help="Skip sending email")
    args = parser.parse_args()

    timestamp = datetime.now()
    print(f"\n{'='*60}")
    print(f"KoudrsTracking Daily Health Report")
    print(f"Timestamp: {timestamp.isoformat()}")
    print(f"{'='*60}\n")

    # Run tests
    print("Running carrier tests...")
    results = await run_all_tests()

    # Print summary
    ok_count = sum(1 for r in results if r["status"] == "ok")
    with_data = sum(1 for r in results if r.get("has_data"))
    total = len(results)

    print(f"\nResults: {ok_count}/{total} carriers OK, {with_data}/{total} with data\n")

    for r in sorted(results, key=lambda x: x["carrier"]):
        status = "✅" if r["status"] == "ok" else "❌"
        data = "with data" if r.get("has_data") else "no data"
        print(f"  {status} {r['carrier']}: {r['status']} ({data}, {r['response_ms']:.0f}ms)")
        if r.get("error"):
            print(f"     Error: {r['error']}")

    # Generate and send report
    if not args.no_email:
        print("\nGenerating email report...")
        html = generate_html_report(results, timestamp)

        # Determine subject based on status
        if ok_count == total:
            subject = f"✅ KoudrsTracking: All {total} carriers healthy"
        elif ok_count > total // 2:
            subject = f"⚠️ KoudrsTracking: {total - ok_count} carrier(s) degraded"
        else:
            subject = f"🔴 KoudrsTracking: {total - ok_count} carrier(s) failing"

        print(f"Sending email: {subject}")
        send_email(subject, html, test_mode=args.test)

    print(f"\n{'='*60}")
    print("Report complete")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    asyncio.run(main())

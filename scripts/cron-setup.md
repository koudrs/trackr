# KoudrsTracking Cron Setup

## Daily Health Report (12:00 PM Panama Time)

Panama uses GMT-5 (EST). To schedule the daily report at 12:00 PM Panama time:

### Option 1: System Cron (crontab)

```bash
# Edit crontab
crontab -e

# Add this line (12:00 PM Panama = 17:00 UTC)
0 17 * * * cd /path/to/cargotkr && .venv/bin/python scripts/daily_health_report.py >> /var/log/koudrs-daily.log 2>&1
```

### Option 2: macOS launchd

Create file `~/Library/LaunchAgents/com.koudrs.tracking.daily.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.koudrs.tracking.daily</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/cargotkr/.venv/bin/python</string>
        <string>/path/to/cargotkr/scripts/daily_health_report.py</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>12</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/var/log/koudrs-daily.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/koudrs-daily-error.log</string>
    <key>WorkingDirectory</key>
    <string>/path/to/cargotkr</string>
</dict>
</plist>
```

Then load it:
```bash
launchctl load ~/Library/LaunchAgents/com.koudrs.tracking.daily.plist
```

### Option 3: systemd timer (Linux)

Create `/etc/systemd/system/koudrs-daily.service`:
```ini
[Unit]
Description=KoudrsTracking Daily Health Report

[Service]
Type=oneshot
WorkingDirectory=/path/to/cargotkr
ExecStart=/path/to/cargotkr/.venv/bin/python scripts/daily_health_report.py
User=your-user
```

Create `/etc/systemd/system/koudrs-daily.timer`:
```ini
[Unit]
Description=Run KoudrsTracking health report daily at 12pm Panama

[Timer]
OnCalendar=*-*-* 17:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:
```bash
sudo systemctl enable koudrs-daily.timer
sudo systemctl start koudrs-daily.timer
```

## Manual Test

Run manually to test:
```bash
cd /path/to/cargotkr
source .venv/bin/activate
python scripts/daily_health_report.py
```

## Environment Variables

Make sure `api/.env` contains:
```
RESEND_API_KEY=your-key
NOTIFY_FROM=tracking@koudrs.com
NOTIFY_TO=eduardo@koudrs.com
```

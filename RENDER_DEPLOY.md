# Deploy to Render.com

## Quick Deploy (sin Blueprint)

### 1. Push to GitHub
```bash
git add -A
git commit -m "Ready for Render deployment"
git push origin main
```

### 2. Create Web Service on Render

1. Go to https://dashboard.render.com/
2. Click **New** → **Web Service**
3. Connect your GitHub repo: `prs/cargotkr`
4. Configure:
   - **Name**: `cargotracker` (or your choice)
   - **Region**: Ohio (us-east) or closest to your clients
   - **Branch**: `main`
   - **Runtime**: **Docker**
   - **Instance Type**: **Starter** ($7/mo) or **Standard** ($25/mo)

### 3. Environment Variables

Add these in the **Environment** section:

| Key | Value | Notes |
|-----|-------|-------|
| `FR24_API_TOKEN` | `019e7588-3747-...` | Your FlightRadar24 token |
| `SCRAPPER_API_KEY` | `d73d64cf2f1a...` | ScraperAPI key (optional) |

### 4. Deploy

Click **Create Web Service**. Render will:
1. Pull the code
2. Build the Docker image (~5-8 min first time)
3. Start the container
4. Assign a URL: `https://cargotracker-xxxx.onrender.com`

### 5. Test

Open the assigned URL → should show the CargoTracker UI.
- Click **Radar** → add AWB `369-99363622` → should show HKG→MIA route

## Notes

- **Cold starts**: Free/Starter tier may spin down after inactivity. First request takes ~30s.
- **Logs**: Dashboard → your service → **Logs** tab
- **Redeploy**: Push to main triggers auto-deploy (or manual deploy in dashboard)
- **Custom domain**: Settings → Custom Domains

## Environment Variables Reference

```
FR24_API_TOKEN=<your-flightradar24-token>
SCRAPPER_API_KEY=<your-scraperapi-key>
RESEND_API_KEY=<optional-for-email>
NOTIFY_FROM=tracking@yourdomain.com
NOTIFY_TO=you@yourdomain.com
```

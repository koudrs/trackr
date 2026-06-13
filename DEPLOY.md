# Deploy to Render (Docker)

The whole app (FastAPI backend **+** built frontend) ships as **one Docker image**,
served by a single process. The API is under `/api/*`; the frontend is everything
else. No separate frontend service, no database.

## Steps

1. **Push the repo to GitHub** (Render deploys from a Git repo).

2. On Render: **New → Web Service → Build from a Dockerfile**. Point it at this repo.
   Render auto-detects the `Dockerfile` at the root — no Blueprint needed.

3. **Environment** tab — add the variables you need (all optional; the app starts
   without them, features degrade gracefully):

   | Variable            | What it enables                                              |
   |---------------------|-------------------------------------------------------------|
   | `FR24_API_TOKEN`    | Live radar via FlightRadar24 (covers cargo). Format `id\|secret`. Falls back to free airplanes.live if unset. |
   | `SCRAPPER_API_KEY`  | AFKL Cargo proxy (only AFKL prefixes need it).              |
   | `RESEND_API_KEY`    | Email notifications.                                        |
   | `NOTIFY_FROM` / `NOTIFY_TO` | Notification addresses.                             |

   **Do NOT set `PORT`** — Render injects it and the Dockerfile reads it.

4. Deploy. Render builds the image, runs it, and routes HTTPS to the container's
   `$PORT`. The health check hits `/api/health`.

## Local test (same image Render runs)

```bash
docker build -t cargotracker .
# Render injects PORT; locally it defaults to 3000:
docker run --rm -p 3000:3000 \
  -e FR24_API_TOKEN="<id|secret>" \
  cargotracker
# open http://localhost:3000
```

To mimic Render's port exactly:

```bash
docker run --rm -e PORT=10000 -p 10000:10000 cargotracker
```

## Notes

- First boot is slower: the image installs headless Chromium (Playwright) and
  Tesseract for the carriers that need them. The `start-period` on the health
  check accounts for this.
- The frontend talks to the API at `/api` (same origin) — nothing to configure.
- The live radar caches FR24 responses aggressively (summary 10 min, tracks 5 min)
  to stay within the credit budget; see `api/fr24.py`.

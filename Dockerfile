# Multi-stage build for Python API + Vite frontend
# Optimized for DigitalOcean/Render deployment

# Stage 1: Frontend build (Vite)
FROM node:20-alpine AS frontend-builder
WORKDIR /app/front-vite

COPY front-vite/package.json front-vite/package-lock.json ./
RUN npm ci

COPY front-vite/ .

ARG VITE_API_URL=/api
ARG VITE_TURNSTILE_SITE_KEY
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY

RUN npm run build

# Stage 2: Production runtime
FROM python:3.12-slim AS runtime

# Create non-root user first
RUN addgroup --system --gid 1001 appgroup \
    && adduser --system --uid 1001 --ingroup appgroup appuser

WORKDIR /app

# Install tesseract for China Cargo OCR + deps for Chrome
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    tesseract-ocr \
    # Chrome dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright browsers
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright
RUN mkdir -p /app/.playwright /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && chown -R appuser:appgroup /app/.playwright \
    && su appuser -s /bin/sh -c "playwright install chromium"

# Copy API code
COPY api/ ./api/

# Copy frontend build artifacts (Vite static build)
COPY --from=frontend-builder /app/front-vite/dist ./front-vite/dist

# Set ownership and create temp dirs with proper permissions
RUN chown -R appuser:appgroup /app \
    && mkdir -p /tmp/playwright \
    && chown -R appuser:appgroup /tmp/playwright

USER appuser

# Environment for headless Chrome in containers
ENV DISPLAY=:99
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Single uvicorn process serves both API (/api/*) and static frontend
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "3000"]

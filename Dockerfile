# Multi-stage build for Python API + Next.js frontend
# Optimized for Render deployment

# Stage 1: Frontend build
FROM node:20-alpine AS frontend-builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app/front

COPY front/package.json front/pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY front/ .

ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY

RUN pnpm build

# Stage 2: Production runtime
FROM python:3.12-slim AS runtime

# Create non-root user first
RUN addgroup --system --gid 1001 appgroup \
    && adduser --system --uid 1001 --ingroup appgroup appuser

WORKDIR /app

# Install Node.js runtime + tesseract for China Cargo OCR
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    tesseract-ocr \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright as appuser so browsers are in the right location
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright
RUN mkdir -p /app/.playwright \
    && chown -R appuser:appgroup /app/.playwright \
    && su appuser -s /bin/sh -c "playwright install chromium" \
    && playwright install-deps chromium

# Copy API code
COPY api/ ./api/
COPY pyproject.toml .

# Copy frontend build artifacts
COPY --from=frontend-builder /app/front/.next/standalone ./front/
COPY --from=frontend-builder /app/front/.next/static ./front/.next/static
COPY --from=frontend-builder /app/front/public ./front/public

# Set ownership
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

# API on 8000 (internal), frontend on 3000 (exposed)
CMD ["sh", "-c", "uvicorn api.main:app --host 0.0.0.0 --port 8000 & cd front && node server.js"]

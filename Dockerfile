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

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY

RUN pnpm build

# Stage 2: Production runtime
FROM python:3.12-slim AS runtime

WORKDIR /app

# Install Node.js runtime only (no build tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && playwright install chromium --with-deps

# Copy API code
COPY api/ ./api/
COPY pyproject.toml .

# Copy frontend build artifacts
COPY --from=frontend-builder /app/front/.next/standalone ./front/
COPY --from=frontend-builder /app/front/.next/static ./front/.next/static
COPY --from=frontend-builder /app/front/public ./front/public

# Non-root user
RUN addgroup --system --gid 1001 appgroup \
    && adduser --system --uid 1001 --ingroup appgroup appuser \
    && chown -R appuser:appgroup /app
USER appuser

EXPOSE 8000 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["sh", "-c", "uvicorn api.main:app --host 0.0.0.0 --port 8000 & cd front && node server.js"]

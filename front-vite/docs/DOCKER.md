# Docker - Guía de Despliegue

Guía para construir y desplegar CargoTracker usando Docker.

## Arquitectura del Contenedor

El proyecto usa un **multi-stage build** que combina:
- **Frontend**: React + Vite (build estático)
- **Backend**: Python + FastAPI

```
┌─────────────────────────────────────────┐
│            Docker Container             │
│  ┌─────────────────────────────────┐   │
│  │   Frontend (Vite/Static)        │   │
│  │   Puerto: 3000 (expuesto)       │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │   Backend (FastAPI/Uvicorn)     │   │
│  │   Puerto: 8000 (interno)        │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

## Estructura del Dockerfile

### Stage 1: Frontend Build

```dockerfile
FROM node:20-alpine AS frontend-builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app/front-vite

COPY front-vite/package.json front-vite/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY front-vite/ .
RUN pnpm build
```

### Stage 2: Production Runtime

```dockerfile
FROM python:3.12-slim AS runtime

# Usuario no-root
RUN addgroup --system --gid 1001 appgroup \
    && adduser --system --uid 1001 --ingroup appgroup appuser

WORKDIR /app

# Dependencias del sistema
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    tesseract-ocr \
    # Chrome dependencies para Playwright
    libnss3 libnspr4 libatk1.0-0 ... \
    && apt-get clean

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Playwright browsers
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright
RUN playwright install chromium

# Copiar código
COPY api/ ./api/
COPY --from=frontend-builder /app/front-vite/dist ./front-vite/dist

USER appuser
EXPOSE 3000

CMD ["sh", "-c", "uvicorn api.main:app --host 0.0.0.0 --port 8000 & serve -s front-vite/dist -l 3000"]
```

## Comandos

### Build Local

```bash
# Build de la imagen
docker build -t cargotracker:latest .

# Build con variables de entorno
docker build \
  --build-arg VITE_API_URL=/api \
  -t cargotracker:latest .
```

### Run Local

```bash
# Ejecutar contenedor
docker run -d \
  --name cargotracker \
  -p 3000:3000 \
  -e RESEND_API_KEY=re_xxxxx \
  -e TURNSTILE_SECRET_KEY=xxxxx \
  cargotracker:latest

# Ver logs
docker logs -f cargotracker

# Detener
docker stop cargotracker && docker rm cargotracker
```

### Desarrollo con Docker Compose

Crear `docker-compose.yml`:

```yaml
version: '3.8'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - RESEND_API_KEY=${RESEND_API_KEY}
      - TURNSTILE_SECRET_KEY=${TURNSTILE_SECRET_KEY}
      - NOTIFY_FROM=${NOTIFY_FROM}
      - NOTIFY_TO=${NOTIFY_TO}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/"]
      interval: 30s
      timeout: 10s
      retries: 3
    restart: unless-stopped

  # Opcional: Base de datos
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: cargotracker
      POSTGRES_USER: cargo
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"

volumes:
  pgdata:
```

Ejecutar:

```bash
# Levantar servicios
docker compose up -d

# Ver logs
docker compose logs -f app

# Detener
docker compose down
```

## Variables de Entorno

### Build-time (ARG)

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `VITE_API_URL` | URL del API para el frontend | `/api` |
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key | `0x4AAA...` |

### Runtime (ENV)

| Variable | Descripción | Requerida |
|----------|-------------|-----------|
| `RESEND_API_KEY` | API key de Resend para emails | No |
| `TURNSTILE_SECRET_KEY` | Turnstile secret para validación | No |
| `NOTIFY_FROM` | Email origen para notificaciones | No |
| `NOTIFY_TO` | Email destino para alertas | No |

## Despliegue en Render

1. Conectar repositorio a Render
2. Seleccionar "Web Service"
3. Configurar:
   - **Build Command**: (usa Dockerfile automáticamente)
   - **Port**: 3000
4. Agregar variables de entorno en el dashboard
5. Deploy

## Despliegue en Railway

```bash
# Instalar CLI
npm i -g @railway/cli

# Login
railway login

# Inicializar proyecto
railway init

# Desplegar
railway up
```

## Health Check

El contenedor incluye health check:

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1
```

Verificar estado:

```bash
docker inspect --format='{{.State.Health.Status}}' cargotracker
```

## Troubleshooting

### Error: Playwright no puede iniciar Chrome

```bash
# Verificar que las dependencias de Chrome están instaladas
docker exec cargotracker ldd /app/.playwright/chromium-*/chrome-linux/chrome

# Logs de Playwright
docker exec cargotracker cat /tmp/playwright*.log
```

### Error: Puerto 3000 en uso

```bash
# Ver qué proceso usa el puerto
lsof -i :3000

# Usar otro puerto
docker run -p 3001:3000 cargotracker:latest
```

### Error: Out of memory

```bash
# Aumentar memoria del contenedor
docker run --memory=2g cargotracker:latest
```

## Optimizaciones

### Cache de dependencias

El Dockerfile usa cache mounts para pnpm:

```dockerfile
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
```

### Multi-stage para imagen pequeña

- Stage 1: Node 20 Alpine (~180MB) - solo para build
- Stage 2: Python 3.12 Slim (~150MB) - runtime

Tamaño final aproximado: ~800MB (incluye Chromium para Playwright)

### Sin Playwright (imagen más pequeña)

Si no necesitas web scraping, puedes crear un Dockerfile simplificado:

```dockerfile
FROM python:3.12-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY api/ ./api/
COPY front-vite/dist ./static/

EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Tamaño: ~200MB

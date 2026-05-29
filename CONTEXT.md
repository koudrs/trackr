# CONTEXT.md — Live Flight Radar (estado y cómo levantarlo)

Contexto para retomar el trabajo en otra PC o en otra sesión de Claude Code.

## Qué se hizo

Se agregó un **radar de vuelos en tiempo real** al cargo tracker. Combina 2 fuentes:
- **Tu tracking de carga** (API existente): AWB, ruta, vuelo, eventos con timestamps.
- **airplanes.live** (ADS-B gratis, sin API key): posición, altitud, velocidad, rumbo del avión.

Resultado: una vista pantalla completa (header → botón **Radar**) que muestra, por cada AWB:
- ✈️ **Volando**: avión en vivo, moviéndose, con altitud/velocidad/ETA estimado/tiempo de vuelo + traza recorrida (se acumula mientras miras).
- 📍 **En aeropuerto** (transbordo): pin ámbar donde está la carga esperando el próximo tramo (ej. en IST esperando TK0903 → PTY).
- 🛣️ **Ruta planeada** punteada uniendo los aeropuertos del envío (CGO→IST→PTY).
- ✨ **Demo mode**: aviones reales en los corredores de carga (CGO→PTY, HKG→MIA…) para ver el radar lleno sin tener un AWB en vuelo.

## Estado: FUNCIONA. Build + lint + typecheck en verde. Probado con datos reales.

## ⚠️ NO COMMITEADO — todo está en working tree, nada en git. (último commit: `11f5970`)

## Límites honestos (importante, no son bugs)
- airplanes.live es **solo posición actual**: NO da traza histórica de horas atrás → por eso la traza se acumula en vivo y la ruta histórica se sustituye por la **línea de ruta planeada** entre aeropuertos.
- **ETA es estimado** (distancia restante ÷ velocidad), no oficial.
- airplanes.live es **no-comercial, sin API key, 1 req/seg**. OK para uso interno.

---

## Cómo levantarlo

Requisitos: **Python 3.11+**, **Node 20+**. (Aquí se usó Python 3.14.5 / Node 26.)

### Backend (terminal 1, desde la raíz del repo)
```bash
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install fastapi "uvicorn[standard]" httpx pydantic beautifulsoup4 lxml "scrapling[fetchers]" pytesseract Pillow
# (o: pip install -r requirements.txt  — incluye más cosas pero también sirve)
uvicorn api.main:app --port 8000 --host 127.0.0.1
```
Nota: `scrapling`, `pytesseract`, `Pillow` se necesitan SOLO porque el registro de carriers los importa al arrancar (china_cargo). El radar en sí solo usa fastapi + httpx. NO hace falta `playwright install` para el radar.

### Frontend (terminal 2)
```bash
cd front-vite
npm install
npm run dev        # corre en http://localhost:3000 y proxea /api → :8000
```

### Abrir
http://localhost:3000 → botón **Radar** en el header.

### Probar rápido
- Clic en **Demo mode** (✨) → aviones reales en rutas de carga.
- Buscar un AWB en la sidebar (ej. `235-98010581`) → muestra dónde está la carga.
- Encender **LIVE** para que haga polling y aparezca la traza.

---

## Archivos del feature

### Backend (`api/`)
- `airlines.py` — **NUEVO**. Mapea flight number IATA → callsign ICAO (CM473 → CMP473) para cruzar con airplanes.live.
- `airports.py` — **NUEVO**. Coords de aeropuertos + distancia great-circle + rutas demo.
- `models.py` — agregó `FlightPosition` / `FlightPositionList` (posición + ruta + ETA + tiempo).
- `main.py` — agregó endpoints:
  - `GET /api/flights?flights=AWB:FLIGHT:ORIGIN:DEST:DEP_ISO` → posiciones en vivo enriquecidas. Batchea todos los callsigns en 1 request a airplanes.live, cache TTL ~8s.
  - `GET /api/flights?demo=1` → aviones reales en corredores de carga.
  - `GET /api/airports?codes=IST,CGO,PTY` → coords para dibujar rutas/pines.

### Frontend (`front-vite/src/`)
- `components/LiveRadarView.tsx` — **NUEVO**. La vista del radar (mapa + sidebar + buscador + demo + pines + rutas).
- `components/ui/map.tsx` — **NUEVO**. Componente de mapa de [mapcn](https://mapcn.dev) (MapLibre GL), vendoreado.
- `hooks/useLiveFlights.ts` — **NUEVO**. Polling con switch OFF=1 request / ON=cada Xs, dead-reckoning para mover los aviones suave, acumula traza.
- `lib/journey.ts` — **NUEVO**. Deduce el estado del viaje (volando / esperando en aeropuerto / entregado) desde los eventos del AWB.
- `lib/utils.ts` — **NUEVO**. Helper `cn` que necesita mapcn.
- `lib/api.ts` — agregó `getFlights`, `getAirports` y los tipos.
- `App.tsx` — agregó el switch de vista Shipments | Radar.
- `index.css` — agregó tokens `@theme inline` para que las clases de mapcn resuelvan con las CSS vars.

### Dependencias nuevas
- npm: `maplibre-gl`, `clsx`, `tailwind-merge` (ya en package.json).
- pip: las de arriba (no están todas en requirements.txt salvo las base).

---

## Pendientes / ideas
- Demo: `_demo_flights()` en `api/main.py` es **temporal** — quitar cuando ya no se necesite.
- Si en algún momento se quiere traza histórica real o ETA oficial → fuente de pago (FlightAware/FR24).
- Más aeropuertos: agregarlos en `api/airports.py` (dict `AIRPORTS`).
- Más aerolíneas en el radar: agregar su código IATA→ICAO en `api/airlines.py`.

# CargoTracker - Documentación Técnica

Sistema de seguimiento de AWBs (Air Waybills) de carga aérea con soporte para conexiones/transbordos.

## Tabla de Contenidos

1. [Estructura de Datos de la API](#estructura-de-datos-de-la-api)
2. [Consumo de Datos en el Frontend](#consumo-de-datos-en-el-frontend)
3. [Visualización de Datos](#visualización-de-datos)
4. [Sistema de Conexiones](#sistema-de-conexiones)
5. [Guía de Migración a Base de Datos](#guía-de-migración-a-base-de-datos)

---

## Estructura de Datos de la API

### Endpoint Principal

```
GET /api/track/{awb}
```

Donde `{awb}` es el número de guía aérea en formato `XXX-XXXXXXXX` (ej: `172-36999149`).

### Respuesta: TrackingResult

```typescript
interface TrackingResult {
  awb: string;           // Número de guía aérea (ej: "172-36999149")
  airline: string;       // Nombre de la aerolínea (ej: "Emirates SkyCargo")
  iata_code: string | null;  // Código IATA de la aerolínea (ej: "EK")
  origin: string | null;      // Código IATA origen (ej: "PVG" = Shanghai)
  destination: string | null; // Código IATA destino (ej: "MIA" = Miami)
  pieces: number | null;      // Cantidad de piezas/bultos
  weight: number | null;      // Peso total en kilogramos
  status: string | null;      // Estado general del envío
  events: TrackingEvent[];    // Historial de eventos (más reciente primero)
  tracked_at: string;         // Timestamp ISO de la consulta
  source: string;             // Fuente de los datos
}
```

### Eventos: TrackingEvent

```typescript
interface TrackingEvent {
  timestamp: string | null;   // Fecha/hora del evento (ISO 8601)
  status_code: string;        // Código de estado (ver tabla abajo)
  description: string;        // Descripción del evento
  location: string | null;    // Código IATA de ubicación (ej: "MIA")
  flight: string | null;      // Número de vuelo (ej: "EK214")
  pieces: number | null;      // Piezas en este evento
}
```

### Códigos de Estado (status_code)

| Código | Significado | Descripción |
|--------|-------------|-------------|
| `BKD` | Booked | Reservado |
| `RCS` | Received | Recibido por la aerolínea |
| `MAN` | Manifested | Manifestado para vuelo |
| `DEP` | Departed | Despegó |
| `ARR` | Arrived | Aterrizó |
| `RCF` | At destination | En bodega de destino |
| `NFD` | Ready | Listo para retiro |
| `DLV` | Delivered | Entregado |
| `DDL` | Delayed | Retrasado |
| `UNK` | Processing | Estado desconocido/procesando |

### Respuesta de Error

```typescript
interface TrackingError {
  awb: string;
  error: string;
  carrier?: string;
  suggestion?: string;
}
```

---

## Consumo de Datos en el Frontend

### Configuración de API

```typescript
// src/lib/api.ts
const API_BASE = import.meta.env.VITE_API_URL || "/api";

export async function trackAWB(awb: string): Promise<TrackingResult> {
  const res = await fetch(`${API_BASE}/track/${awb}`);

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.detail?.error || "Error tracking AWB");
  }

  return res.json();
}
```

### Hook Principal: useTrackedAWBs

El hook `useTrackedAWBs` maneja todo el estado de los AWBs rastreados:

```typescript
// src/hooks/useTrackedAWBs.ts

interface TrackedAWB {
  awb: string;                    // Número de AWB
  data: TrackingResult | null;    // Datos del API
  lastUpdated: string;            // Última actualización (ISO)
  isLoading: boolean;             // Estado de carga
  error: string | null;           // Mensaje de error
  connectionAWB?: string;         // AWB de conexión (vuelo conectado)
  parentAWB?: string;             // AWB padre (si es una conexión)
}
```

#### Funciones del Hook

| Función | Descripción |
|---------|-------------|
| `addAWB(awb)` | Agrega un nuevo AWB para rastrear |
| `removeAWB(awb)` | Elimina un AWB del seguimiento |
| `refreshAWB(awb)` | Actualiza datos de un AWB específico |
| `refreshAll()` | Actualiza todos los AWBs |
| `clearAll()` | Elimina todos los AWBs |
| `addConnection(parentAWB, connectionAWB)` | Vincula dos AWBs como conexión |
| `unlinkConnection(parentAWB)` | Desvincula una conexión |

#### Persistencia

Los datos se persisten automáticamente en `localStorage` bajo la key `tracked_awbs`:

```typescript
const STORAGE_KEY = "tracked_awbs";
const REFRESH_INTERVAL = 5 * 60 * 1000; // Auto-refresh cada 5 minutos
```

---

## Visualización de Datos

### Arquitectura de Componentes

```
App.tsx
├── SearchBar.tsx           # Búsqueda de AWBs
├── Dashboard.tsx           # Estadísticas generales
├── FlightRadar.tsx         # Mapa de vuelos activos
├── TrackingSidebar.tsx     # Lista de AWBs en seguimiento
└── TrackingResult.tsx      # Detalle de shipment seleccionado
```

### Clasificación de AWBs

Los AWBs se clasifican por estado del evento más reciente:

```typescript
// TrackingSidebar.tsx

// En vuelo (departed)
const departed = trackedAWBs.filter(t =>
  t.data?.events[0]?.status_code === "DEP"
);

// Llegaron (arrived, at destination, ready, delivered)
const arrived = trackedAWBs.filter(t =>
  ["ARR", "RCF", "NFD", "DLV"].includes(t.data?.events[0]?.status_code || "")
);

// Otros (pending, booked, received, etc.)
const others = trackedAWBs.filter(t =>
  !["DEP", "ARR", "RCF", "NFD", "DLV"].includes(t.data?.events[0]?.status_code || "")
);
```

### Dashboard: Métricas

```typescript
// Dashboard.tsx
const stats = {
  total: trackedAWBs.length,
  inFlight: trackedAWBs.filter(t => t.data?.events[0]?.status_code === "DEP").length,
  delivered: trackedAWBs.filter(t => t.data?.events[0]?.status_code === "DLV").length,
  totalPieces: trackedAWBs.reduce((sum, t) => sum + (t.data?.pieces || 0), 0),
  totalWeight: trackedAWBs.reduce((sum, t) => sum + (t.data?.weight || 0), 0),
};
```

### FlightRadar: Vuelos Activos

Muestra en mapa los vuelos con estado `DEP` que:
- Despegaron en las últimas 48 horas, O
- Tienen destino PTY

```typescript
const activeFlights = trackedAWBs.filter((t) => {
  const status = t.data?.events[0]?.status_code;
  return status === "DEP" && (isRecentDeparture(t) || t.data?.destination === "PTY");
});
```

---

## Sistema de Conexiones

Para vuelos con transbordo (ej: Shanghai → Miami → Panamá), el sistema permite vincular AWBs.

### Modelo de Datos

```
AWB Principal (172-36999149)     AWB Conexión (810-12345678)
├── origin: PVG                  ├── origin: MIA
├── destination: MIA             ├── destination: PTY
├── connectionAWB: "810-12345678"├── parentAWB: "172-36999149"
└── ...                          └── ...
```

### Flujo de Vinculación

1. Usuario identifica AWB con destino diferente a PTY
2. Hace clic en botón de vincular (icono de enlace)
3. Ingresa el AWB de conexión
4. Sistema crea relación bidireccional

```typescript
// Agregar conexión
await addConnection("172-36999149", "810-12345678");

// El padre queda con:
{ awb: "172-36999149", connectionAWB: "810-12345678", ... }

// La conexión queda con:
{ awb: "810-12345678", parentAWB: "172-36999149", ... }
```

### Visualización de Conexión

En el componente de detalle:
- Badge indicando "Primary" o "Connection"
- Ruta completa: `PVG ✈ MIA → PTY`
- Card clickeable mostrando el AWB relacionado

---

## Guía de Migración a Base de Datos

### Esquema Propuesto (PostgreSQL)

#### Tabla: `shipments`

```sql
CREATE TABLE shipments (
  id SERIAL PRIMARY KEY,
  awb VARCHAR(20) UNIQUE NOT NULL,
  airline VARCHAR(100),
  iata_code VARCHAR(3),
  origin VARCHAR(3),
  destination VARCHAR(3),
  pieces INTEGER,
  weight DECIMAL(10,2),
  status VARCHAR(10),
  tracked_at TIMESTAMP WITH TIME ZONE,
  source VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_shipments_awb ON shipments(awb);
CREATE INDEX idx_shipments_status ON shipments(status);
CREATE INDEX idx_shipments_origin ON shipments(origin);
CREATE INDEX idx_shipments_destination ON shipments(destination);
```

#### Tabla: `shipment_events`

```sql
CREATE TABLE shipment_events (
  id SERIAL PRIMARY KEY,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  timestamp TIMESTAMP WITH TIME ZONE,
  status_code VARCHAR(10) NOT NULL,
  description TEXT,
  location VARCHAR(3),
  flight VARCHAR(20),
  pieces INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_events_shipment ON shipment_events(shipment_id);
CREATE INDEX idx_events_status ON shipment_events(status_code);
CREATE INDEX idx_events_timestamp ON shipment_events(timestamp DESC);
```

#### Tabla: `shipment_connections`

```sql
CREATE TABLE shipment_connections (
  id SERIAL PRIMARY KEY,
  parent_shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  connection_shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(parent_shipment_id, connection_shipment_id)
);

CREATE INDEX idx_connections_parent ON shipment_connections(parent_shipment_id);
CREATE INDEX idx_connections_child ON shipment_connections(connection_shipment_id);
```

### Mapeo de Campos

| Campo Frontend | Campo DB | Tipo | Notas |
|----------------|----------|------|-------|
| `awb` | `awb` | VARCHAR(20) | Formato XXX-XXXXXXXX |
| `airline` | `airline` | VARCHAR(100) | |
| `iata_code` | `iata_code` | VARCHAR(3) | Nullable |
| `origin` | `origin` | VARCHAR(3) | Código IATA |
| `destination` | `destination` | VARCHAR(3) | Código IATA |
| `pieces` | `pieces` | INTEGER | Nullable |
| `weight` | `weight` | DECIMAL | En kg |
| `events[0].status_code` | `status` | VARCHAR(10) | Estado actual |
| `tracked_at` | `tracked_at` | TIMESTAMPTZ | |
| `source` | `source` | VARCHAR(50) | |

### Queries de Ejemplo

#### Obtener Shipment con Eventos

```sql
SELECT
  s.*,
  json_agg(
    json_build_object(
      'timestamp', e.timestamp,
      'status_code', e.status_code,
      'description', e.description,
      'location', e.location,
      'flight', e.flight,
      'pieces', e.pieces
    ) ORDER BY e.timestamp DESC
  ) as events
FROM shipments s
LEFT JOIN shipment_events e ON s.id = e.shipment_id
WHERE s.awb = '172-36999149'
GROUP BY s.id;
```

#### Obtener Shipment con Conexiones

```sql
SELECT
  s.*,
  cs.awb as connection_awb,
  ps.awb as parent_awb
FROM shipments s
LEFT JOIN shipment_connections sc_child ON s.id = sc_child.connection_shipment_id
LEFT JOIN shipments ps ON sc_child.parent_shipment_id = ps.id
LEFT JOIN shipment_connections sc_parent ON s.id = sc_parent.parent_shipment_id
LEFT JOIN shipments cs ON sc_parent.connection_shipment_id = cs.id
WHERE s.awb = '172-36999149';
```

#### Estadísticas por Estado

```sql
SELECT
  status,
  COUNT(*) as count,
  SUM(pieces) as total_pieces,
  SUM(weight) as total_weight
FROM shipments
GROUP BY status;
```

---

## Variables de Entorno

### Frontend (front-vite/.env)

```env
VITE_API_URL=           # URL base de la API (vacío para usar proxy de Vite)
VITE_TURNSTILE_SITE_KEY= # Cloudflare Turnstile (opcional)
```

### Backend (.env)

```env
NEXT_PUBLIC_TURNSTILE_SITE_KEY=  # Turnstile site key
TURNSTILE_SECRET_KEY=            # Turnstile secret
NEXT_PUBLIC_API_URL=http://localhost:8000  # URL del API
RESEND_API_KEY=                  # API de Resend para emails
NOTIFY_FROM=tracking@domain.com  # Email origen
NOTIFY_TO=alerts@domain.com      # Email destino
```

---

## Stack Tecnológico

| Capa | Tecnología |
|------|------------|
| Frontend | React 19 + TypeScript + Vite |
| Estilos | Tailwind CSS + CSS Variables |
| Mapas | react-leaflet + Leaflet |
| Estado | React Hooks |
| Persistencia | localStorage |
| Backend | Python + FastAPI |
| Contenedor | Docker multi-stage |

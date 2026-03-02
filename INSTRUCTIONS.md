# KoudrsTracking — Product Build Instructions

## Qué es esto

Sistema de tracking de carga aérea (AWB - Air Waybill). Recibe un número AWB formato `XXX-XXXXXXXX` (3 dígitos prefijo + 8 dígitos serial), identifica la aerolínea, consulta su API/portal, y devuelve el estado del envío.

## Stack

- **Backend**: Python (FastAPI), expone REST API
- **Frontend**: Next.js (React)
- **Base de datos**: SQLite (inicialmente) → PostgreSQL cuando escale
- **Server**: Ubuntu 24.04, IP 192.168.88.99, usuario `koudrs`

## Estructura del proyecto

```
~/koudrs-tracking/
├── api/                    # FastAPI backend
│   ├── main.py             # Entry point, rutas
│   ├── carriers/           # Un módulo por aerolínea/método
│   │   ├── __init__.py
│   │   ├── base.py         # Clase base CarrierTracker
│   │   ├── amerijet.py     # 810 — GET directo
│   │   ├── turkish.py      # 235 — POST directo
│   │   ├── atlas.py        # 369 — GET directo
│   │   ├── china_cargo.py  # 112 — GET + captcha OCR
│   │   ├── smartkargo.py   # 865, 044 — HTML parsing
│   │   ├── dhl.py          # 155, 423, 936 — GET con API key
│   │   └── fallback.py     # Aerolíneas sin API → link directo
│   ├── models.py           # Pydantic models
│   ├── database.py         # SQLite/cache de resultados
│   └── config.py           # Keys, settings
├── web/                    # Next.js frontend
│   ├── app/
│   │   ├── page.tsx        # Home — input AWB, resultado
│   │   ├── layout.tsx
│   │   └── api/            # Si se necesita BFF
│   ├── components/
│   │   ├── TrackingForm.tsx
│   │   ├── TrackingResult.tsx
│   │   ├── StatusTimeline.tsx
│   │   └── AirlineInfo.tsx
│   └── lib/
│       └── api.ts          # Cliente al backend Python
├── data/
│   └── airlines.json       # Base de datos de aerolíneas (copiar de workspace-tracking)
└── README.md
```

## APIs Confirmadas Funcionando

### 1. Amerijet (prefijo 810) — GET sin auth
```
GET https://amerijetprod.wpenginepowered.com/api/index.php/tracking/getTrackingInfo?awbNo={awb11}
```
- `{awb11}` = 11 dígitos sin guión (ej: `81050671456`)
- Respuesta: array JSON, cada elemento tiene: TMEVENTSTATUSCODE, TMEVENTDESC, TMORIGIN, TMDESTINATION, TMFLIGHTNUMBER, TMNUMBEROFPIECES, TMEVENTDATE

### 2. Turkish Cargo (prefijo 235) — POST sin auth
```
POST https://www.turkishcargo.com/api/proxy/onlineServices/shipmentTracking
Content-Type: application/json
Body: {"trackingFilters":[{"shipmentPrefix":"{prefix}","masterDocumentNumber":"{awb8}"}]}
```
- Respuesta: JSON → result.shipmentTrackings[0] con origin, destination, pieces, weight, actualStatus, trackingDiagramDetails (eventos)

### 3. Atlas Air (prefijo 369) — GET sin auth
```
GET https://jumpseat.atlasair.com/tracktraceapi/api/FreightContProvdr/GetFrieghtDtlByAwbNo?prfx={prefix}&serial={awb8}
```
- Respuesta: JSON → LstFrieghtDtlEnhanced, array de eventos con Origin, Destination, Carrier, FlightNo, Status, Pieces, Weight

### 4. China Cargo Airlines (prefijo 112) — GET con captcha OCR
```
1. GET https://www.ckair.com/api/verifyCode → imagen captcha (6 dígitos) + cookie JSESSIONID
2. OCR la imagen con tesseract (--psm 7, whitelist 0123456789)
3. GET https://www.ckair.com/awb/queryInfo?no={awb11}&verifyCode={code} (con cookie del paso 1)
```
- Script existente: `~/.openclaw/workspace-tracking/scripts/track-ckair.sh`
- Respuesta: JSON → data[0] con mawbNo, pieces, weight, nodeTrailOuterInfoDTOList (eventos)
- Reintentar hasta 3 veces si OCR falla

### 5. MAS Air (prefijo 865) — HTML parsing SmartKargo
```
GET https://masair.smartkargo.com/FrmAWBTracking.aspx?AWBPrefix={prefix}&AWBNo={awb8}
```
- Respuesta: HTML server-rendered. Parsear con BeautifulSoup:
  - `lblOrigin` → origen
  - `lblDestination` → destino
  - `lblPcs` → piezas
  - `FlightNo1` → vuelo + fecha
  - Filas de eventos en tabla

### 6. Aerolíneas Argentinas (prefijo 044) — HTML parsing SmartKargo
```
GET https://aerolineas.smartkargo.com/FrmAWBTracking.aspx?AWBPrefix={prefix}&AWBNo={awb8}
```
- Mismo parsing que MAS Air

### 7. DHL (prefijos 155, 423, 936) — GET con API key
```
GET https://api-eu.dhl.com/track/shipments?trackingNumber={awb11}
Header: DHL-API-Key: IRwIGOBIOyj8VAccwUwho5Gu5IS77B7u
```
- PENDIENTE: API key en estado "Pending" por DHL. Cuando se apruebe, funciona.
- Free tier: 250 requests/día

### 8. KLM / Air France (prefijos 074, 057) — Solo link directo
```
https://www.afklcargo.com/mycargo/shipment/detail/{prefix}-{awb8}
```
- Cloudflare bloquea server-side. Solo dar link al usuario.

## Modelo de datos unificado

Todas las APIs devuelven datos diferentes. El backend debe normalizar a un modelo único:

```python
class TrackingEvent:
    timestamp: datetime
    status_code: str      # BKD, RCS, DEP, ARR, RCF, NFD, DLV, DDL
    description: str
    location: str         # código IATA aeropuerto
    flight: str | None
    pieces: int | None

class TrackingResult:
    awb: str              # "XXX-XXXXXXXX"
    airline: str          # nombre
    iata_code: str        # 2 letras
    origin: str           # código IATA
    destination: str      # código IATA
    pieces: int
    weight: float | None
    status: str           # último status
    events: list[TrackingEvent]
    tracked_at: datetime
    source: str           # "api", "html", "link"
```

## Códigos de status estándar IATA

| Código | Nombre | Descripción |
|--------|--------|-------------|
| BKD | Booked | Reserva confirmada |
| RCS | Received | Carga recibida por aerolínea |
| MAN | Manifested | En manifiesto de vuelo |
| DEP | Departed | Vuelo despegó |
| ARR | Arrived | Vuelo aterrizó |
| RCF | Received at Dest | En almacén destino |
| NFD | Ready for Pickup | Listo para retiro |
| DLV | Delivered | Entregado |
| DDL | Delayed | Retrasado |

## Fases de desarrollo

### Fase 1 — API Backend (mínimo viable)
1. FastAPI con endpoint `GET /track/{awb}` que retorna TrackingResult
2. Implementar carriers: amerijet, turkish, atlas (los 3 JSON directos)
3. Carrier base class con método `track(prefix, serial) → TrackingResult`
4. Router que mapea prefijo → carrier
5. Probar con los AWBs de prueba

### Fase 2 — Más carriers + cache
1. Agregar china_cargo (captcha OCR con pytesseract)
2. Agregar smartkargo (HTML parsing con BeautifulSoup)
3. Agregar DHL (cuando API key se apruebe)
4. SQLite cache: guardar resultados por AWB, TTL 30 min
5. Fallback carrier: devolver link directo para aerolíneas sin API

### Fase 3 — Frontend Next.js
1. Página simple: input AWB → botón Track → resultado
2. Timeline visual de eventos
3. Info de aerolínea (nombre, logo)
4. Responsive mobile-first

### Fase 4 — Producción
1. Systemd service para el API
2. Nginx reverse proxy
3. Rate limiting
4. Logs y monitoreo
5. Dominio propio

### Fase 5 — Crecimiento
1. Investigar más aerolíneas (DevTools en browser para encontrar APIs)
2. Tracking múltiple (varios AWB a la vez)
3. Notificaciones (Telegram) cuando cambie el status
4. Historial de trackings por usuario
5. Dashboard con estadísticas

## AWBs de prueba

| AWB | Aerolínea | Ruta | Estado |
|-----|-----------|------|--------|
| 810-50671456 | Amerijet | MIA→PTY | Delivered |
| 235-95115705 | Turkish | URC→PTY | Delivered |
| 369-98470363 | Atlas Air | PVG→MIA | En tránsito |
| 112-02979760 | China Cargo | PVG→PTY | En tránsito |
| 865-14710113 | MAS Air | WUX→PTY | En tránsito |

## Dependencias Python

```
fastapi
uvicorn
httpx
beautifulsoup4
pytesseract
Pillow
pydantic
```

## Dependencias sistema

```
tesseract-ocr  (para OCR del captcha de China Cargo)
```

## Secrets (.env)

```
DHL_API_KEY=IRwIGOBIOyj8VAccwUwho5Gu5IS77B7u
```

## Notas importantes

- Las APIs pueden cambiar sin aviso. Si una falla, hay que investigar.
- SmartKargo (MAS Air, Aerolíneas Arg) es HTML parsing frágil — puede romperse si cambian el frontend.
- China Cargo captcha: OCR acierta ~80% de las veces, por eso hay 3 reintentos.
- KLM/Air France: Cloudflare bloquea, solo dar link.
- Cada carrier tiene formato de respuesta diferente → normalizar SIEMPRE al modelo unificado.
- No hardcodear URLs en el frontend. Todo via el API backend.
